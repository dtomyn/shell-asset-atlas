"""Run every source adapter and write the web bundle.

    uv run atlas-build                 # writes ../web/public/data
    uv run atlas-build --only boem     # refresh one source, reuse snapshots for the rest

Each source's normalised output is also saved to ``snapshots/<key>.json``. If a publisher is
down when the scheduled refresh runs, the build falls back to the last good snapshot and
marks that source as *stale* in the manifest instead of failing the whole deploy.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import sys
import traceback
from dataclasses import asdict
from pathlib import Path

from .geo import line_length_km
from .model import Series, SourceResult, kboed
from .sources import flagship, gom, norway, retail, uk

log = logging.getLogger("atlas")

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOTS = ROOT / "snapshots"
DEFAULT_OUT = ROOT.parent / "web" / "public" / "data"

SOURCES = {"boem": gom, "nsta": uk, "sodir": norway, "osm": retail, "curated": flagship}
REGIONS = {"gom": "US Gulf of America", "uk": "UK North Sea", "no": "Norway", "global": "Global"}


# --- snapshots ------------------------------------------------------------------------
def save_snapshot(r: SourceResult) -> None:
    SNAPSHOTS.mkdir(exist_ok=True)
    payload = asdict(r)
    payload["series"] = [{**asdict(s), "months": {k: list(v) for k, v in s.months.items()}} for s in r.series]
    payload["fetched_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    (SNAPSHOTS / f"{r.key}.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def load_snapshot(key: str) -> tuple[SourceResult, str] | None:
    p = SNAPSHOTS / f"{key}.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    fetched = d.pop("fetched_at", None)
    series = [Series(**{**s, "months": {k: tuple(v) for k, v in s["months"].items()}}) for s in d.pop("series")]
    return SourceResult(**d, series=series), fetched


# --- production bundle ----------------------------------------------------------------
def month_range(first: str, last: str) -> list[str]:
    y, m = int(first[:4]), int(first[5:])
    out = []
    while f"{y:04d}-{m:02d}" <= last:
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def production_bundle(all_series: list[Series]) -> dict:
    months_all = sorted({m for s in all_series for m in s.months})
    if not months_all:
        return {"months": [], "series": {}, "totals": {}}
    months = month_range(months_all[0], months_all[-1])
    idx = {m: i for i, m in enumerate(months)}
    out_series = {}
    totals: dict[str, dict[str, list[float]]] = {}
    latest_by_region: dict[str, str] = {}

    def acc(key: str, i: int, gross: float, net: float | None) -> None:
        t = totals.setdefault(key, {"gross": [0.0] * len(months), "net": [0.0] * len(months)})
        t["gross"][i] += gross
        if net is not None:
            t["net"][i] += net

    for s in all_series:
        if not s.months:
            continue
        ks = sorted(s.months)
        start = idx[ks[0]]
        end = idx[ks[-1]]
        oil = [0.0] * (end - start + 1)
        gas = [0.0] * (end - start + 1)
        for k, (o, g) in s.months.items():
            oil[idx[k] - start] = o
            gas[idx[k] - start] = g
            boe = kboed(o, g)
            net = boe * s.shell_share if s.shell_share is not None else None
            acc(f"{s.region}:{s.stake}", idx[k], boe, net)
            acc(s.region, idx[k], boe, net)
        latest_by_region[s.region] = max(latest_by_region.get(s.region, ""), ks[-1])
        out_series[s.id] = {
            "name": s.name,
            "region": s.region,
            "stake": s.stake,
            "share": round(s.shell_share, 4) if s.shell_share is not None else None,
            "start": start,
            "oil": [round(v, 2) for v in oil],
            "gas": [round(v, 2) for v in gas],
        }
    for t in totals.values():
        t["gross"] = [round(v, 1) for v in t["gross"]]
        t["net"] = [round(v, 1) for v in t["net"]]
    return {
        "months": months,
        "units": {"oil": "kbbl/d (oil + condensate + NGL)", "gas": "MMscf/d", "boe": "kboe/d (5.8 Mscf = 1 boe)"},
        "latest": latest_by_region,
        "series": out_series,
        "totals": totals,
    }


# --- main -------------------------------------------------------------------------------
def write_json(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--only", nargs="*", choices=list(SOURCES), help="refresh only these sources; use snapshots for the rest")
    ap.add_argument("--offline", action="store_true", help="build purely from snapshots")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)-7s %(name)s: %(message)s")

    results: list[SourceResult] = []
    status: dict[str, dict] = {}
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for key, mod in SOURCES.items():
        refresh = not args.offline and (not args.only or key in args.only)
        if refresh:
            try:
                log.info("fetching %s ...", key)
                r = mod.build()
                save_snapshot(r)
                results.append(r)
                status[key] = {"state": "fresh", "fetched_at": now}
                continue
            except Exception as exc:  # keep the deploy alive; surface the failure in the manifest
                log.error("%s failed: %s", key, exc)
                log.debug(traceback.format_exc())
                status[key] = {"state": "stale", "error": str(exc)[:300]}
        snap = load_snapshot(key)
        if snap:
            r, fetched = snap
            results.append(r)
            status.setdefault(key, {"state": "snapshot"})
            status[key]["fetched_at"] = fetched
        else:
            status[key] = {"state": "missing", **status.get(key, {})}

    assets = [a for r in results for a in r.assets]
    areas = [a for r in results for a in r.areas]
    lines = [l for r in results for l in r.lines]
    for l in lines:
        l["properties"]["length_km"] = round(line_length_km(l["geometry"]["coordinates"]), 1)
    ids = [f["properties"]["id"] for f in assets + areas + lines]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        log.warning("duplicate ids: %s", sorted(dupes)[:10])

    prod = production_bundle([s for r in results for s in r.series])
    retail_data = next((r.extra for r in results if r.key == "osm"), {"fuel": [], "ev": []})

    def latest(key: str, field: str = "gross") -> float | None:
        t = prod["totals"].get(key)
        if not t:
            return None
        vals = t[field]
        # use the last month with data for this region
        last = next((v for v in reversed(vals) if v), None)
        return last

    kpis = {
        "assets": len(assets),
        "fields": len(areas),
        "countries": len({f["properties"].get("country") for f in assets + areas if f["properties"].get("country")}),
        "pipeline_km": round(sum(l["properties"]["length_km"] for l in lines)),
        "fuel_stations": len(retail_data.get("fuel", [])),
        "ev_sites": len(retail_data.get("ev", [])),
        "production": {
            reg: {
                "month": prod["latest"].get(reg),
                "operated_gross": round(sum(latest(f"{reg}:{st}") or 0 for st in ("operated", "jv")), 1),
                "partner_gross": latest(f"{reg}:partner"),
                "net": latest(reg, "net") or None,
            }
            for reg in prod["latest"]
        },
    }

    out: Path = args.out
    sizes = {
        "assets.geojson": write_json(out / "assets.geojson", {"type": "FeatureCollection", "features": assets}),
        "fields.geojson": write_json(out / "fields.geojson", {"type": "FeatureCollection", "features": areas}),
        "pipelines.geojson": write_json(out / "pipelines.geojson", {"type": "FeatureCollection", "features": lines}),
        "production.json": write_json(out / "production.json", prod),
        "retail.json": write_json(out / "retail.json", retail_data),
    }
    manifest = {
        "generated_at": now,
        "regions": REGIONS,
        "kpis": kpis,
        "sources": [{**r.meta(), **status.get(r.key, {})} for r in results],
        "missing": [k for k, v in status.items() if v["state"] == "missing"],
        "files": sizes,
    }
    write_json(out / "manifest.json", manifest)
    for name, size in sizes.items():
        log.info("wrote %-18s %8.1f KB", name, size / 1024)
    log.info("KPIs: %s", json.dumps(kpis))
    bad = [k for k, v in status.items() if v["state"] in ("stale", "missing")]
    if bad:
        log.warning("sources not refreshed: %s", bad)
    return 1 if manifest["missing"] else 0


if __name__ == "__main__":
    sys.exit(main())
