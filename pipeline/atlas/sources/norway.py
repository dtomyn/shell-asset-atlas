"""Norwegian Continental Shelf — Norwegian Offshore Directorate (Sodir) FactPages / FactMaps.

Shell (A/S Norske Shell) operates Ormen Lange and holds equity in many other fields.
Current stakes come from the field licensee history table (rows with no end date).
"""

from __future__ import annotations

import csv
import io
import logging
import re

from ..geo import centroid, round_geometry, simplify_line
from ..model import BBL_PER_M3, SCF_PER_M3, Series, SourceResult, days_in, feature, point, title_case
from ..net import arcgis_query, fetch

log = logging.getLogger(__name__)

MAPS = "https://factmaps.sodir.no/api/rest/services/Factmaps/FactMapsWGS84/FeatureServer"
CSV = (
    "https://factpages.sodir.no/public?/Factpages/external/tableview/{table}"
    "&rs:Command=Render&rc:Toolbar=false&rc:Parameters=f&IpAddress=not_used&CultureCode=en&rs:Format=CSV&Top100=false"
)
FIRST_YEAR = 2015


def _csv(table: str) -> list[dict]:
    text = fetch(CSV.format(table=table), expect="csv").decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


def _q(names: list[str]) -> str:
    return ",".join("'" + n.replace("'", "''") + "'" for n in names)


def build() -> SourceResult:
    result = SourceResult(
        key="sodir",
        title="Sodir FactPages & FactMaps — fields, facilities, pipelines, monthly production",
        publisher="Norwegian Offshore Directorate",
        url="https://factpages.sodir.no/",
        license="Norwegian Licence for Open Government Data (NLOD) 2.0",
    )

    # Current Shell stakes per field
    stakes: dict[str, float] = {}
    for r in _csv("field_licensee_hst"):
        if "Shell" in r["cmpLongName"] and not r["fldLicenseeTo"]:
            stakes[r["fldName"]] = stakes.get(r["fldName"], 0) + float(r["fldCompanyShare"] or 0)
    names = sorted(stakes)
    log.info("Sodir: Shell holds current stakes in %d fields: %s", len(names), names)

    # Field polygons
    operators: dict[str, str] = {}
    for f in arcgis_query(f"{MAPS}/502", f"fldName IN ({_q(names)})", precision=4, simplify=0.002):
        p = f["properties"]
        op = p.get("cmpLongName") or ""
        operators[p["fldName"]] = op
        stake = "operated" if "Shell" in op else "partner"
        geom = round_geometry(f["geometry"])
        c = centroid(geom)
        result.areas.append(
            feature(
                geom,
                id=f"no-field-{p['fldName'].lower().replace(' ', '-')}",
                name=title_case(p["fldName"]),
                kind="field",
                region="no",
                country="Norway",
                operator=op,
                stake=stake,
                status=p.get("fldCurrentActivitySatus"),
                hydrocarbon=title_case(p.get("fldHcType")),
                discovered=p.get("fldDiscoveryYear"),
                shell_equity=round(stakes[p["fldName"]], 3),
                series=f"no:{p['fldName']}",
                center=[round(c[0], 4), round(c[1], 4)] if c else None,
                source="sodir",
                url=p.get("fldFactPageUrl"),
            )
        )

    # Monthly production for those fields
    series: dict[str, Series] = {}
    for r in _csv("field_production_monthly"):
        name = r["prfInformationCarrier"]
        if name not in stakes or int(r["prfYear"]) < FIRST_YEAR:
            continue
        ym = f"{r['prfYear']}-{int(r['prfMonth']):02d}"
        d = days_in(ym)
        liquids = sum(float(r[k] or 0) for k in ("prfPrdOilNetMillSm3", "prfPrdNGLNetMillSm3", "prfPrdCondensateNetMillSm3"))
        oil = liquids * 1e6 * BBL_PER_M3 / d / 1e3
        gas = float(r["prfPrdGasNetBillSm3"] or 0) * 1e9 * SCF_PER_M3 / 1e6 / d
        s = series.setdefault(
            name,
            Series(id=f"no:{name}", name=title_case(name), region="no",
                   stake="operated" if "Shell" in operators.get(name, "") else "partner",
                   shell_share=stakes[name] / 100),
        )
        s.add(ym, oil, gas)
    result.series = list(series.values())

    # Facilities: Shell-operated, or belonging to a field Shell has equity in
    where = f"fclCurrentOperatorName LIKE '%Shell%' OR fclBelongsToName IN ({_q(names)})"
    seen = set()
    for f in arcgis_query(f"{MAPS}/304", where, precision=5):
        p, g = f["properties"], f.get("geometry")
        if not g or len(g.get("coordinates") or []) < 2 or p["fclNpdidFacility"] in seen:
            continue
        seen.add(p["fclNpdidFacility"])
        kind = p.get("fclKind") or ""
        subsea = bool(re.search(r"SUBSEA|TEMPLATE|MULTI WELL|SINGLE WELL|LOADING", kind.upper()))
        op = p.get("fclCurrentOperatorName") or ""
        field = p.get("fclBelongsToName")
        result.assets.append(
            feature(
                point(*g["coordinates"][:2]),
                id=f"no-fcl-{p['fclNpdidFacility']}",
                name=title_case(p["fclName"]),
                kind="subsea" if subsea else ("plant" if p.get("fclSurface") == "N" and "ONSHORE" in kind.upper() else "platform"),
                subtype=title_case(kind),
                region="no",
                country="Norway",
                operator=op,
                stake="operated" if "Shell" in op else "partner",
                water_depth_m=p.get("fclWaterDepth"),
                installed=int(p["fclStartupDate"][:4]) if isinstance(p.get("fclStartupDate"), str) and p["fclStartupDate"][:4].isdigit() else None,
                field=title_case(field),
                shell_equity=round(stakes[field], 3) if field in stakes else None,
                series=f"no:{field}" if field in series else None,
                # Ormen Lange is an all-subsea development, so its templates are its "hubs".
                featured=(field == "ORMEN LANGE") or ((not subsea) and field == "TROLL"),
                source="sodir",
                url=p.get("fclFactPageUrl"),
            )
        )

    # Pipelines operated by Shell
    for f in arcgis_query(f"{MAPS}/311", "cmpLongName LIKE '%Shell%'", precision=5, simplify=0.0005):
        p, g = f["properties"], f.get("geometry")
        if not g:
            continue
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for i, part in enumerate(parts):
            coords = simplify_line([tuple(c[:2]) for c in part], tol=0.0005)
            if len(coords) >= 2:
                result.lines.append(
                    feature(
                        {"type": "LineString", "coordinates": coords},
                        id=f"no-ppl-{p['pplNpdidPipeline']}-{i}",
                        name=p.get("pplName"),
                        region="no",
                        stake="operated",
                        product=title_case(p.get("pplMedium")),
                        status=title_case(p.get("pplCurrentPhase")),
                        size_in=p.get("pplDimension"),
                        route=f"{p.get('fclNameFrom') or '?'} → {p.get('fclNameTo') or '?'}",
                        source="sodir",
                    )
                )
    result.notes.append("Production is gross field volume; Shell's net share is shown using current licence equity.")
    return result
