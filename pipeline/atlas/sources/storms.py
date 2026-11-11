"""Gulf storms — NOAA National Hurricane Center HURDAT2 best tracks, plus impact estimates.

Two steps, kept apart so the snapshot does not depend on any other source:

``build()``   downloads the Atlantic HURDAT2 file and keeps every named system from
              2015 onward that reached tropical-storm strength and entered the Gulf. That list
              is the snapshot.
``bundle()``  runs at bundle time against the BOEM platforms and the monthly production
              series. It keeps the storms whose centre passed within ``RADIUS_KM`` of a Shell
              structure while at tropical-storm strength or more, and estimates what each one
              deferred at each producing hub.

The impact figures are estimates from monthly data, relative to a pre-storm baseline. A dip
can have other causes (a planned turnaround, a well intervention), so nothing here is a
reported shut-in volume. See ``impact()`` and ``attribute()`` for the exact rules.

HURDAT2 format: https://www.nhc.noaa.gov/data/hurdat/hurdat2-format-atl-1851-2021.pdf
"""

from __future__ import annotations

import datetime as dt
import logging
import math
import re
import statistics

from ..model import SourceResult, days_in, kboed
from ..net import fetch

log = logging.getLogger(__name__)

INDEX_URL = "https://www.nhc.noaa.gov/data/"
# The file name carries the season and the publication date, so it changes with every
# re-issue. The index page is read first; this is only the fallback.
FALLBACK_URL = "https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2025-092326.txt"
_FILE_RE = re.compile(r'href="(/data/hurdat/hurdat2-1851-(\d{4})-\d+\.txt)"')

FIRST_YEAR = 2015  # matches the production timeline (gom.FIRST_YEAR)
MIN_KT = 34  # tropical-storm strength
GULF_BOX = (-98.5, 17.5, -80.0, 31.5)  # west, south, east, north
TROPICAL = {"TD", "TS", "HU", "SD", "SS"}

# --- impact method ----------------------------------------------------------------------
RADIUS_KM = 150.0  # a hub counts as "in the path" if the storm centre passed this close
BASELINE_MONTHS = 3  # pre-storm baseline = mean of the 3 months before the storm month
NOISE_MONTHS = 6  # month-to-month noise is measured over the 6 months before
RECOVERY = 0.9  # recovered = first later month at or above 90% of baseline
HORIZON_MONTHS = 12  # a hub still down after a year is not counted as a storm effect
MIN_BASELINE_KBOED = 1.0  # ignore hubs producing less than this before the storm
NOISE_FACTOR = 2.0  # the dip must be at least twice the pre-storm noise
NEW_LOW = 0.1  # a later month this far (x baseline) under the storm's low is a new event


# --- HURDAT2 ----------------------------------------------------------------------------
def find_hurdat_url(index_html: str) -> str | None:
    """Newest Atlantic HURDAT2 link on the NHC data page."""
    hits = _FILE_RE.findall(index_html)
    if not hits:
        return None
    return "https://www.nhc.noaa.gov" + max(hits, key=lambda h: (h[1], h[0]))[0]


def _coord(tok: str) -> float:
    v = float(tok[:-1])
    return -v if tok[-1] in "SW" else v


def parse_hurdat2(text: str, first_year: int = FIRST_YEAR) -> list[dict]:
    """Storms as ``{id, name, year, track}``; a track point is ``[minutes since the Unix
    epoch (UTC), lat, lon, max sustained wind in kt, status]``."""
    storms: list[dict] = []
    cur: dict | None = None
    for line in text.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 4:
            continue
        if re.fullmatch(r"[A-Z]{2}\d{6}", f[0]):
            year = int(f[0][4:])
            cur = {"id": f[0], "name": f[1].title(), "year": year, "track": []} if year >= first_year else None
            if cur:
                storms.append(cur)
            continue
        if cur is None or len(f) < 7:
            continue
        try:
            when = dt.datetime.strptime(f[0] + f[1], "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc)
            kt = int(f[6])
            cur["track"].append([int(when.timestamp() // 60), _coord(f[4]), _coord(f[5]), max(kt, 0), f[3]])
        except ValueError:
            continue
    return [s for s in storms if len(s["track"]) >= 2]


def peak_kt(storm: dict) -> int:
    """Highest wind while the system was tropical or subtropical."""
    return max((p[3] for p in storm["track"] if p[4] in TROPICAL), default=0)


def enters_gulf(storm: dict) -> bool:
    w, s, e, n = GULF_BOX
    return any(w <= p[2] <= e and s <= p[1] <= n for p in storm["track"])


def build() -> SourceResult:
    result = SourceResult(
        key="hurdat",
        title="NHC HURDAT2 — Atlantic hurricane best tracks (storms that entered the Gulf, 2015→)",
        publisher="NOAA National Hurricane Center",
        url="https://www.nhc.noaa.gov/data/#hurdat",
        license="US Government work (public domain)",
    )
    url = None
    try:
        url = find_hurdat_url(fetch(INDEX_URL, expect="html").decode("utf-8", "replace"))
    except Exception as exc:  # the index page is a convenience; the file itself is what matters
        log.warning("could not read the NHC data index (%s); using the last known file name", exc)
    text = fetch(url or FALLBACK_URL, expect="text/plain").decode("latin-1")
    storms = parse_hurdat2(text)
    if not storms:
        raise RuntimeError("HURDAT2 parsed to zero storms; the format may have changed")
    through = max(s["year"] for s in storms)
    kept = [s for s in storms if s["name"] != "Unnamed" and peak_kt(s) >= MIN_KT and enters_gulf(s)]
    log.info("HURDAT2: %d Atlantic systems %d-%d, %d named storms entered the Gulf", len(storms), FIRST_YEAR, through, len(kept))
    result.extra = {"storms": kept, "through": through, "file": (url or FALLBACK_URL).rsplit("/", 1)[-1]}
    result.notes.append(
        f"Storm tracks are NHC best tracks (HURDAT2) through the {through} season. Deferred volume and months to "
        f"recover are estimates from monthly regulator data, relative to the mean of the {BASELINE_MONTHS} months "
        f"before the storm, for hubs within {RADIUS_KM:.0f} km of the track; recovery means back to {RECOVERY:.0%} of "
        "that baseline. A dip can have other causes, such as a planned turnaround, so these are not reported "
        "shut-in volumes."
    )
    return result


# --- geometry ---------------------------------------------------------------------------
KM_PER_DEG = 111.195


def closest_approach(track: list[list], lon: float, lat: float, min_kt: int = MIN_KT) -> tuple[float, int, int] | None:
    """Closest pass of the storm centre to a point, as ``(km, minutes since epoch, wind kt)``.

    Best-track points are six hours apart, in which a storm covers 100 km or more, so the
    distance is measured to the segments between points, on a local flat projection. Only
    the part of the track at ``min_kt`` or more (and still tropical) counts.
    """
    kx = KM_PER_DEG * math.cos(math.radians(lat))
    best: tuple[float, int, int] | None = None
    for a, b in zip(track, track[1:]):
        if max(a[3], b[3]) < min_kt or (a[4] not in TROPICAL and b[4] not in TROPICAL):
            continue
        ax, ay = (a[2] - lon) * kx, (a[1] - lat) * KM_PER_DEG
        bx, by = (b[2] - lon) * kx, (b[1] - lat) * KM_PER_DEG
        dx, dy = bx - ax, by - ay
        seg = dx * dx + dy * dy
        t = 0.0 if seg == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg))
        d = math.hypot(ax + t * dx, ay + t * dy)
        if best is None or d < best[0]:
            best = (d, round(a[0] + t * (b[0] - a[0])), round(a[3] + t * (b[3] - a[3])))
    return best


def _month_of(minutes: int) -> str:
    return dt.datetime.fromtimestamp(minutes * 60, dt.timezone.utc).strftime("%Y-%m")


# --- impact -----------------------------------------------------------------------------
def impact(values: list[float | None], days: list[int], m: int, stop: int | None = None) -> dict | None:
    """Estimate what a storm in month index ``m`` deferred at one hub.

    ``values`` is the hub's monthly rate in kboe/d (``None`` where it has no data) and
    ``days`` the days in each month. ``stop`` is the month of a later, stronger storm at
    the same hub: counting ends there, so two storms never claim the same month.

    - baseline: mean of the 3 months before ``m``
    - recovered: the first month after ``m`` at or above 90% of baseline
    - deferred: sum of (baseline - actual) x days over the months before recovery

    Returns ``None`` (no estimate) when
    - there is no baseline, or it is under 1 kboe/d;
    - neither the storm month nor the month after is below 90% of baseline (a late-month
      storm shows up in the next month);
    - the dip is smaller than twice the month-to-month noise of the 6 months before
      (noise = 1.4826 x median absolute deviation, so one earlier outage does not hide it);
    - production makes a new, clearly lower low two or more months later, or is still
      down after 12 months: that shape points to a decline or another outage, not a storm.
    """
    if m < BASELINE_MONTHS or m >= len(values):
        return None
    before = values[m - BASELINE_MONTHS : m]
    if any(v is None for v in before):
        return None
    base = sum(before) / BASELINE_MONTHS  # type: ignore[arg-type]
    if base < MIN_BASELINE_KBOED:
        return None
    prior = [v for v in values[max(0, m - NOISE_MONTHS) : m] if v is not None]
    med = statistics.median(prior)
    noise = 1.4826 * statistics.median(abs(v - med) for v in prior) / base
    threshold = RECOVERY * base

    window: list[int] = []
    ended = "data"
    for i in range(m, len(values)):
        v = values[i]
        if v is None:
            break
        if stop is not None and i >= stop:
            ended = "storm"
            break
        if i > m and v >= threshold:
            ended = "recovered"
            break
        if i >= m + 2 and v < min(values[m], values[m + 1]) - NEW_LOW * base:  # type: ignore[type-var,operator]
            ended = "new-low"
            break
        if i >= m + HORIZON_MONTHS:
            ended = "horizon"
            break
        window.append(i)
    if not window or ended in ("new-low", "horizon"):
        return None
    if values[m] >= threshold and len(window) == 1:  # type: ignore[operator]
        return None
    low = min(values[i] for i in window[:2])  # type: ignore[type-var]
    if (base - low) / base < max(1 - RECOVERY, NOISE_FACTOR * noise):  # type: ignore[operator]
        return None
    deferred_kboe = sum(max(0.0, base - values[i]) * days[i] for i in window)  # type: ignore[operator]
    return {
        "baseline": round(base, 1),
        "low": round(low, 1),  # type: ignore[arg-type]
        "deferred_mboe": round(deferred_kboe / 1000, 2),
        "months": len(window),
        "recovered": ended == "recovered",
    }


_ESTIMATE_KEYS = ("baseline", "low", "deferred_mboe", "months", "recovered")


def attribute(values: list[float | None], days: list[int], passes: list[dict]) -> list[dict]:
    """Share one hub's dips out among the storms that passed it.

    ``passes`` are ``{storm, km, kt, m}``. Monthly data cannot separate two storms, so:

    - storms in the same month: the stronger pass at the hub (then the closer) carries the
      estimate and the others point to it with ``shared_with``;
    - a storm arriving before the hub has recovered from an earlier one is folded into the
      earlier storm the same way, unless it is the stronger pass. Then the earlier
      storm's count ends there and the later storm starts its own.

    Returns one record per pass, in time order.
    """
    by_month: dict[int, list[dict]] = {}
    for p in passes:
        by_month.setdefault(p["m"], []).append(p)
    out: list[dict] = []
    cur: dict | None = None  # the open estimate: its hub record, lead pass and end month
    for m in sorted(by_month):
        group = sorted(by_month[m], key=lambda p: (-p["kt"], p["km"]))
        hubs = [{"storm": p["storm"], "km": round(p["km"]), "kt": p["kt"], "m": m} for p in group]
        out += hubs
        if cur and m < cur["end"]:
            if group[0]["kt"] <= cur["lead"]["kt"]:
                for h in hubs:
                    h["shared_with"] = cur["lead"]["storm"]
                continue
            cut = impact(values, days, cur["lead"]["m"], stop=m)
            for k in _ESTIMATE_KEYS:
                cur["hub"].pop(k, None)
            cur["hub"].update(cut or {})
            if not cut:
                for h in out:
                    if h.get("shared_with") == cur["lead"]["storm"] and h["m"] >= cur["lead"]["m"]:
                        del h["shared_with"]
        cur = None
        est = impact(values, days, m)
        if est:
            hubs[0].update(est)
            for h in hubs[1:]:
                h["shared_with"] = group[0]["storm"]
            cur = {"hub": hubs[0], "lead": group[0], "end": m + est["months"]}
    return out


# --- bundle -----------------------------------------------------------------------------
def bundle(storms: list[dict], assets: list[dict], prod: dict, through: int | None = None) -> dict:
    """Filter the Gulf storms to those that passed Shell structures and attach impacts."""
    months: list[str] = prod.get("months", [])
    month_idx = {m: i for i, m in enumerate(months)}
    days = [days_in(m) for m in months]
    gom = [f for f in assets if f["properties"].get("region") == "gom"]

    # hub = one production series, located at every installation that reports under it
    hub_sites: dict[str, list[tuple[float, float]]] = {}
    for f in gom:
        sid = f["properties"].get("series")
        if sid and sid in prod.get("series", {}):
            hub_sites.setdefault(sid, []).append(tuple(f["geometry"]["coordinates"]))

    def series_values(sid: str) -> list[float | None]:
        s = prod["series"][sid]
        vals: list[float | None] = [None] * len(months)
        for k, (o, g) in enumerate(zip(s["oil"], s["gas"])):
            vals[s["start"] + k] = kboed(o, g)
        return vals

    kept: dict[str, dict] = {}
    passes: dict[str, list[dict]] = {}  # series id -> storm passes, for attribution
    for s in sorted(storms, key=lambda s: s["track"][0][0]):
        near = [c for f in gom if (c := closest_approach(s["track"], *f["geometry"]["coordinates"])) and c[0] <= RADIUS_KM]
        if not near:
            continue
        nearest = min(near)
        kept[s["id"]] = {
            "id": s["id"],
            "name": s["name"],
            "year": s["year"],
            "peak_kt": peak_kt(s),
            "month": _month_of(nearest[1]),
            "closest_km": round(nearest[0]),
            "structures": len(near),
            "track": [[p[0], round(p[1], 1), round(p[2], 1), p[3], p[4]] for p in s["track"]],
            "hubs": [],
            "deferred_mboe": None,
            "months": None,
            "recovered": None,
        }
        for sid, sites in hub_sites.items():
            cs = [c for lon, lat in sites if (c := closest_approach(s["track"], lon, lat)) and c[0] <= RADIUS_KM]
            if not cs:
                continue
            km, when, kt = min(cs)
            if _month_of(when) in month_idx:
                passes.setdefault(sid, []).append({"storm": s["id"], "km": km, "kt": kt, "m": month_idx[_month_of(when)]})

    for sid, ps in passes.items():
        for h in attribute(series_values(sid), days, ps):
            storm_id, m = h.pop("storm"), h.pop("m")
            kept[storm_id]["hubs"].append({"series": sid, "name": prod["series"][sid]["name"], "month": months[m], **h})

    for rec in kept.values():
        rec["hubs"].sort(key=lambda h: (-h.get("deferred_mboe", -1.0), h["km"]))
        hit = [h for h in rec["hubs"] if "deferred_mboe" in h]
        if hit:
            rec["deferred_mboe"] = round(sum(h["deferred_mboe"] for h in hit), 2)
            rec["months"] = max(h["months"] for h in hit)
            rec["recovered"] = all(h["recovered"] for h in hit)
    return {
        "through": through,
        "method": {
            "radius_km": RADIUS_KM,
            "min_kt": MIN_KT,
            "baseline_months": BASELINE_MONTHS,
            "recovery": RECOVERY,
            "horizon_months": HORIZON_MONTHS,
            "noise_factor": NOISE_FACTOR,
        },
        "storms": list(kept.values()),
    }
