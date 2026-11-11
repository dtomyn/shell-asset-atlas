"""UK Continental Shelf — North Sea Transition Authority (NSTA) open data.

Shell's UK upstream business was combined with Equinor's into Adura Energy (50/50 JV), so
the regulator now records many former Shell-operated fields under "ADURA ENERGY". Those are
tagged ``stake="jv"``; fields still recorded as "SHELL PLC" are ``operated``; fields where a
Shell company is only a licensee are ``partner``.
"""

from __future__ import annotations

import datetime as dt
import logging
import re

from ..geo import centroid, round_geometry, simplify_line
from ..model import Series, SourceResult, feature, point, title_case
from ..net import arcgis_query

log = logging.getLogger(__name__)

HOST = "https://services-eu1.arcgis.com/OZMfUznmLTnWccBc/arcgis/rest/services"
FIELDS = f"{HOST}/Offshore_hydrocarbon_fields_(WGS84)/FeatureServer/0"
SURFACE = f"{HOST}/UKCS%20offshore%20infrastructure%20surface%20points%20WGS84/FeatureServer/1"
PIPELINES = f"{HOST}/UKCS_offshore_infrastructure_pipeline_linear_(WGS84)/FeatureServer/1"
PPRS = f"{HOST}/UKCS_hydrocarbon_field_production_reports_PPRS_points_(WGS84)/FeatureServer/0"
FIRST_PERIOD = "201501"

OPS = "({col} LIKE '%SHELL%' OR {col} LIKE '%ADURA%')"
FIELD_PAGE = "https://www.nstauthority.co.uk/data-and-insights/"


def stake_of(org: str | None) -> str:
    org = (org or "").upper()
    if "ADURA" in org:
        return "jv"
    if "SHELL" in org:
        return "operated"
    return "partner"


def norm_field(name: str) -> str:
    """'LEMAN [SHELL][pt. of LEMAN]' -> 'LEMAN'; 'SCOTER (gas)' -> 'SCOTER'."""
    name = re.sub(r"\[.*?\]|\(.*?\)", "", name.upper())
    return re.sub(r"\s+", " ", name).strip()


def _fields(result: SourceResult) -> dict[str, dict]:
    lic_clause = " OR ".join(f"CURRLIC{'' if i == 1 else i} LIKE '%SHELL%'" for i in range(1, 21))
    where = f"{OPS.format(col='CURR_OPER')} OR {lic_clause}"
    out = {}
    for f in arcgis_query(FIELDS, where, precision=4, simplify=0.002):
        p = f["properties"]
        licensees = []
        for i in range(1, 21):
            name = p.get(f"CURRLIC{'' if i == 1 else i}")
            eq = p.get(f"EQUITY{'' if i == 1 else i}")
            if name:
                licensees.append({"name": title_case(name), "equity": eq})
        shell_eq = sum((l["equity"] or 0) for l in licensees if "SHELL" in (l["name"] or "").upper())
        adura_eq = sum((l["equity"] or 0) for l in licensees if "ADURA" in (l["name"] or "").upper())
        stake = stake_of(p.get("CURR_OPER"))
        if stake == "partner" and not shell_eq:
            continue
        key = norm_field(p["FIELDNAME"])
        rec = out.setdefault(key, {"geoms": [], "props": None})
        rec["geoms"].append(f["geometry"])
        rec["props"] = dict(
            id=f"uk-field-{re.sub(r'[^a-z0-9]+', '-', key.lower())}",
            name=title_case(p["FIELDNAME"]),
            kind="field",
            region="uk",
            country="United Kingdom",
            operator=title_case(p.get("CURR_OPER")),
            stake=stake,
            status=title_case(p.get("STATUS")),
            hydrocarbon=title_case(p.get("FIELDTYPE")),
            discovered=(p.get("DISC_DATE") or "")[:4] or None,
            first_production=(p.get("PROD_DATE") or "")[:4] or None,
            water_depth_m=round(float(p["DEPTH_M"])) if p.get("DEPTH_M") else None,
            shell_equity=round(shell_eq, 2) or None,
            adura_equity=round(adura_eq, 2) or None,
            licensees=licensees[:8],
            source="nsta",
            url=FIELD_PAGE,
        )
    return out


def build() -> SourceResult:
    result = SourceResult(
        key="nsta",
        title="NSTA Open Data — fields, surface infrastructure, pipelines, PPRS production",
        publisher="North Sea Transition Authority",
        url="https://open-data-ukcs-transition.hub.arcgis.com/",
        license="Open Government Licence v3.0",
    )

    # --- production (PPRS) --------------------------------------------------------------
    series: dict[str, Series] = {}
    where = f"{OPS.format(col='ORGGRPNM')} AND PERIODYRMN >= '{FIRST_PERIOD}'"
    out_fields = "FIELDNAME,ORGGRPNM,PERIODYRMN,OILPRODMBD,GCONDMBD,AGASPROMMS,DGASPROMMS"
    latest_org: dict[str, tuple[str, str]] = {}
    pprs_pts: dict[str, list[float]] = {}
    for f in arcgis_query(PPRS, where, out_fields, precision=4):
        p = f["properties"]
        key = norm_field(p["FIELDNAME"])
        ym = f"{p['PERIODYRMN'][:4]}-{p['PERIODYRMN'][4:6]}"
        oil = (p.get("OILPRODMBD") or 0) + (p.get("GCONDMBD") or 0)
        gas = (p.get("AGASPROMMS") or 0) + (p.get("DGASPROMMS") or 0)
        s = series.setdefault(key, Series(id=f"uk:{key}", name=title_case(key), region="uk", stake="operated"))
        s.add(ym, oil, gas)
        if key not in latest_org or ym > latest_org[key][0]:
            latest_org[key] = (ym, p["ORGGRPNM"])
        if f.get("geometry"):
            pprs_pts[key] = f["geometry"]["coordinates"]
    for key, s in series.items():
        s.stake = stake_of(latest_org[key][1])
    log.info("NSTA PPRS: %d Shell/Adura field series", len(series))

    # --- field polygons -----------------------------------------------------------------
    fields = _fields(result)
    for key, rec in fields.items():
        geoms = rec["geoms"]
        polys = []
        for g in geoms:
            if g["type"] == "Polygon":
                polys.append(g["coordinates"])
            elif g["type"] == "MultiPolygon":
                polys.extend(g["coordinates"])
        geom = round_geometry({"type": "MultiPolygon", "coordinates": polys}) if len(polys) != 1 else round_geometry(
            {"type": "Polygon", "coordinates": polys[0]}
        )
        props = rec["props"]
        if key in series:
            props["series"] = series[key].id
            if props["shell_equity"]:
                series[key].shell_share = props["shell_equity"] / 100
        c = centroid(geom)
        if c:
            props["center"] = [round(c[0], 4), round(c[1], 4)]
        result.areas.append(feature(geom, **props))

    # Production series with no polygon (e.g. sub-field allocations) still get a marker.
    for key, s in series.items():
        if key not in fields and key in pprs_pts:
            lon, lat = pprs_pts[key]
            result.assets.append(
                feature(point(lon, lat), id=f"uk-prod-{key.lower().replace(' ', '-')}", name=s.name, kind="field",
                        region="uk", country="United Kingdom", stake=s.stake, series=s.id, source="nsta", url=FIELD_PAGE)
            )

    # --- surface installations ----------------------------------------------------------
    where = f"{OPS.format(col='REP_GROUP')} AND STATUS='ACTIVE'"
    for f in arcgis_query(SURFACE, where, "NAME,INF_TYPE,REP_GROUP,DESCRIPTIO,PIPE_SYS,START_DATE", precision=5):
        p, g = f["properties"], f.get("geometry")
        if not g or p.get("INF_TYPE") in {"BUOY", "MONITOR BUOY", "FLARE STACK"}:
            continue
        hub = norm_field(re.sub(r"\b(PDQ|JACKET|FPSO|FSU|PLATFORM)\b.*", "", p["NAME"] or "").split(" ")[0])
        series_id = next((s.id for k, s in series.items() if k.split(" ")[0] == hub), None)
        start = p.get("START_DATE")
        result.assets.append(
            feature(
                point(*g["coordinates"][:2]),
                id=f"uk-inst-{re.sub(r'[^a-z0-9]+', '-', p['NAME'].lower())}",
                name=title_case(p["NAME"]),
                kind="platform",
                subtype=title_case(p.get("INF_TYPE")),
                region="uk",
                country="United Kingdom",
                operator=title_case(p.get("REP_GROUP")),
                stake=stake_of(p.get("REP_GROUP")),
                installed=(dt.datetime(1970, 1, 1) + dt.timedelta(milliseconds=start)).year if start else None,
                system=p.get("PIPE_SYS"),
                series=series_id,
                featured=p.get("INF_TYPE") in {"FPSO", "FSO"} or p["NAME"].upper() in {"SHEARWATER A", "NELSON A", "GANNET A", "JACKDAW"},
                source="nsta",
                url=FIELD_PAGE,
            )
        )

    # --- pipelines ----------------------------------------------------------------------
    where = f"{OPS.format(col='REP_GROUP')} AND STATUS='ACTIVE' AND INF_TYPE='PIPELINE'"
    seen_ids: dict[str, int] = {}
    for f in arcgis_query(PIPELINES, where, "NSTAPIPNO,PIPE_NAME,REP_GROUP,FLUID,DIAMETERMM,LENGTH_M", precision=5, simplify=0.0005):
        p, g = f["properties"], f.get("geometry")
        if not g:
            continue
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for i, part in enumerate(parts):
            coords = simplify_line([tuple(c[:2]) for c in part], tol=0.0005)
            if len(coords) < 2:
                continue
            # one pipeline number can span several records (sections), so number them
            n = seen_ids[p["NSTAPIPNO"]] = seen_ids.get(p["NSTAPIPNO"], -1) + 1
            result.lines.append(
                feature(
                    {"type": "LineString", "coordinates": coords},
                    id=f"uk-ppl-{p['NSTAPIPNO']}-{n}",
                    name=title_case(p.get("PIPE_NAME")),
                    region="uk",
                    stake=stake_of(p.get("REP_GROUP")),
                    product=title_case(p.get("FLUID")),
                    status="Active",
                    size_in=round(p["DIAMETERMM"] / 25.4) if p.get("DIAMETERMM") else None,
                    route=p.get("NSTAPIPNO"),
                    source="nsta",
                )
            )

    result.series = list(series.values())
    result.notes.append("Adura Energy is a 50/50 Shell–Equinor joint venture; its assets are shown as 'JV'.")
    return result
