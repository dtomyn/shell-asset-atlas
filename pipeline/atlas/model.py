"""Shared data model: assets, production series and unit conversions.

Every source adapter returns a :class:`SourceResult`. The build step merges them into the
web bundle. Keeping one schema means the front end never needs to know which regulator a
feature came from.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from typing import Any

# --- unit conversions -------------------------------------------------------------------
BBL_PER_M3 = 6.28981
SCF_PER_M3 = 35.3147
SCF_PER_BOE = 5800.0  # industry-standard gas-to-oil energy equivalence used for boe


def days_in(ym: str) -> int:
    y, m = int(ym[:4]), int(ym[5:7])
    return calendar.monthrange(y, m)[1]


def kboed(oil_kbd: float, gas_mmscfd: float) -> float:
    """Thousand barrels of oil equivalent per day."""
    return oil_kbd + gas_mmscfd * 1e6 / SCF_PER_BOE / 1e3


# --- stake taxonomy ---------------------------------------------------------------------
# operated : Shell entity is the regulator-recorded operator
# jv       : operated by a joint venture Shell co-owns (e.g. Adura, 50% Shell / 50% Equinor)
# partner  : Shell holds equity but another company operates
STAKES = ("operated", "jv", "partner")


@dataclass
class Series:
    """Monthly production for one field / hub. Values are gross (100%) rates."""

    id: str
    name: str
    region: str
    stake: str
    # month "YYYY-MM" -> (oil kbbl/d, gas MMscf/d)
    months: dict[str, tuple[float, float]] = field(default_factory=dict)
    shell_share: float | None = None  # fraction 0..1 when known

    def add(self, ym: str, oil_kbd: float, gas_mmscfd: float) -> None:
        o, g = self.months.get(ym, (0.0, 0.0))
        self.months[ym] = (o + oil_kbd, g + gas_mmscfd)


@dataclass
class SourceResult:
    key: str
    title: str
    publisher: str
    url: str
    license: str
    assets: list[dict] = field(default_factory=list)  # GeoJSON Point features
    areas: list[dict] = field(default_factory=list)  # GeoJSON Polygon features (fields)
    lines: list[dict] = field(default_factory=list)  # GeoJSON LineString features (pipelines)
    series: list[Series] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)  # source-specific bundles (e.g. retail)
    notes: list[str] = field(default_factory=list)

    def meta(self) -> dict:
        return {
            "key": self.key,
            "title": self.title,
            "publisher": self.publisher,
            "url": self.url,
            "license": self.license,
            "counts": {
                "assets": len(self.assets),
                "areas": len(self.areas),
                "lines": len(self.lines),
                "series": len(self.series),
                **{k: len(v) for k, v in self.extra.items() if isinstance(v, list)},
            },
            "notes": self.notes,
        }


def feature(geometry: dict, **props: Any) -> dict:
    return {"type": "Feature", "geometry": geometry, "properties": {k: v for k, v in props.items() if v not in (None, "")}}


def point(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}


def title_case(s: str | None) -> str | None:
    if not s:
        return s
    small = {"of", "and", "the", "in", "on"}
    acronyms = {"FPSO", "FSO", "FSU", "PDQ", "LNG", "GTL", "CCS", "PLC", "LLC", "UK", "NGL", "AS", "ASA", "TLP"}
    words = s.strip().split()
    out = []
    for i, w in enumerate(words):
        lw = w.lower()
        if w.upper().strip(",.()") in acronyms:
            out.append(w.upper())
        elif i and lw in small:
            out.append(lw)
        elif any(ch.isdigit() for ch in w) or (len(w) <= 3 and w.isupper() and w not in {"OIL", "GAS", "SEA"}):
            out.append(w)  # keep codes like "MC", "PB", "A/S"
        else:
            out.append(w[:1].upper() + w[1:].lower())
    return " ".join(out)
