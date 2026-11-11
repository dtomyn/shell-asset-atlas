"""Peer benchmark — monthly production by operator, per basin, for every operator.

The three regulators publish production for all operators, not only Shell. This module
adds up **gross (100%) production by operator of record** in kboe/d:

  US Gulf   BOEM OGOR-A, the same yearly files ``sources/gom.py`` downloads. The operator is
            the BOEM company number on each completion-month. A deepwater cut uses the
            water depth of the lease (BOEM lease file, ``lsetapefixed.zip``, about 1 MB).
  UK        NSTA PPRS, offshore units only, summed on the server by organisation group and
            month (a few small requests instead of every field record).
  Norway    Sodir monthly field production (the file ``sources/norway.py`` downloads),
            joined to the field operator history table, so a field counts for whoever
            operated it in that month.

This is not equity or net production: an operator is credited with the whole field or
lease, whatever its working interest.

Names. BOEM and NSTA label history with each company's *current* name (BOEM company 02010
is "Woodside Energy (GoM) Inc" back to 2015, when it was a BHP Billiton company; NSTA shows
"Harbour Energy plc" in 2015, before that company existed). Sodir keeps the name of the
time. ``ENTITIES`` below is the only place legal entities are merged or renamed. An
entity that is not listed stays on its own, under the regulator's name.

Like storms, this is two steps: ``build()`` downloads and aggregates (that is the snapshot),
``bundle()`` cuts it to the timeline months and to the operators worth showing.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import logging
import re
from collections import defaultdict
from pathlib import Path

from .model import BBL_PER_M3, SCF_PER_M3, SourceResult, days_in, kboed, title_case
from .net import NotAvailable, fetch, fetch_json, zip_text
from .sources import gom, norway, uk

log = logging.getLogger(__name__)

SNAPSHOT = Path(__file__).resolve().parents[1] / "snapshots" / "peers.json"
LEASE_URL = f"{gom.BASE}/Leasing/Files/lsetapefixed.zip"

TOP_N = 12  # operators kept per basin (the top 12 of every month), plus an "Others" total
DEEPWATER_FT = 1000  # BOEM's usual deepwater line: water depth of 1,000 ft (305 m) or more
MIN_DEPTH_COVERAGE = 0.95  # drop the deepwater cut if fewer leases than this can be placed
FOCUS = {"shell": "shell", "adura": "jv"}  # group id -> how the front end marks it

BASINS = {
    "gom": {"label": "US Gulf", "place": "in the US Gulf", "source": "BOEM OGOR-A"},
    "gom_deep": {"label": "Gulf deepwater", "place": "in the deepwater US Gulf", "source": "BOEM OGOR-A and lease water depths"},
    "uk": {"label": "UK", "place": "on the UK continental shelf", "source": "NSTA PPRS"},
    "no": {"label": "Norway", "place": "on the Norwegian continental shelf", "source": "Sodir"},
}

# --- legal entity -> group --------------------------------------------------------------
# (basin, regulator's key, group id, display name). The key is the BOEM company number, the
# NSTA organisation group, or the Sodir company name. Rows that share a group id are summed.
# A row on its own only gives a regulator name a shorter label. Ownership that changed
# during the timeline is NOT merged: Hess (Chevron since July 2025), Anadarko (Occidental
# since 2019), BG Norge (Shell since 2016), BP Norge (merged into Aker BP in 2016), Eni Norge
# and Point Resources (merged into Vår Energi in 2018), Neptune, Wintershall Dea and Harbour
# all stay separate, under the operator the regulator recorded.
ENTITIES: list[tuple[str, str, str, str]] = [
    # US Gulf: same brand in the BOEM company name, or a long-standing subsidiary
    ("gom", "00689", "shell", "Shell"),  # Shell Offshore Inc.
    ("gom", "02117", "shell", "Shell"),  # Shell Gulf of Mexico Inc.
    ("gom", "02481", "bp", "bp"),  # BP Exploration & Production Inc.
    ("gom", "00078", "chevron", "Chevron"),  # Chevron U.S.A. Inc.
    ("gom", "00003", "chevron", "Chevron"),  # Union Oil Company of California (Unocal), a Chevron subsidiary since 2005
    ("gom", "01834", "talos", "Talos"),  # Talos Petroleum LLC
    ("gom", "02899", "talos", "Talos"),  # Talos ERT LLC
    ("gom", "03026", "talos", "Talos"),  # Talos Energy Ventures LLC
    ("gom", "03201", "talos", "Talos"),  # Talos Gulf Coast Offshore LLC
    ("gom", "03247", "talos", "Talos"),  # Talos Energy Offshore LLC
    ("gom", "03269", "talos", "Talos"),  # Talos Oil and Gas LLC
    ("gom", "03619", "talos", "Talos"),  # Talos Third Coast LLC
    ("gom", "03672", "talos", "Talos"),  # Talos QN Exploration LLC
    ("gom", "01284", "w-and-t", "W&T Offshore"),  # W & T Offshore Inc.
    ("gom", "03148", "w-and-t", "W&T Offshore"),  # W & T Energy VI LLC
    ("gom", "02010", "woodside", "Woodside"),  # Woodside Energy (GoM) Inc.
    ("gom", "02277", "woodside", "Woodside"),  # Woodside Energy (Deepwater) Inc.
    ("gom", "03295", "fieldwood", "Fieldwood Energy"),  # Fieldwood Energy LLC
    ("gom", "03035", "fieldwood", "Fieldwood Energy"),  # Fieldwood Energy Offshore LLC
    ("gom", "00981", "anadarko", "Anadarko"),  # Anadarko Petroleum Corporation
    ("gom", "02647", "murphy", "Murphy"),  # Murphy Exploration & Production Company - USA
    ("gom", "02058", "llog", "LLOG"),  # LLOG Exploration Offshore LLC
    ("gom", "00059", "hess", "Hess"),  # Hess Corporation
    ("gom", "00276", "exxonmobil", "ExxonMobil"),  # Exxon Mobil Corporation
    ("gom", "00162", "eni", "Eni"),  # Eni Petroleum Co. Inc.
    ("gom", "03362", "kosmos", "Kosmos"),  # Kosmos Energy Gulf of Mexico Operations LLC
    ("gom", "03572", "boe-exploration", "BOE Exploration & Production"),
    ("gom", "03567", "beacon", "Beacon Growthco"),  # Beacon Growthco Operating Company LLC
    ("gom", "02375", "energy-xxi", "Energy XXI GOM"),
    ("gom", "03280", "freeport", "Freeport-McMoRan Oil & Gas"),
    ("gom", "03151", "cox", "Cox Operating"),
    # UK: NSTA organisation groups, which are already groups
    ("uk", "SHELL PLC", "shell", "Shell"),
    ("uk", "ADURA ENERGY", "adura", "Adura (Shell/Equinor JV)"),  # 50/50 joint venture: never folded into Shell
    ("uk", "BP EXPLORATION", "bp", "bp"),
    ("uk", "EQUINOR ASA", "equinor", "Equinor"),
    ("uk", "NEO NEXT+ ENERGY", "neo-next", "NEO NEXT+"),
    ("uk", "CNOOC INTERNATIONAL", "cnooc", "CNOOC International"),
    ("uk", "CNR INTERNATIONAL", "cnr", "CNR International"),
    ("uk", "ENQUEST PLC", "enquest", "EnQuest"),
    ("uk", "TAQA EUROPA B.V.", "taqa", "TAQA"),
    ("uk", "INEOS INDUSTRIES", "ineos", "INEOS"),
    ("uk", "APACHE CORPORATION", "apache", "Apache"),
    ("uk", "ENI UK LIMITED", "eni", "Eni"),
    ("uk", "CONOCOPHILLIPS", "conocophillips", "ConocoPhillips"),
    ("uk", "ONE-DYAS", "one-dyas", "ONE-Dyas"),
    # Norway: renames and legal successors of the same company
    ("no", "A/S Norske Shell", "shell", "Shell"),
    ("no", "Statoil Petroleum AS", "equinor", "Equinor"),  # renamed Equinor Energy AS in 2018
    ("no", "Equinor Energy AS", "equinor", "Equinor"),
    ("no", "Det norske oljeselskap ASA", "aker-bp", "Aker BP"),  # renamed Aker BP ASA in 2016
    ("no", "Aker BP ASA", "aker-bp", "Aker BP"),
    ("no", "ABP Norway AS", "aker-bp", "Aker BP"),  # the Aker BP company that took over Lundin's fields in 2022
    ("no", "Lundin Norway AS", "lundin", "Lundin"),
    ("no", "Lundin Energy Norway AS", "lundin", "Lundin"),
    ("no", "Vår Energi AS", "var-energi", "Vår Energi"),
    ("no", "Vår Energi ASA", "var-energi", "Vår Energi"),
    ("no", "Vår Energi Norge AS", "var-energi", "Vår Energi"),
    ("no", "ConocoPhillips Skandinavia AS", "conocophillips", "ConocoPhillips"),
    ("no", "ExxonMobil Exploration and Production Norway AS", "exxonmobil", "ExxonMobil"),
    ("no", "OKEA AS", "okea", "OKEA"),
    ("no", "OKEA ASA", "okea", "OKEA"),
    ("no", "DNO Norge AS", "dno", "DNO"),
    ("no", "DNO Norge AS (old)", "dno", "DNO"),
    ("no", "DNO North Sea (Norge) AS", "dno", "DNO"),
    ("no", "Wintershall Norge AS", "wintershall-dea", "Wintershall Dea"),
    ("no", "Wintershall Dea Norge AS", "wintershall-dea", "Wintershall Dea"),
    ("no", "Harbour Energy Norge AS", "harbour-energy", "Harbour Energy"),
    ("no", "GDF SUEZ E&P Norge AS", "engie", "Engie E&P"),  # renamed ENGIE E&P Norge AS in 2016
    ("no", "ENGIE E&P Norge AS", "engie", "Engie E&P"),
    ("no", "Total E&P Norge AS", "totalenergies", "TotalEnergies"),  # renamed TotalEnergies in 2021
    ("no", "TotalEnergies EP Norge AS", "totalenergies", "TotalEnergies"),
    ("no", "Total E&P UK Ltd", "totalenergies", "TotalEnergies"),
    ("no", "Total Oil UK Limited", "totalenergies", "TotalEnergies"),
    ("no", "TotalEnergies E&P UK Limited", "totalenergies", "TotalEnergies"),
    ("no", "Repsol Norge AS", "repsol", "Repsol"),
    ("no", "Repsol Exploration Norge AS", "repsol", "Repsol"),
    ("no", "Spirit Energy Norge AS", "spirit-energy", "Spirit Energy"),
    ("no", "Spirit Energy Norway AS", "spirit-energy", "Spirit Energy"),
]
_ENTITY = {(b, k): (gid, name) for b, k, gid, name in ENTITIES}

_SUFFIX = re.compile(
    r"(?:[\s,]+(?:INC|LLC|LP|L\.P|PLC|LTD|LIMITED|CORPORATION|CORP|COMPANY|CO|ASA|AS|B\.V|HOLDINGS|GROUP))+\.?$", re.I
)


def tidy_name(raw: str) -> str:
    """'ARENA OFFSHORE LP' -> 'Arena Offshore'; names with lower case are left as written."""
    name = _SUFFIX.sub("", raw.strip()) or raw.strip()
    return name if name != name.upper() else title_case(name) or name


def group_of(basin: str, key: str, raw_name: str) -> tuple[str, str]:
    """Group id and display name for one regulator entity. Unlisted entities stay alone."""
    hit = _ENTITY.get((basin, key))
    if hit:
        return hit
    slug = re.sub(r"[^a-z0-9]+", "-", raw_name.lower()).strip("-") or key.lower()
    return (f"boem-{key}" if basin == "gom" else slug), tidy_name(raw_name)


# --- aggregation ------------------------------------------------------------------------
class Tally:
    """Monthly kboe/d per group for one basin."""

    def __init__(self, basin: str):
        self.basin = basin
        self.ops: dict[str, dict] = {}
        self.unattributed: dict[str, float] = defaultdict(float)
        self._groups: dict[tuple[str, str], tuple[str, str]] = {}

    def add(self, key: str | None, raw_name: str | None, ym: str, boe: float) -> None:
        if not key or not raw_name:
            self.unattributed[ym] += boe  # still part of the basin total
            return
        g = self._groups.get((key, raw_name))
        if g is None:
            g = self._groups[(key, raw_name)] = group_of(self.basin, key, raw_name)
        op = self.ops.setdefault(g[0], {"id": g[0], "name": g[1], "entities": set(), "months": defaultdict(float)})
        op["entities"].add(raw_name)
        op["months"][ym] += boe

    def dump(self) -> dict:
        """Snapshot form: dense arrays from the basin's first month."""
        months = sorted({m for op in self.ops.values() for m in op["months"]} | set(self.unattributed))
        if not months:
            raise RuntimeError(f"no production rows for {self.basin}")
        span = month_range(months[0], months[-1])
        return {
            "first": span[0],
            "last": span[-1],
            "operators": [
                {"id": op["id"], "name": op["name"], "entities": sorted(op["entities"]), "v": [round(op["months"].get(m, 0.0), 3) for m in span]}
                for op in sorted(self.ops.values(), key=lambda o: o["id"])
            ],
            "unattributed": [round(self.unattributed.get(m, 0.0), 3) for m in span],
        }


def month_range(first: str, last: str) -> list[str]:
    y, m = int(first[:4]), int(first[5:])
    out = []
    while f"{y:04d}-{m:02d}" <= last:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def rank(values: dict[str, float]) -> list[tuple[str, float]]:
    """Producing operators, largest first. Ties are broken by id so the order is stable."""
    return sorted(((k, v) for k, v in values.items() if v > 0), key=lambda kv: (-kv[1], kv[0]))


def keep(series: dict[str, list[float]], top_n: int = TOP_N, focus: tuple[str, ...] = tuple(FOCUS)) -> set[str]:
    """Operators to publish: the top ``top_n`` of every month, the focus operators, and
    anyone who out-produced a focus operator in any month. With that set, the rank of the
    top ``top_n`` and of the focus operators is exact in every month."""
    kept = {f for f in focus if f in series}
    n = max((len(v) for v in series.values()), default=0)
    for i in range(n):
        order = [k for k, _ in rank({k: v[i] for k, v in series.items()})]
        kept.update(order[:top_n])
        for f in focus:
            if f in order:
                kept.update(order[: order.index(f)])
    return kept


# --- US Gulf ----------------------------------------------------------------------------
def parse_lease_depths(text: str) -> dict[str, tuple[int, int]]:
    """BOEM lease file (fixed width) -> lease number -> (min, max) water depth in feet."""
    out: dict[str, tuple[int, int]] = {}
    for line in text.splitlines():
        lease, lo, hi = line[0:7].strip(), line[149:154].strip(), line[154:159].strip()
        if not lease or not (lo or hi) or not (lo + hi).isdigit():
            continue
        out[lease] = (int(lo or hi), int(hi or lo))
    return out


def is_deepwater(depth: tuple[int, int] | None) -> bool:
    """A lease is deepwater when all of it is in ``DEEPWATER_FT`` of water or more."""
    return depth is not None and depth[0] >= DEEPWATER_FT


def _gulf() -> dict[str, dict]:
    depths: dict[str, tuple[int, int]] = {}
    try:
        depths = parse_lease_depths(zip_text(fetch(LEASE_URL, expect="zip")))
    except Exception as exc:  # the benchmark is still worth having without the deepwater cut
        log.warning("BOEM lease file unavailable (%s); no deepwater cut", exc)
    every, deep = Tally("gom"), Tally("gom")
    total = placed = 0.0
    ndays: dict[str, int] = {}
    for year in range(gom.FIRST_YEAR, dt.date.today().year + 1):
        try:
            blob = fetch(f"{gom.BASE}/Production/Files/ogora{year}delimit.zip", expect="zip")
        except NotAvailable:
            continue
        for r in csv.reader(io.StringIO(zip_text(blob))):
            if len(r) < 14:
                continue
            ym = f"{r[2][:4]}-{r[2][4:6]}"
            d = ndays.get(ym) or ndays.setdefault(ym, days_in(ym))
            boe = kboed(int(r[5] or 0) / 1000 / d, int(r[6] or 0) / 1000 / d)  # bbl, mcf per month
            if not boe:
                continue
            num, name = r[11].strip(), r[12].strip()
            every.add(num, name, ym, boe)
            depth = depths.get(r[0].strip())
            total += boe
            placed += boe if depth else 0.0
            if is_deepwater(depth):
                deep.add(num, name, ym, boe)
    out = {"gom": every.dump()}
    coverage = placed / total if total else 0.0
    if coverage >= MIN_DEPTH_COVERAGE:
        out["gom_deep"] = {**deep.dump(), "depth_coverage": round(coverage, 4)}
    else:
        log.warning("only %.1f%% of Gulf production is on a lease with a water depth; no deepwater cut", coverage * 100)
    log.info("peers: US Gulf, %d operators, %.1f%% of volume placed by lease water depth", len(every.ops), coverage * 100)
    return out


# --- UK ---------------------------------------------------------------------------------
_UK_SUMS = ("OILPRODMBD", "GCONDMBD", "AGASPROMMS", "DGASPROMMS")


def _uk() -> dict[str, dict]:
    tally = Tally("uk")
    stats = json.dumps([{"statisticType": "sum", "onStatisticField": f, "outStatisticFieldName": f} for f in _UK_SUMS])
    offset = 0
    while True:
        page = fetch_json(
            f"{uk.PPRS}/query",
            params={
                "where": f"PERIODYRMN >= '{uk.FIRST_PERIOD}' AND LOCATION = 'Offshore'",
                "groupByFieldsForStatistics": "ORGGRPNM,PERIODYRMN",
                "outStatistics": stats,
                "orderByFields": "PERIODYRMN,ORGGRPNM",
                "resultOffset": offset,
                "resultRecordCount": 2000,
                "f": "json",
            },
        )
        if "error" in page:
            raise RuntimeError(f"ArcGIS error from NSTA PPRS: {page['error']}")
        rows = [f["attributes"] for f in page.get("features", [])]
        for a in rows:
            uk_row(tally, a)
        if not rows or not page.get("exceededTransferLimit"):
            break
        offset += len(rows)
    log.info("peers: UK, %d organisation groups", len(tally.ops))
    return {"uk": tally.dump()}


def uk_row(tally: Tally, a: dict) -> None:
    """One (organisation group, month) sum. PPRS rates are already kbbl/d and MMscf/d."""
    oil = (a.get("OILPRODMBD") or 0) + (a.get("GCONDMBD") or 0)
    gas = (a.get("AGASPROMMS") or 0) + (a.get("DGASPROMMS") or 0)
    org = (a.get("ORGGRPNM") or "").strip()
    tally.add(org, org, f"{a['PERIODYRMN'][:4]}-{a['PERIODYRMN'][4:6]}", kboed(oil, gas))


# --- Norway -----------------------------------------------------------------------------
def _date(s: str | None) -> dt.date | None:
    return dt.datetime.strptime(s, "%d.%m.%Y").date() if s else None


def operator_at(history: list[tuple[dt.date | None, dt.date | None, str]], day: dt.date) -> str | None:
    """The company operating a field on ``day``, from Sodir's (from, to, company) rows."""
    for start, end, company in history:
        if (start is None or start <= day) and (end is None or day <= end):
            return company
    return None


def _norway() -> dict[str, dict]:
    history: dict[str, list] = defaultdict(list)
    for r in norway._csv("field_operator_hst"):
        history[r["fldName"]].append((_date(r["fldOperatorFrom"]), _date(r["fldOperatorTo"]), r["cmpLongName"]))
    tally = Tally("no")
    for r in norway._csv("field_production_monthly"):
        if int(r["prfYear"]) < norway.FIRST_YEAR:
            continue
        ym = f"{r['prfYear']}-{int(r['prfMonth']):02d}"
        d = days_in(ym)
        liquids = sum(float(r[k] or 0) for k in ("prfPrdOilNetMillSm3", "prfPrdNGLNetMillSm3", "prfPrdCondensateNetMillSm3"))
        oil = liquids * 1e6 * BBL_PER_M3 / d / 1e3
        gas = float(r["prfPrdGasNetBillSm3"] or 0) * 1e9 * SCF_PER_M3 / 1e6 / d
        # mid-month, so a hand-over during the month goes to whoever held it for most of it
        company = operator_at(history.get(r["prfInformationCarrier"], []), dt.date(int(r["prfYear"]), int(r["prfMonth"]), 15))
        tally.add(company, company, ym, kboed(oil, gas))
    log.info("peers: Norway, %d operators", len(tally.ops))
    return {"no": tally.dump()}


# --- build ------------------------------------------------------------------------------
def _previous() -> dict[str, dict]:
    try:
        return json.loads(SNAPSHOT.read_text(encoding="utf-8"))["extra"]["basins"]
    except Exception:
        return {}


def build() -> SourceResult:
    result = SourceResult(
        key="peers",
        title="Peer benchmark — production by operator of record, all operators (BOEM OGOR-A, NSTA PPRS, Sodir)",
        publisher="BOEM, NSTA and Sodir",
        url="https://www.data.boem.gov/Main/Production.aspx",
        license="US Government work; Open Government Licence v3.0; NLOD 2.0",
    )
    previous = _previous()
    basins: dict[str, dict] = {}
    failed: list[str] = []
    for bid, fetch_basin in (("gom", _gulf), ("uk", _uk), ("no", _norway)):
        try:
            basins.update(fetch_basin())
        except Exception as exc:  # one regulator down: keep its last good numbers, refresh the rest
            log.error("peers: %s failed: %s", bid, exc)
            failed.append(bid)
            basins.update({k: {**v, "stale": True} for k, v in previous.items() if k == bid or k.startswith(bid + "_")})
    if len(failed) == 3:
        raise RuntimeError("no regulator could be read for the peer benchmark")
    result.extra = {"basins": basins, "deepwater_ft": DEEPWATER_FT}
    result.notes.append(
        "Peer benchmark: gross (100%) production by operator of record, not equity or net production. An operator is "
        "credited with the whole field or lease. Legal entities are grouped only by the table in pipeline/atlas/peers.py; "
        "BOEM and NSTA label history with each company's current name. Gulf deepwater means leases wholly in "
        f"{DEEPWATER_FT:,} ft ({DEEPWATER_FT * 0.3048:.0f} m) of water or more."
    )
    if failed:
        result.notes.append(f"Peer benchmark: {', '.join(BASINS[b]['label'] for b in failed)} reused from the last good snapshot.")
    return result


# --- bundle -----------------------------------------------------------------------------
def bundle(extra: dict, months: list[str], top_n: int = TOP_N) -> dict:
    """peers.json: the snapshot cut to the timeline ``months`` and to the operators shown.

    Per basin: ``total`` and ``n`` (operators producing) for every month, ``None`` outside
    the months the regulator has published, and each kept operator as ``start`` + values.
    Everything else is in "Others" = total - sum of the kept operators.
    """
    idx = {m: i for i, m in enumerate(months)}
    out = []
    for bid, meta in BASINS.items():
        b = (extra.get("basins") or {}).get(bid)
        if not b:
            continue
        span = month_range(b["first"], b["last"])
        cols = [(j, idx[m]) for j, m in enumerate(span) if m in idx]
        if not cols:
            continue
        lo, hi = cols[0][1], cols[-1][1]
        series = {op["id"]: [round(op["v"][j], 1) for j, _ in cols] for op in b["operators"]}
        raw_total = [sum(op["v"][j] for op in b["operators"]) + b["unattributed"][j] for j, _ in cols]
        kept = keep(series, top_n)
        ops = []
        for op in b["operators"]:
            v = series[op["id"]]
            live = [k for k, x in enumerate(v) if x > 0]
            if op["id"] not in kept or not live:
                continue
            ops.append(
                {
                    "id": op["id"],
                    "name": op["name"],
                    **({"focus": FOCUS[op["id"]]} if op["id"] in FOCUS else {}),
                    "entities": op["entities"],
                    "start": lo + live[0],
                    "v": v[live[0] : live[-1] + 1],
                }
            )
        ops.sort(key=lambda o: (-sum(o["v"]), o["id"]))
        pad = lambda vals: [None] * lo + vals + [None] * (len(months) - hi - 1)  # noqa: E731
        out.append(
            {
                "id": bid,
                **meta,
                "through": months[hi],
                **({"stale": True} if b.get("stale") else {}),
                **({"depth_coverage": b["depth_coverage"]} if "depth_coverage" in b else {}),
                "total": pad([round(t, 1) for t in raw_total]),
                "n": pad([sum(1 for v in series.values() if v[k] > 0) for k in range(len(cols))]),
                "operators": ops,
            }
        )
    return {
        "months": months,
        "unit": "kboe/d, gross (100%) production by operator of record",
        "top": top_n,
        "deepwater_ft": extra.get("deepwater_ft", DEEPWATER_FT),
        "basins": out,
    }
