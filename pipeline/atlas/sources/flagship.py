"""Curated flagship sites (see ``data/flagship.toml``) for global context beyond the three
regulator datasets. Clearly labelled as curated in the UI."""

from __future__ import annotations

import tomllib
from pathlib import Path

from ..model import SourceResult, feature, point

DATA = Path(__file__).resolve().parents[1] / "data" / "flagship.toml"


def build() -> SourceResult:
    cfg = tomllib.loads(DATA.read_text(encoding="utf-8"))
    result = SourceResult(
        key="curated",
        title="Curated flagship sites (hand-maintained, approximate locations)",
        publisher="Atlas maintainers, linking to Wikidata where available",
        url="https://www.wikidata.org/",
        license="CC0 (Wikidata) / project licence",
    )
    for s in cfg["site"]:
        result.assets.append(
            feature(
                point(s["lon"], s["lat"]),
                id=f"site-{s['id']}",
                name=s["name"],
                kind=s["kind"],
                region="global",
                country=s["country"],
                stake=s["stake"],
                status=s.get("status"),
                summary=s.get("summary"),
                featured=True,
                curated=True,
                source="curated",
                url=f"https://www.wikidata.org/wiki/{s['wikidata']}" if s.get("wikidata") else None,
            )
        )
    result.notes.append(f"Curated list reviewed as of {cfg['as_of']}. Ownership changes; verify before relying on it.")
    return result
