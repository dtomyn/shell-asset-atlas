import math

from atlas.geo import metres_per_degree, simplify_3d
from atlas.sources import wells

# Real rows of BOEM's 5010delimit borehole file: a Perdido subsea well (Shell Offshore Inc.,
# complex 2008) and a Mobile Bay well of another operator.
BOREHOLES = (
    '"608054003301","SS002 ","ST00BP01","00689","AC857   ","20060606","G20870    ","00125","15625","15622","01477N06976W","AC 0856 ",'
    '"01553N07049W","AC 0856 ","20060610","20200801","E","04","PA ","07815","      -94.937470","       26.131684","      -94.937246",'
    '"       26.131477","G20870    ","2008   ","1 ","20200814","STR"\n'
    '"012032016500","  001 ","ST00BP00","00276","WILD    ","19840924","S00538    ","00099","21678","21675","03707N07080W","MO 0827 ",'
    '"03580N07118W","MO 0827 ","19850310","19930309","E","01","COM","00045","      -87.958630","       30.188450","      -87.958515",'
    '"       30.188800","S00538    ","2134   ","1 ","20191216","STR"\n'
)
# Real rows of dsptsdelimit for that Perdido well, and one row of another borehole.
SURVEY = (
    '"177000000600","                  0","                 0","            5000","N","                  0","                  0","E","            5000","                  0","                  0","         -93.599295","          29.691138"\n'
    '"608054003301","                  0","                 0","               0","N","                  0","                  0","E","               0","                  0","                  0","          -94.93747","          26.131684"\n'
    '"608054003301","                  0","                 0","            7940","N","                  0","                  0","E","            7940","                  0","                  0","          -94.93747","          26.131684"\n'
    '"608054003301","                  0","                39","            8322","S","                 57","                  8","W","            8322","           -.000006","           -.000003","         -94.937475","          26.131681"\n'
    '"608054003301","                  1","                14","           15625","N","                 75","                 19","E","           15622","            .000224","           -.000207","         -94.937246","          26.131477"\n'
)


def test_min_curvature_vertical_well():
    path = wells.min_curvature([(0, 0, 0), (1000, 0, 0), (5000, 0, 137)])
    assert path[-1] == (0.0, 0.0, 5000.0)
    assert [p[2] for p in path] == [0.0, 1000.0, 5000.0]


def test_min_curvature_constant_inclination():
    # 30 degrees from vertical, heading due east, for 1,000 units of measured depth.
    e, n, v = wells.min_curvature([(2000, 30, 90), (2400, 30, 90), (3000, 30, 90)])[-1]
    assert math.isclose(e, 500.0, abs_tol=1e-9) and math.isclose(n, 0.0, abs_tol=1e-9)
    assert math.isclose(v, 1000 * math.cos(math.radians(30)), abs_tol=1e-9)
    # ...and heading south-west: the same throw split evenly between south and west.
    e, n, v = wells.min_curvature([(0, 30, 225), (1000, 30, 225)])[-1]
    assert math.isclose(e, -500 / math.sqrt(2), abs_tol=1e-9) and math.isclose(n, e, abs_tol=1e-9)


def test_min_curvature_build_section_is_a_circular_arc():
    # Vertical to horizontal (heading north) on a constant radius R: the arc is R*pi/2 long and
    # ends R down and R north. Minimum curvature is exact for this, in one step or in nine.
    R = 1000.0
    one = wells.min_curvature([(0, 0, 0), (R * math.pi / 2, 90, 0)])[-1]
    nine = wells.min_curvature([(R * math.radians(a), a, 0) for a in range(0, 91, 10)])[-1]
    for e, n, v in (one, nine):
        assert math.isclose(n, R, rel_tol=1e-9) and math.isclose(v, R, rel_tol=1e-9) and abs(e) < 1e-9


def test_quadrant_bearing_to_azimuth():
    assert wells.azimuth("N", 30, 0, "E") == 30
    assert wells.azimuth("S", 30, 0, "E") == 150
    assert wells.azimuth("S", 57, 8, "W") == 180 + 57 + 8 / 60
    assert wells.azimuth("N", 30, 30, "W") == 329.5
    assert wells.azimuth("N", 0, 0, "W") == 0


def test_boreholes_parse_and_filter():
    bores = wells.parse_boreholes(BOREHOLES)
    b = bores[0]
    assert (b["api"], b["op"], b["field"], b["complex"], b["status"], b["type"]) == ("608054003301", "00689", "AC857", "2008", "PA", "E")
    assert (b["name"], b["spud"], b["md_ft"], b["tvd_ft"], b["rkb_ft"], b["wd_ft"]) == ("SS002 ST00BP01", "2006-06-06", 15625, 15622, 125, 7815)
    assert (b["lon"], b["lat"], b["blon"], b["blat"]) == (-94.93747, 26.131684, -94.937246, 26.131477)
    # Only Shell operator numbers, only deepwater, only holes that were drilled.
    assert [x["api"] for x in wells.select(bores)] == ["608054003301"]
    assert wells.select([{**b, "wd_ft": 600}]) == [] and wells.select([{**b, "md_ft": None}]) == [] and wells.select([{**b, "op": "00078"}]) == []


def test_survey_rows_are_filtered_by_api():
    rows = list(wells.iter_survey(SURVEY.splitlines(), {"608054003301"}))
    assert len(rows) == 4 and {api for api, _ in rows} == {"608054003301"}
    md, inc, az, tvd, dlon, dlat = rows[2][1]
    assert (md, tvd, dlon, dlat) == (8322, 8322, -0.000006, -0.000003)
    assert math.isclose(inc, 39 / 60) and math.isclose(az, 237 + 8 / 60)
    assert list(wells.iter_survey(SURVEY.splitlines(), set())) == []


def test_surveyed_path_is_below_sea_level_in_metres():
    b = wells.parse_boreholes(BOREHOLES)[0]
    stations = [st for _, st in wells.iter_survey(SURVEY.splitlines(), {b["api"]})]
    w = wells.well_record(b, stations, 14173)
    assert w["sv"] == 1 and w["path"][:3] == [0, 0, 0]
    assert w["wd"] == round(7815 * 0.3048) and w["md"] == round(15625 * 0.3048)
    assert w["tvd"] == round((15622 - 125) * 0.3048)  # the kelly bushing is 125 ft above the sea
    assert w["drilled"] == round((15625 - 14173) * 0.3048)  # a bypass: only the hole below its kick-off
    # BOEM's own offsets place the bottom of the hole on the reported bottom-hole location.
    mx, my = metres_per_degree(b["lat"])
    assert abs(w["path"][-3] - (b["blon"] - b["lon"]) * mx) <= 1 and abs(w["path"][-2] - (b["blat"] - b["lat"]) * my) <= 1
    # The check used in build(): minimum-curvature depth agrees with BOEM's to within a few feet.
    st = wells.clean_stations(stations)
    assert abs(wells.min_curvature([s[:3] for s in st])[-1][2] - st[-1][3]) < 3


def test_no_survey_gives_a_flagged_schematic():
    b = wells.parse_boreholes(BOREHOLES)[0]
    w = wells.well_record(b, None, None)
    assert w["sv"] == 0 and len(w["path"]) == 9
    assert w["path"][:6] == [0, 0, 0, 0, 0, round(7815 * 0.3048)]  # surface, then the seabed straight below
    assert w["path"][-1] == round((15622 - 125) * 0.3048)
    assert wells.well_record({**b, "blat": None}, None, None) is None  # nothing to draw it from


def test_drilled_length_rule():
    b = {"md_ft": 15000.0, "wd_ft": 7800.0, "rkb_ft": 100.0, "suffix": "ST00BP00"}
    assert wells.drilled_ft(b, None) == 7100  # original hole: from the seabed, not from the rig floor
    assert wells.drilled_ft({**b, "suffix": "ST01BP00"}, 12000) == 3000  # sidetrack: from its kick-off
    assert wells.drilled_ft({**b, "suffix": "ST01BP00"}, None) is None  # unknown, so not double counted


def test_simplify_3d():
    line = [(0.0, 0.0, float(z)) for z in range(0, 1001, 100)]
    assert simplify_3d(line, 1.0) == [line[0], line[-1]]
    bend = line + [(float(x), 0.0, 1000.0) for x in range(100, 1001, 100)]
    assert simplify_3d(bend, 1.0) == [(0.0, 0.0, 0.0), (0.0, 0.0, 1000.0), (1000.0, 0.0, 1000.0)]
    # A helix cannot be flattened: every dropped point stays within the tolerance of the result.
    helix = [(100 * math.cos(t / 5), 100 * math.sin(t / 5), 10.0 * t) for t in range(200)]
    out = simplify_3d(helix, 5.0)
    assert out[0] == helix[0] and out[-1] == helix[-1] and len(out) < len(helix)
    from atlas.geo import _seg_dist3

    assert all(min(_seg_dist3(p, a, b) for a, b in zip(out, out[1:])) <= 5.0 + 1e-9 for p in helix)
    capped = simplify_3d(helix, 5.0, max_points=12)
    assert 2 <= len(capped) <= 12 and capped[0] == helix[0] and capped[-1] == helix[-1]


def _well(api, complex_id, field, lon, lat, **kw):
    return {"api": api, "name": api, "field": field, "complex": complex_id, "status": "COM", "type": "D", "spud": "2010-01-01", "lon": lon, "lat": lat,
            "wd": 900, "md": 5000, "tvd": 4000, "drilled": 4000, "sv": 1, "path": [0, 0, 0, 0, 0, 900, 300, 400, 4000], **kw}


def _hub(cid, name, lon, lat, field, depth=900, featured=True):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"id": f"gom-{cid}", "name": name, "region": "gom", "featured": featured, "field": field, "water_depth_m": depth}}


def test_wells_are_tied_to_hubs_by_complex_then_field():
    hubs = [_hub("24199", "Mars A", -89.22, 28.17, "MC807"), _hub("2385", "Olympus B", -89.24, 28.16, "MC807"), _hub("9", "Shelf", -90, 29, "SS1", featured=False)]
    ws = [
        _well("a", "24199", "MC807", -89.22, 28.17),  # BOEM lists Mars as its complex
        _well("b", "2385", "MC935", -89.30, 28.10),  # tied back to Olympus from another field
        _well("c", "", "MC807", -89.239, 28.161, sv=0, drilled=None),  # no complex: field code, nearer hub
        _well("d", "", "MC999", -89.22, 28.17),  # no complex, another field: left out
        _well("e", "777", "MC807", -89.22, 28.17),  # belongs to some other complex: left out
        _well("f", "9", "SS1", -90, 29),  # its hub is not a featured deepwater hub
    ]
    data, summary = wells.bundle({"wells": ws, "depths": [[-89.22, 28.17, 880], [-89.5, 28.4, 1500]]}, hubs)
    assert set(data["hubs"]) == {"gom-24199", "gom-2385"} == set(summary)
    assert [(w["api"], w["tie"]) for w in data["hubs"]["gom-24199"]["wells"]] == [("a", "host")]
    oly = data["hubs"]["gom-2385"]
    assert sorted((w["api"], w["tie"]) for w in oly["wells"]) == [("b", "host"), ("c", "field")]
    assert oly["stats"] == {"wells": 2, "surveyed": 1, "schematic": 1, "by_field_code": 1, "beyond_window": 0, "deepest_tvd_m": 4000,
                            "deepest_well": "b", "drilled_m": 4000, "drilled_unknown": 1}
    # Paths are moved into the hub's frame: well "b" starts about 5.9 km west and 6.6 km south of Olympus.
    b = next(w for w in oly["wells"] if w["api"] == "b")
    assert -6000 < b["path"][0] < -5800 and -6800 < b["path"][1] < -6500 and b["path"][2] == 0
    assert b["path"][-3] - b["path"][0] == 300 and b["path"][-1] == 4000
    assert oly["radius_m"] >= 1.15 * 6600 and oly["radius_m"] % 500 == 0
    assert len(oly["seabed"]["depth"]) == oly["seabed"]["n"] ** 2
    assert wells.bundle({}, hubs) == ({**data, "hubs": {}, "method": {**data["method"], "check": None}}, {})


def test_seabed_grid_from_control_points():
    flat = wells.seabed_grid([(0, 0, 1200.0), (3000, -2000, 1200.0), (-4000, 4000, 1200.0)], 5000, n=5)
    assert flat == [1200] * 25
    # A slope: deeper to the east. The grid is row by row from the south-west corner.
    pts = [(x, y, 1000.0 + x / 10) for x in range(-5000, 5001, 1000) for y in range(-5000, 5001, 1000)]
    g = wells.seabed_grid(pts, 5000, n=5)
    assert g[0] < g[2] < g[4] and abs(g[2] - 1000) <= 20 and abs(g[0] - g[20]) <= 5
    assert 500 <= g[0] < 650 and 1350 < g[4] <= 1500  # softened, so the edges are a little shy of the true 500 and 1,500
