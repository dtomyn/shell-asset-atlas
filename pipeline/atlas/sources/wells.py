"""Wells below the Gulf hubs — BOEM borehole file and directional surveys.

Two steps, kept apart so the snapshot does not depend on any other source:

``build()``   downloads the borehole file and the directional survey points, keeps the
              deepwater boreholes of the Shell operator numbers, and turns each one into a
              short 3D path. It also keeps the water depth at every borehole near them, of
              any operator, as control points for the seabed. That is the snapshot.
``bundle()``  runs at bundle time against the Gulf hubs in the bundle. It ties boreholes to
              hubs, moves the paths into each hub's local frame and interpolates a small
              seabed grid around the hub.

Files used (all public, US-government works):
  Well/Files/5010delimit.zip      one row per borehole: operator number, bottom field code,
                                  spud date, RKB elevation, total MD, TVD, status, water depth,
                                  surface and bottom-hole longitude/latitude, and the complex id
                                  of the platform the well belongs to
  Well/Files/BoreholeRawData.zip  the same boreholes with one more column that is used here:
                                  the kick-off depth of a sidetrack or bypass
  Well/Files/dsptsdelimit.zip     directional survey points, about 5 million rows (140 MB
                                  zipped, 1.2 GB unzipped). It is streamed from the download
                                  cache and never held in memory or committed.

Layouts: https://www.data.boem.gov/Main/HtmlPage.aspx?page=borehole and ``?page=dirSurvPoints``.

Survey method. Each survey row gives measured depth, inclination and a quadrant bearing, and
also BOEM's own true vertical depth and longitude/latitude offset for that station. The path
uses BOEM's positions. The minimum-curvature method (``min_curvature``) is run on the same
stations as a check: its vertical depth agrees with BOEM's to under a metre. Its horizontal
position drifts from BOEM's by about one degree of bearing, which is what a grid-north
azimuth gives when read as true north, and BOEM's offsets land on the reported bottom-hole
location, so those are the ones drawn.

Depths in the files are in feet below the rig's kelly bushing (RKB). They are converted to
metres below sea level by subtracting the RKB elevation.

A borehole with no survey gets a three-point path: sea surface, seabed directly below, and
the reported bottom-hole location at its vertical depth. It is flagged ``sv: 0`` and the
front end labels it "schematic (surface to bottom-hole)".
"""

from __future__ import annotations

import csv
import io
import logging
import math
import statistics
import zipfile
from collections import defaultdict
from typing import Iterable, Iterator

from ..geo import metres_per_degree, simplify_3d
from ..model import SourceResult
from ..net import fetch, fetch_path, zip_text
from .gom import BASE, SHELL_OPERATORS

log = logging.getLogger(__name__)

BOREHOLE_URL = f"{BASE}/Well/Files/5010delimit.zip"
KICKOFF_URL = f"{BASE}/Well/Files/BoreholeRawData.zip"
SURVEY_URL = f"{BASE}/Well/Files/dsptsdelimit.zip"

FT = 0.3048
DEEPWATER_FT = 1000  # same line as gom.py uses for a featured hub
SIMPLIFY_M = 5.0  # no surveyed point is dropped if it is further than this from the drawn path
MAX_POINTS = 48  # per path; the tolerance is doubled until the path fits
CONTROL_CELL_DEG = 0.25  # seabed control points are kept in the cells around Shell boreholes
CONTROL_ROUND = 3  # control points closer than ~100 m are merged

MIN_RADIUS_M = 4000.0  # half-width of the scene around a hub
MAX_RADIUS_M = 30000.0  # a well reaching further than this from the hub is left out
GRID_N = 33  # seabed grid is GRID_N x GRID_N
IDW_NEAREST = 12
IDW_POWER = 2.0

STATUS = {
    "COM": "Completed",
    "PA": "Permanently abandoned",
    "TA": "Temporarily abandoned",
    "ST": "Sidetracked",
    "DRL": "Drilling",
    "DSI": "Drilling suspended",
    "AST": "Approved sidetrack",
    "APD": "Permit to drill",
    "CNL": "Cancelled",
}
TYPES = {"E": "Exploratory", "D": "Development"}


# --- parsing ----------------------------------------------------------------------------
def _num(s: str) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _date(s: str) -> str | None:
    s = s.strip()
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 and s.isdigit() else None


def parse_boreholes(text: str) -> list[dict]:
    """Rows of ``5010delimit``. Depths stay in feet here, as filed."""
    out = []
    for r in csv.reader(io.StringIO(text)):
        if len(r) < 26:
            continue
        r = [c.strip() for c in r]
        out.append(
            {
                "api": r[0],
                "name": " ".join(x for x in (r[1], r[2]) if x),
                "suffix": r[2],
                "op": r[3],
                "field": r[4],
                "spud": _date(r[5]),
                "rkb_ft": _num(r[7]),
                "md_ft": _num(r[8]),
                "tvd_ft": _num(r[9]),
                "type": r[16],
                "status": r[18],
                "wd_ft": _num(r[19]),
                "lon": _num(r[20]),
                "lat": _num(r[21]),
                "blon": _num(r[22]),
                "blat": _num(r[23]),
                "complex": r[25],
            }
        )
    return out


def parse_kickoffs(text: str) -> dict[str, float]:
    """API number -> kick-off measured depth (ft) of a sidetrack or bypass, from ``BoreholeRawData``."""
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        v = _num((r.get("WELL_BP_ST_KICKOFF_MD") or "").strip())
        if v:
            out[(r.get("API_WELL_NUMBER") or "").strip()] = v
    return out


def azimuth(ns: str, deg: float, minutes: float, ew: str) -> float:
    """Quadrant bearing ('S', 57, 8, 'W' = S 57°08' W) as an azimuth in degrees clockwise from north."""
    a = deg + minutes / 60.0
    if ns.upper() == "S":
        return 180.0 - a if ew.upper() == "E" else 180.0 + a
    return a if ew.upper() == "E" else (360.0 - a) % 360.0


def iter_survey(lines: Iterable[str], wanted: set[str]) -> Iterator[tuple[str, tuple[float, float, float, float, float, float]]]:
    """Survey stations of the wanted boreholes from ``dsptsdelimit`` lines, as
    ``(api, (md ft, inclination deg, azimuth deg, tvd ft, delta lon deg, delta lat deg))``.

    The file has no header. Columns: API, inclination degrees, inclination minutes, measured
    depth, N/S, bearing degrees, bearing minutes, E/W, true vertical depth, delta longitude
    from surface, delta latitude from surface, longitude, latitude. Lines of other boreholes
    are skipped on the API prefix alone, without parsing them.
    """
    for line in lines:
        if line[1:13] not in wanted:
            continue
        r = [c.strip() for c in next(csv.reader([line]))]
        if len(r) < 11:
            continue
        try:
            yield r[0], (
                float(r[3]),
                float(r[1] or 0) + float(r[2] or 0) / 60.0,
                azimuth(r[4], float(r[5] or 0), float(r[6] or 0), r[7]),
                float(r[8]),
                float(r[9] or 0),
                float(r[10] or 0),
            )
        except ValueError:
            continue


# --- survey maths -----------------------------------------------------------------------
def min_curvature(stations: list[tuple[float, float, float]]) -> list[tuple[float, float, float]]:
    """Minimum-curvature positions for ``(measured depth, inclination deg, azimuth deg)``
    stations, as ``(east, north, vertical depth)`` relative to the first station, in the
    units of measured depth. Each pair of stations is joined by a circular arc."""
    e = n = v = 0.0
    out = [(0.0, 0.0, 0.0)]
    for (md1, inc1, az1), (md2, inc2, az2) in zip(stations, stations[1:]):
        i1, i2, a1, a2 = (math.radians(x) for x in (inc1, inc2, az1, az2))
        cos_dl = math.cos(i2 - i1) - math.sin(i1) * math.sin(i2) * (1.0 - math.cos(a2 - a1))
        dl = math.acos(max(-1.0, min(1.0, cos_dl)))  # dog-leg angle
        rf = 1.0 if dl < 1e-7 else 2.0 / dl * math.tan(dl / 2.0)  # ratio factor
        half = (md2 - md1) / 2.0 * rf
        n += half * (math.sin(i1) * math.cos(a1) + math.sin(i2) * math.cos(a2))
        e += half * (math.sin(i1) * math.sin(a1) + math.sin(i2) * math.sin(a2))
        v += half * (math.cos(i1) + math.cos(i2))
        out.append((e, n, v))
    return out


def clean_stations(stations: list[tuple]) -> list[tuple]:
    """Sort by measured depth and drop repeats of the same depth."""
    out: list[tuple] = []
    for s in sorted(stations):
        if not out or s[0] > out[-1][0]:
            out.append(s)
    return out


def surveyed_path(stations: list[tuple], lat: float, rkb_ft: float) -> list[tuple[float, float, float]]:
    """``(east m, north m, depth below sea level m)`` from BOEM's station positions, starting
    at the sea surface above the well. If the filed survey starts below the surface (a
    sidetrack whose survey begins at its tie-in), the part above its first station is straight."""
    mx, my = metres_per_degree(lat)
    pts = [(0.0, 0.0, 0.0)]
    for _md, _inc, _az, tvd, dlon, dlat in stations:
        p = (dlon * mx, dlat * my, max(0.0, (tvd - rkb_ft) * FT))
        if p != pts[-1]:
            pts.append(p)
    return pts


def schematic_path(b: dict) -> list[tuple[float, float, float]] | None:
    """Sea surface, seabed directly below, reported bottom-hole location at its vertical depth."""
    if None in (b["blon"], b["blat"], b["lon"], b["lat"], b["tvd_ft"], b["wd_ft"]):
        return None
    mx, my = metres_per_degree(b["lat"])
    bottom = ((b["blon"] - b["lon"]) * mx, (b["blat"] - b["lat"]) * my, (b["tvd_ft"] - (b["rkb_ft"] or 0)) * FT)
    seabed = (0.0, 0.0, b["wd_ft"] * FT)
    return [(0.0, 0.0, 0.0), seabed, bottom] if bottom[2] > seabed[2] else None


def drilled_ft(b: dict, kickoff_ft: float | None) -> float | None:
    """New hole made by this borehole. A sidetrack or bypass counts from its kick-off depth,
    an original hole from the seabed (measured depth starts at the rig floor, above the sea).
    ``None`` when a sidetrack has no kick-off depth on file, so the shared hole is not counted twice."""
    if not b["md_ft"]:
        return None
    if kickoff_ft:
        return max(0.0, b["md_ft"] - kickoff_ft)
    if b["suffix"] in ("", "ST00BP00"):
        return max(0.0, b["md_ft"] - (b["wd_ft"] or 0) - (b["rkb_ft"] or 0))
    return None


def select(bores: list[dict]) -> list[dict]:
    """Drilled deepwater boreholes of the Shell operator numbers, with a surface location."""
    return [
        b
        for b in bores
        if b["op"] in SHELL_OPERATORS and (b["wd_ft"] or 0) >= DEEPWATER_FT and b["md_ft"] and b["lon"] is not None and b["lat"] is not None
    ]


def well_record(b: dict, stations: list[tuple] | None, kickoff_ft: float | None) -> dict | None:
    """One borehole as it is stored in the snapshot: metres, path relative to its own surface location."""
    stations = clean_stations(stations or [])
    surveyed = len(stations) >= 2
    pts = surveyed_path(stations, b["lat"], b["rkb_ft"] or 0) if surveyed else schematic_path(b)
    if not pts or len(pts) < 2:
        return None
    pts = simplify_3d(pts, SIMPLIFY_M, MAX_POINTS)
    drilled = drilled_ft(b, kickoff_ft)
    return {
        "api": b["api"],
        "name": b["name"],
        "field": b["field"],
        "complex": b["complex"],
        "status": b["status"],
        "type": b["type"],
        "spud": b["spud"],
        "lon": round(b["lon"], 6),
        "lat": round(b["lat"], 6),
        "wd": round(b["wd_ft"] * FT),
        "md": round(b["md_ft"] * FT),
        "tvd": round(max(p[2] for p in pts)),
        "drilled": None if drilled is None else round(drilled * FT),
        "sv": int(surveyed),
        "path": [round(c) for p in pts for c in p],
    }


def control_points(bores: list[dict], wells: list[dict]) -> list[list[float]]:
    """Water depth at borehole sites of any operator near the kept wells: ``[lon, lat, metres]``."""
    cells = set()
    for w in wells:
        cx, cy = math.floor(w["lon"] / CONTROL_CELL_DEG), math.floor(w["lat"] / CONTROL_CELL_DEG)
        cells |= {(cx + i, cy + j) for i in (-1, 0, 1) for j in (-1, 0, 1)}
    seen: dict[tuple[float, float], list[float]] = {}
    for b in bores:
        if b["lon"] is None or b["lat"] is None or not b["wd_ft"]:
            continue
        if (math.floor(b["lon"] / CONTROL_CELL_DEG), math.floor(b["lat"] / CONTROL_CELL_DEG)) not in cells:
            continue
        seen.setdefault((round(b["lon"], CONTROL_ROUND), round(b["lat"], CONTROL_ROUND)), []).append(b["wd_ft"] * FT)
    return [[lon, lat, round(statistics.median(v))] for (lon, lat), v in sorted(seen.items())]


def build() -> SourceResult:
    result = SourceResult(
        key="wells",
        title="BOEM / BSEE Data Center — boreholes and directional surveys (Shell-operated, deepwater)",
        publisher="US Bureau of Ocean Energy Management",
        url="https://www.data.boem.gov/Main/Well.aspx",
        license="US Government work (public domain)",
    )
    bores = parse_boreholes(zip_text(fetch(BOREHOLE_URL, expect="zip")))
    if not bores:
        raise RuntimeError("the BOEM borehole file parsed to zero rows; the layout may have changed")
    kickoffs = parse_kickoffs(zip_text(fetch(KICKOFF_URL, expect="zip")))
    kept = select(bores)
    wanted = {b["api"] for b in kept}

    stations: dict[str, list[tuple]] = defaultdict(list)
    rows = 0
    with zipfile.ZipFile(fetch_path(SURVEY_URL, expect="zip")) as z:
        name = max(z.namelist(), key=lambda n: z.getinfo(n).file_size)
        with z.open(name) as f:
            for api, st in iter_survey(io.TextIOWrapper(f, encoding="latin-1"), wanted):
                stations[api].append(st)
                rows += 1
    if not stations:
        raise RuntimeError("no directional survey rows matched the Shell boreholes; the layout may have changed")

    wells = []
    tvd_diff = []
    for b in kept:
        st = clean_stations(stations.get(b["api"], []))
        w = well_record(b, st, kickoffs.get(b["api"]))
        if not w:
            continue
        wells.append(w)
        if len(st) >= 2:  # check BOEM's vertical depths against minimum curvature on the same stations
            mc = min_curvature([s[:3] for s in st])
            tvd_diff.append(abs(st[0][3] + mc[-1][2] - st[-1][3]) * FT)
    surveyed = sum(w["sv"] for w in wells)
    check = round(max(tvd_diff), 2) if tvd_diff else None
    log.info("BOEM wells: %d Shell deepwater boreholes, %d with a directional survey (%d stations)", len(wells), surveyed, rows)
    result.extra = {
        "wells": wells,
        "depths": control_points(bores, wells),
        "check": {"surveys": len(tvd_diff), "tvd_max_diff_m": check},
    }
    result.notes.append(
        f"Well paths are BOEM directional surveys ({surveyed} of {len(wells)} Shell-operated deepwater boreholes), "
        f"simplified so that no surveyed point is more than about {SIMPLIFY_M:.0f} m from the drawn path. Depths are "
        "below sea level (kelly bushing elevation subtracted). Boreholes without a survey are drawn as a straight "
        "schematic from the seabed to the reported bottom-hole location and are labelled as such. The seabed in the "
        "subsea view is interpolated from the water depths recorded at borehole sites, not a bathymetric survey."
    )
    return result


# --- bundle -----------------------------------------------------------------------------
def idw(points: list[tuple[float, float, float]], x: float, y: float, soften: float) -> float:
    """Inverse-distance-weighted depth at (x, y) from the nearest control points.
    ``soften`` (metres) keeps one site from making a spike in the surface."""
    near = sorted(((px - x) ** 2 + (py - y) ** 2, pz) for px, py, pz in points)[:IDW_NEAREST]
    wsum = zsum = 0.0
    for d2, pz in near:
        w = 1.0 / (d2 + soften * soften) ** (IDW_POWER / 2.0)
        wsum += w
        zsum += w * pz
    return zsum / wsum


def seabed_grid(points: list[tuple[float, float, float]], radius: float, n: int = GRID_N) -> list[int]:
    """Depths (m) on an n x n grid over [-radius, radius], row by row from the south-west corner."""
    step = 2.0 * radius / (n - 1)
    return [round(idw(points, -radius + i * step, -radius + j * step, step)) for j in range(n) for i in range(n)]


def assign(wells: list[dict], hubs: list[dict]) -> dict[str, list[tuple[dict, str]]]:
    """Tie boreholes to hubs. A hub is ``{id, complex, field, lon, lat}``.

    1. *host*: BOEM's borehole file names the hub's platform complex as the well's complex.
    2. *field*: the borehole has no complex on file (typically an exploration or appraisal
       well that was never tied back) and its bottom-hole field code is the hub's field code.
       If two hubs share the code, the well goes to the nearer one.
    """
    by_complex = {h["complex"]: h for h in hubs}
    by_field: dict[str, list[dict]] = defaultdict(list)
    for h in hubs:
        if h.get("field"):
            by_field[h["field"]].append(h)
    out: dict[str, list[tuple[dict, str]]] = {h["id"]: [] for h in hubs}
    for w in wells:
        if w["complex"] in by_complex:
            out[by_complex[w["complex"]]["id"]].append((w, "host"))
        elif not w["complex"] and w["field"] in by_field:
            def dist(h: dict) -> float:
                mx, my = metres_per_degree(h["lat"])
                return math.hypot((w["lon"] - h["lon"]) * mx, (w["lat"] - h["lat"]) * my)

            out[min(by_field[w["field"]], key=dist)["id"]].append((w, "field"))
    return out


def bundle(extra: dict, assets: list[dict]) -> tuple[dict, dict]:
    """``(wells.json, summary)``. The summary is small and goes in the manifest, so the app
    knows which hubs can be dived without loading the paths."""
    wells = extra.get("wells") or []
    depths = extra.get("depths") or []
    hubs = []
    for f in assets:
        p = f["properties"]
        if p.get("region") == "gom" and p.get("featured") and p.get("water_depth_m") and str(p.get("id", "")).startswith("gom-"):
            lon, lat = f["geometry"]["coordinates"]
            hubs.append({"id": p["id"], "complex": p["id"][4:], "field": p.get("field"), "lon": lon, "lat": lat, "name": p["name"], "wd": p["water_depth_m"]})
    out_hubs: dict[str, dict] = {}
    summary: dict[str, dict] = {}
    for hub_id, tied in assign(wells, hubs).items():
        hub = next(h for h in hubs if h["id"] == hub_id)
        mx, my = metres_per_degree(hub["lat"])
        local = []
        too_far = 0
        for w, how in tied:
            ox, oy = (w["lon"] - hub["lon"]) * mx, (w["lat"] - hub["lat"]) * my
            path = w["path"]
            pts = [(path[i] + ox, path[i + 1] + oy, path[i + 2]) for i in range(0, len(path), 3)]
            reach = max(max(abs(x), abs(y)) for x, y, _ in pts)
            if reach > MAX_RADIUS_M:
                too_far += 1
                continue
            local.append((w, how, pts, reach))
        if not local:
            continue
        radius = min(MAX_RADIUS_M, max(MIN_RADIUS_M, 1.15 * max(r for *_, r in local)))
        radius = math.ceil(radius / 500.0) * 500.0
        # Seabed control: the hub's own depth, plus every borehole site in or just outside the window.
        control = [(0.0, 0.0, float(hub["wd"]))]
        for lon, lat, d in depths:
            x, y = (lon - hub["lon"]) * mx, (lat - hub["lat"]) * my
            if max(abs(x), abs(y)) <= radius * 1.5:
                control.append((x, y, float(d)))
        out_wells = []
        for w, how, pts, _ in sorted(local, key=lambda t: (t[0]["spud"] or "", t[0]["api"])):
            out_wells.append(
                {
                    "api": w["api"],
                    "name": w["name"],
                    "status": w["status"],
                    "type": w["type"],
                    "spud": w["spud"],
                    "wd": w["wd"],
                    "md": w["md"],
                    "tvd": w["tvd"],
                    "drilled": w["drilled"],
                    "sv": w["sv"],
                    "tie": how,
                    "path": [round(c) for p in pts for c in p],
                }
            )
        deepest = max(out_wells, key=lambda w: w["tvd"])
        stats = {
            "wells": len(out_wells),
            "surveyed": sum(w["sv"] for w in out_wells),
            "schematic": sum(1 - w["sv"] for w in out_wells),
            "by_field_code": sum(w["tie"] == "field" for w in out_wells),
            "beyond_window": too_far,
            "deepest_tvd_m": deepest["tvd"],
            "deepest_well": deepest["name"],
            "drilled_m": sum(w["drilled"] or 0 for w in out_wells),
            "drilled_unknown": sum(w["drilled"] is None for w in out_wells),
        }
        out_hubs[hub_id] = {
            "name": hub["name"],
            "lon": hub["lon"],
            "lat": hub["lat"],
            "water_depth_m": hub["wd"],
            "radius_m": radius,
            "seabed": {"n": GRID_N, "depth": seabed_grid(control, radius), "control_points": len(control)},
            "stats": stats,
            "wells": out_wells,
        }
        summary[hub_id] = {"wells": stats["wells"], "surveyed": stats["surveyed"], "deepest_tvd_m": stats["deepest_tvd_m"], "drilled_m": stats["drilled_m"]}
    data = {
        "units": "metres; paths are [east, north, depth below sea level] triples relative to the hub",
        "method": {
            "simplify_m": SIMPLIFY_M,
            "max_radius_m": MAX_RADIUS_M,
            "seabed": "Inverse-distance interpolation of the water depths BOEM records at borehole sites (all operators) and at the hub. Not a bathymetric survey.",
            "check": extra.get("check"),
        },
        "status": STATUS,
        "types": TYPES,
        "hubs": out_hubs,
    }
    return data, summary
