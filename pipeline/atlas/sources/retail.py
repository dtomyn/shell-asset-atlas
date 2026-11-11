"""Shell-branded retail fuel stations and EV charge points from OpenStreetMap (Overpass API).

OpenStreetMap is crowd-sourced: coverage is excellent in Europe and North America and
patchier elsewhere, so treat counts as "mapped stations", not Shell's official network size.
"""

from __future__ import annotations

import json
import logging

from ..model import SourceResult
from ..net import fetch

log = logging.getLogger(__name__)

OVERPASS = "https://overpass-api.de/api/interpreter"

FUEL_QUERY = '[out:json][timeout:600];nwr["amenity"="fuel"]["brand"="Shell"];out center tags;'
EV_QUERY = (
    "[out:json][timeout:600];("
    'nwr["amenity"="charging_station"]["brand"~"^Shell",i];'
    'nwr["amenity"="charging_station"]["operator"~"^(Shell|ubitricity)",i];'
    'nwr["amenity"="charging_station"]["network"~"^(Shell Recharge|ubitricity)",i];'
    ");out center tags;"
)


def _coords(el: dict) -> tuple[float, float] | None:
    if "lon" in el:
        return el["lon"], el["lat"]
    c = el.get("center")
    return (c["lon"], c["lat"]) if c else None


def _run(query: str) -> list[dict]:
    raw = fetch(OVERPASS, data={"data": query}, timeout=900, expect="json")
    return json.loads(raw.decode("utf-8"))["elements"]


def build() -> SourceResult:
    result = SourceResult(
        key="osm",
        title="OpenStreetMap — Shell-branded fuel stations and Shell Recharge / ubitricity charge points",
        publisher="OpenStreetMap contributors",
        url="https://www.openstreetmap.org/copyright",
        license="Open Database License (ODbL) 1.0",
    )
    fuel, ev = [], []
    seen: set[tuple[float, float]] = set()
    for el in _run(FUEL_QUERY):
        c = _coords(el)
        if not c:
            continue
        key = (round(c[0], 4), round(c[1], 4))
        if key in seen:
            continue
        seen.add(key)
        tags = el.get("tags", {})
        # flag 1: station advertises EV charging on-site
        flags = 1 if tags.get("fuel:electricity") == "yes" or tags.get("charging_station") == "yes" else 0
        fuel.append([key[0], key[1], flags])
    for el in _run(EV_QUERY):
        c = _coords(el)
        if c:
            tags = el.get("tags", {})
            try:
                cap = int(tags.get("capacity", "0").split(";")[0])
            except ValueError:
                cap = 0
            ev.append([round(c[0], 4), round(c[1], 4), cap])
    log.info("OSM: %d Shell fuel stations, %d Shell EV charge sites", len(fuel), len(ev))
    result.extra = {"fuel": fuel, "ev": ev}
    result.notes.append("Crowd-sourced: counts reflect what volunteers have mapped, not Shell's official network.")
    return result
