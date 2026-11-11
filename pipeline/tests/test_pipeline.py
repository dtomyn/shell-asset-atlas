from atlas.build import month_range, production_bundle
from atlas.geo import line_length_km, simplify_line
from atlas.model import Series, kboed, title_case
from atlas.sources.gom import _parse_platloc, _parse_platmast, _platform_name
from atlas.sources.uk import norm_field, stake_of

PLATLOC = """\
  1   24199  1MC   807       A (Mars)  3630N  5653W           924373         10229010    -89.222876    28.169524
  4   90100  1AC    24       SSMANIFO                                                  -94.76940277  26.95505833
"""
PLATMAST = (
    "    2385NYYN  52YNYY00689YY G0796322-MAY-2023YNYNY 3028NN  Y 1PYYBYYY   MC807  1 3YN192MC   807Y\n"
    "    2689NYNN     YY 00689YY G3649915-OCT-2026Y Y N 8600NN  N 0PYYGYYY    WILD  4 2YN 62AC   773Y\n"
)


def test_platloc_parses_names_and_coords():
    loc = _parse_platloc(PLATLOC)
    assert loc["24199"]["raw"] == "A (Mars)"
    assert loc["24199"]["lon"] == -89.222876 and loc["24199"]["lat"] == 28.169524
    assert loc["90100"]["raw"] == "SSMANIFO"


def test_platmast_operator_depth_field():
    m = _parse_platmast(PLATMAST)
    assert m["2385"] == {"operator": "00689", "water_depth_ft": 3028, "field": "MC807"}
    assert m["2689"]["water_depth_ft"] == 8600 and m["2689"]["field"] == "WILD"


def test_platform_name():
    assert _platform_name("A (Mars)", "MC", "807") == ("Mars A", "Mars")
    assert _platform_name("SSMANIFO", "AC", "24") == ("AC 24 SSMANIFO", None)


def test_uk_helpers():
    assert norm_field("LEMAN [SHELL][pt. of LEMAN]") == "LEMAN"
    assert norm_field("SCOTER (gas)") == "SCOTER"
    assert stake_of("ADURA ENERGY") == "jv" and stake_of("SHELL PLC") == "operated" and stake_of("BP") == "partner"


def test_units():
    assert kboed(10, 58) == 20  # 58 MMscf/d ≈ 10 kboe/d
    assert title_case("PENGUINS FPSO") == "Penguins FPSO"


def test_simplify_keeps_endpoints_and_drops_collinear():
    line = [(0, 0), (1, 0.00001), (2, 0), (3, 1)]
    out = simplify_line(line, tol=0.001)
    assert out[0] == [0, 0] and out[-1] == [3, 1] and [1, 0.00001] not in out
    assert 110 < line_length_km([[0, 0], [1, 0]]) < 112


def test_production_bundle_aligns_months_and_totals():
    a = Series("gom:X", "X", "gom", "operated", {"2024-01": (10.0, 0.0), "2024-03": (20.0, 0.0)})
    b = Series("no:Y", "Y", "no", "partner", {"2024-02": (0.0, 58.0)}, shell_share=0.5)
    p = production_bundle([a, b])
    assert p["months"] == month_range("2024-01", "2024-03") == ["2024-01", "2024-02", "2024-03"]
    assert p["series"]["gom:X"]["oil"] == [10.0, 0.0, 20.0]
    assert p["series"]["no:Y"]["start"] == 1
    assert p["totals"]["no"]["net"][1] == 5.0
    assert p["totals"]["gom:operated"]["gross"] == [10.0, 0.0, 20.0]
