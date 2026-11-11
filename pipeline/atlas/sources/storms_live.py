"""Active Atlantic storms — NOAA National Hurricane Center ``CurrentStorms.json``.

The feed sends no ``Access-Control-Allow-Origin`` header, so a browser on another origin
cannot read it. The pipeline snapshots it instead and the web app shows when it was
checked. For each active Atlantic system the forecast track and the cone of uncertainty
are read from the advisory's KMZ files (KML inside a zip; no GIS dependency needed).
"""

from __future__ import annotations

import datetime as dt
import io
import json
import logging
import re
import zipfile

from ..geo import simplify_line
from ..model import SourceResult
from ..net import fetch

log = logging.getLogger(__name__)

FEED_URL = "https://www.nhc.noaa.gov/CurrentStorms.json"

_COORDS_RE = r"<coordinates>([^<]*)</coordinates>"
_LINE_RE = re.compile(r"<LineString>.*?" + _COORDS_RE, re.S)
_RING_RE = re.compile(r"<LinearRing>.*?" + _COORDS_RE, re.S)


def _coords(block: str) -> list[tuple[float, float]]:
    out = []
    for tok in block.split():
        parts = tok.split(",")
        try:
            lon, lat = float(parts[0]), float(parts[1])
            out.append((lon - 360 if lon > 180 else lon, lat))  # some advisories use 0-360 longitudes
        except (ValueError, IndexError):
            continue
    return out


def parse_track_kml(kml: str) -> list[list[float]] | None:
    """The longest forecast line in an NHC ``*_TRACK.kml`` as ``[[lon, lat], ...]``."""
    lines = [_coords(m) for m in _LINE_RE.findall(kml)]
    best = max(lines, key=len, default=[])
    return [[round(x, 2), round(y, 2)] for x, y in best] if len(best) >= 2 else None


def parse_cone_kml(kml: str) -> list[list[float]] | None:
    """The largest ring in an NHC ``*_CONE.kml`` as a closed ``[[lon, lat], ...]`` ring."""
    rings = [_coords(m) for m in _RING_RE.findall(kml)]
    best = max(rings, key=len, default=[])
    if len(best) < 4:
        return None
    ring = simplify_line(best, tol=0.02, ndigits=2)
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring if len(ring) >= 4 else None


def kmz_text(blob: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".kml"))
        return z.read(name).decode("utf-8", "replace")


def _kmz(url: str | None, parse) -> list[list[float]] | None:
    if not url:
        return None
    try:
        return parse(kmz_text(fetch(url, ttl=0, retries=2)))
    except Exception as exc:  # a missing graphic must not lose the storm itself
        log.warning("could not read %s: %s", url, exc)
        return None


def normalise(s: dict, *, graphics: bool = True) -> dict:
    """One ``activeStorms`` entry in the bundle's shape."""
    adv = s.get("publicAdvisory") or s.get("forecastAdvisory") or {}
    out = {
        "id": str(s["id"]).upper(),
        "name": s.get("name"),
        "classification": s.get("classification"),
        "wind_kt": int(float(s["intensity"])) if s.get("intensity") not in (None, "") else None,
        "pressure_mb": int(float(s["pressure"])) if s.get("pressure") not in (None, "") else None,
        "lon": s.get("longitudeNumeric"),
        "lat": s.get("latitudeNumeric"),
        "updated": s.get("lastUpdate"),
        "advisory": adv.get("advNum"),
        "url": adv.get("url"),
    }
    if graphics:
        out["track"] = _kmz((s.get("forecastTrack") or {}).get("kmzFile"), parse_track_kml)
        out["cone"] = _kmz((s.get("trackCone") or {}).get("kmzFile"), parse_cone_kml)
    return out


def atlantic(feed: dict) -> list[dict]:
    return [s for s in feed.get("activeStorms") or [] if str(s.get("id", "")).lower().startswith("al")]


def build() -> SourceResult:
    result = SourceResult(
        key="nhc_live",
        title="NHC active storms — current Atlantic systems, forecast track and cone",
        publisher="NOAA National Hurricane Center",
        url="https://www.nhc.noaa.gov/",
        license="US Government work (public domain)",
    )
    feed = json.loads(fetch(FEED_URL, expect="json", ttl=0))
    if "activeStorms" not in feed:
        raise RuntimeError("CurrentStorms.json has no activeStorms list; the format may have changed")
    systems = [normalise(s) for s in atlantic(feed)]
    log.info("NHC: %d active systems, %d in the Atlantic basin", len(feed["activeStorms"] or []), len(systems))
    result.extra = {
        "systems": systems,
        "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    result.notes.append(
        "Live storm risk is a snapshot of the NHC active-storms feed taken when the pipeline last ran, not a "
        "real-time feed. Production in the path sums the latest reported month for hubs inside the forecast cone "
        "or near the forecast track; it is not a forecast of shut-ins. For decisions, use nhc.noaa.gov."
    )
    return result
