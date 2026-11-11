"""US Gulf of America (Gulf of Mexico) OCS — BOEM / BSEE Data Center bulk files.

Shell entities are matched by BOEM company number:
  00689 Shell Offshore Inc.        02117 Shell Gulf of Mexico Inc.
  02289 Shell Pipeline Company LP  02621 Shell GOM Pipeline Company LLC

Files used (all public, US-government works):
  Platform/Files/platlocfixed.zip   structure locations (lon/lat NAD27 -> treated as WGS84, <50 m error offshore)
  Platform/Files/platmastfixed.zip  complex master: operator, water depth, field code
  Platform/Files/platstrufixed.zip  structures currently in place (removed ones live in a separate file)
  Production/Files/ogora{YYYY}delimit.zip  monthly production by completion
  Pipeline/Files/pplmastdelimit.zip + localldelimit.zip  pipeline segments + vertices
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import logging
import re
from collections import defaultdict

from ..geo import simplify_line
from ..model import Series, SourceResult, feature, point, title_case
from ..net import NotAvailable, fetch, zip_text

log = logging.getLogger(__name__)

BASE = "https://www.data.boem.gov"
SHELL_OPERATORS = {"00689", "02117"}
SHELL_PIPELINE_OPERATORS = SHELL_OPERATORS | {"02289", "02621"}
FIRST_YEAR = 2015

AREA_NAMES = {
    "AC": "Alaminos Canyon", "GC": "Green Canyon", "MC": "Mississippi Canyon", "WR": "Walker Ridge",
    "KC": "Keathley Canyon", "DC": "De Soto Canyon", "VK": "Viosca Knoll", "EW": "Ewing Bank",
    "GB": "Garden Banks", "EB": "East Breaks", "SS": "Ship Shoal", "ST": "South Timbalier",
    "EI": "Eugene Island", "WC": "West Cameron", "VR": "Vermilion", "SM": "South Marsh Island",
    "MP": "Main Pass", "GI": "Grand Isle", "WD": "West Delta", "BS": "Breton Sound",
    "PL": "South Pass", "SP": "South Pass", "HI": "High Island", "GA": "Galveston", "MU": "Mustang Island",
    "PN": "North Padre", "MI": "Matagorda Island", "BA": "Brazos", "EC": "East Cameron", "LL": "Lloyd Ridge",
}

STRUCTURE_TYPES = {
    "TLP": "Tension-leg platform", "MTLP": "Mini tension-leg platform", "SPAR": "Spar", "SEMI": "Semi-submersible",
    "FIXED": "Fixed platform", "CAIS": "Caisson", "WP": "Well protector", "FPSO": "FPSO", "CT": "Compliant tower",
    "MOPU": "Mobile production unit", "SSTMP": "Subsea template", "SSMNF": "Subsea manifold", "UMBRL": "Umbrella",
}

# Hubs whose production is reported under a neighbouring block's field code (the platform
# sits on one block, the reservoir is booked against another). Verified against OGOR-A volumes.
HUB_FIELD_OVERRIDES = {
    "Whale": "AC772",
    "Appomattox": "MC392",
    "Vito": "MC940",
}

_DATE_RE = re.compile(r"\d\d-[A-Z]{3}-\d{4}[YNW ]{5}\s*(\d+)")
_FIELD_RE = re.compile(r"^(?:[A-Z]{2}\d{2,4}[A-Z]?|WILD)$")


def _platform_name(raw: str, area: str, block: str) -> tuple[str, str | None]:
    """'A (Mars)' -> ('Mars A', 'Mars'); 'SSMANIFO' -> ('MC 807 SSMANIFO', None)."""
    m = re.match(r"^(\S+)\s+\((.+)\)$", raw.strip())
    if m:
        return f"{m.group(2)} {m.group(1)}", m.group(2)
    return f"{area} {block} {raw.strip()}".strip(), None


def _parse_platloc(text: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for line in text.splitlines():
        m = re.match(r"^\s*\d+\s+(\d+)\s+\d([A-Z]{2})\s+(\S+)\s+(.*)$", line)
        if not m:
            continue
        complex_id, area, block, rest = m.groups()
        toks = rest.split()
        try:
            lon, lat = float(toks[-2]), float(toks[-1])
        except (ValueError, IndexError):
            continue
        name = re.split(r"\s{2,}", rest.strip())[0]
        out.setdefault(complex_id, {"area": area, "block": block, "raw": name, "lon": lon, "lat": lat, "structures": 0})
        out[complex_id]["structures"] += 1
    return out


def _parse_platmast(text: str) -> dict[str, dict]:
    out = {}
    for line in text.splitlines():
        if len(line) < 30:
            continue
        cid = line[0:8].strip()
        op = line[20:25]
        depth = None
        m = _DATE_RE.search(line)
        if m:
            depth = int(m.group(1))
        field_code = None
        for tok in line[50:].split():
            if _FIELD_RE.match(tok):
                field_code = tok
                break
        out[cid] = {"operator": op, "water_depth_ft": depth, "field": field_code}
    return out


def _parse_platstru(text: str) -> dict[str, dict]:
    out = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Z]{2})\s*(\S+)\s+(\d+)\s", line)
        if not m:
            continue
        cid = m.group(3)
        t = re.search(r"\s\d([A-Z]{2,8})\s+\d+\s+\d+", line)
        inst = re.search(r"[EW ](\d\d-[A-Z]{3}-\d{4})", line)
        rec = out.setdefault(cid, {"types": set(), "installed": None})
        if t:
            rec["types"].add(t.group(1))
        if inst:
            try:
                d = dt.datetime.strptime(inst.group(1), "%d-%b-%Y").date()
                if rec["installed"] is None or d < rec["installed"]:
                    rec["installed"] = d
            except ValueError:
                pass
    return out


def production_zip(year: int, *, today: dt.date | None = None) -> bytes | None:
    """The BOEM OGOR-A file for one year. Only the current year may be missing (it is published
    part-way through the year); a missing past year would silently zero 12 months of production,
    so it fails the source instead and the build keeps the last good snapshot."""
    today = today or dt.date.today()
    try:
        return fetch(f"{BASE}/Production/Files/ogora{year}delimit.zip", expect="zip")
    except NotAvailable:
        if year >= today.year:
            log.info("no BOEM production file for %s yet", year)
            return None
        raise


def _production(result: SourceResult) -> dict[str, Series]:
    series: dict[str, Series] = {}
    this_year = dt.date.today().year
    for year in range(FIRST_YEAR, this_year + 1):
        blob = production_zip(year)
        if blob is None:
            continue
        n = 0
        for r in csv.reader(io.StringIO(zip_text(blob))):
            if len(r) < 14 or r[11].strip() not in SHELL_OPERATORS:
                continue
            ym = f"{r[2][:4]}-{r[2][4:6]}"
            days = dt.date(int(ym[:4]), int(ym[5:]), 1)
            ndays = ((days.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - days).days
            oil = int(r[5] or 0) / 1000 / ndays  # bbl/month -> kbbl/d
            gas = int(r[6] or 0) / 1000 / ndays  # mcf/month -> MMscf/d
            code = r[13].strip() or r[10].replace(" ", "")
            s = series.setdefault(code, Series(id=f"gom:{code}", name=code, region="gom", stake="operated"))
            s.add(ym, oil, gas)
            n += 1
        log.info("BOEM %s: %d Shell-operated completion-months", year, n)
    return series


def _pipelines(result: SourceResult) -> None:
    master = csv.reader(io.StringIO(zip_text(fetch(f"{BASE}/Pipeline/Files/pplmastdelimit.zip", expect="zip"))))
    segs: dict[str, dict] = {}
    for r in master:
        if len(r) < 33 or r[32].strip() not in SHELL_PIPELINE_OPERATORS:
            continue
        if r[23].strip() not in {"ACT", "OUT"}:  # active or temporarily out of service
            continue
        segs[r[0].strip()] = {
            "status": "Active" if r[23].strip() == "ACT" else "Out of service",
            "product": r[29].strip(),
            "size_in": r[24].strip().lstrip("0") or None,
            "from": f"{r[3]} {r[4].strip()}",
            "to": f"{r[7]} {r[8].strip()}",
        }
    verts: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for r in csv.reader(io.StringIO(zip_text(fetch(f"{BASE}/Pipeline/Files/localldelimit.zip", expect="zip")))):
        sid = r[0].strip()
        if sid in segs:
            verts[sid].append((int(r[1]), float(r[3]), float(r[2])))
    for sid, pts in verts.items():
        pts.sort()
        coords = simplify_line([(lon, lat) for _, lon, lat in pts], tol=0.0005)
        if len(coords) < 2:
            continue
        meta = segs[sid]
        result.lines.append(
            feature(
                {"type": "LineString", "coordinates": coords},
                id=f"gom-ppl-{sid}",
                name=f"Segment {sid}",
                region="gom",
                stake="operated",
                product=meta["product"],
                status=meta["status"],
                size_in=meta["size_in"],
                route=f"{meta['from']} → {meta['to']}",
                source="boem",
            )
        )


def build() -> SourceResult:
    result = SourceResult(
        key="boem",
        title="BOEM / BSEE Data Center — platforms, pipelines, OGOR-A production",
        publisher="US Bureau of Ocean Energy Management",
        url="https://www.data.boem.gov/",
        license="US Government work (public domain)",
    )
    loc = _parse_platloc(zip_text(fetch(f"{BASE}/Platform/Files/platlocfixed.zip", expect="zip")))
    mast = _parse_platmast(zip_text(fetch(f"{BASE}/Platform/Files/platmastfixed.zip", expect="zip")))
    stru = _parse_platstru(zip_text(fetch(f"{BASE}/Platform/Files/platstrufixed.zip", expect="zip")))
    series = _production(result)

    field_names: dict[str, list[str]] = defaultdict(list)
    for cid, m in mast.items():
        if m["operator"] not in SHELL_OPERATORS or cid not in loc or cid not in stru:
            continue
        L = loc[cid]
        name, hub = _platform_name(L["raw"], L["area"], L["block"])
        field_code = m["field"] if m["field"] and m["field"] != "WILD" else f"{L['area']}{L['block']}"
        if hub in HUB_FIELD_OVERRIDES and field_code not in series:
            field_code = HUB_FIELD_OVERRIDES[hub]
        has_series = field_code in series
        if hub and has_series:
            field_names[field_code].append(hub)
        types = sorted(stru[cid]["types"])
        kind_code = next((t for t in types if t in {"TLP", "MTLP", "SPAR", "SEMI", "FPSO", "CT"}), types[0] if types else None)
        deepwater = (m["water_depth_ft"] or 0) >= 1000
        result.assets.append(
            feature(
                point(L["lon"], L["lat"]),
                id=f"gom-{cid}",
                name=name,
                kind="platform",
                subtype=STRUCTURE_TYPES.get(kind_code or "", title_case(kind_code)),
                region="gom",
                country="United States",
                operator="Shell Offshore Inc.",
                stake="operated",
                water_depth_m=round(m["water_depth_ft"] * 0.3048) if m["water_depth_ft"] else None,
                installed=stru[cid]["installed"].year if stru[cid]["installed"] else None,
                block=f"{AREA_NAMES.get(L['area'], L['area'])} {L['block']}",
                field=field_code,
                series=f"gom:{field_code}" if has_series else None,
                featured=bool(hub) and deepwater,
                source="boem",
                url="https://www.data.boem.gov/Platform/PlatformStructures/Default.aspx",
            )
        )
    for code, s in series.items():
        hubs = sorted(set(field_names.get(code, [])))
        area = AREA_NAMES.get(code[:2], code[:2])
        s.name = f"{' / '.join(hubs)} ({code})" if hubs else f"{area} {code[2:]} ({code})"
    result.series = list(series.values())
    _pipelines(result)
    result.notes.append(
        "Production is gross (100%) volume reported on Shell-operated completions, grouped by BOEM field code."
    )
    return result
