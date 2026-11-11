import datetime as dt

from atlas import peers
from atlas.build import month_range
from atlas.model import kboed

# Two real lines of BOEM's fixed-width lease file: a shelf lease off Texas and Mars (MC 807).
LEASES = (
    " 00008         L           1957110642706          194711071019561030R 1/812.5000000      1440.000000   1440.000000    3.00"
    "                              56   63AWGM   4   RELINQ19561030\n"
    "G07963         L98         1995063060817  7963    1985070110        R 1/812.5000000      5760.000000   5760.000000    3.00"
    "   1187000.00       206.08  2920 3326ACGM   1   UNIT  20130814\n"
)


def _basin(first, **ops):
    n = len(next(iter(ops.values())))
    return {
        "first": first,
        "last": month_range(first, "2099-12")[n - 1],
        "operators": [{"id": k, "name": k.title(), "entities": [k.upper()], "v": v} for k, v in ops.items()],
        "unattributed": [0.0] * n,
    }


def test_entities_group_shell_and_keep_adura_apart():
    assert peers.group_of("gom", "00689", "SHELL OFFSHORE INC.") == ("shell", "Shell")
    assert peers.group_of("gom", "02117", "SHELL GULF OF MEXICO INC") == ("shell", "Shell")
    assert peers.group_of("gom", "02481", "BP EXPLORATION & PRODUCTION INC") == ("bp", "bp")
    assert peers.group_of("gom", "00003", "UNION OIL COMPANY OF CALIFORNIA")[0] == peers.group_of("gom", "00078", "CHEVRON USA INC")[0]
    assert peers.group_of("uk", "SHELL PLC", "SHELL PLC")[0] == "shell"
    assert peers.group_of("uk", "ADURA ENERGY", "ADURA ENERGY") == ("adura", "Adura (Shell/Equinor JV)")
    assert peers.group_of("no", "A/S Norske Shell", "A/S Norske Shell")[0] == "shell"
    # ownership that changed during the timeline is not merged into the new parent
    assert peers.group_of("gom", "00059", "HESS CORPORATION")[0] != "chevron"
    assert peers.group_of("no", "BG Norge AS", "BG Norge AS")[0] != "shell"
    # every group id has one display name
    names = {}
    for _, _, gid, name in peers.ENTITIES:
        assert names.setdefault(gid, name) == name


def test_unlisted_entities_stay_alone_under_the_regulator_name():
    assert peers.group_of("gom", "02628", "ARENA OFFSHORE LP") == ("boem-02628", "Arena Offshore")
    assert peers.group_of("uk", "ITHACA ENERGY", "ITHACA ENERGY") == ("ithaca-energy", "Ithaca Energy")
    assert peers.group_of("no", "Sval Energi AS", "Sval Energi AS") == ("sval-energi-as", "Sval Energi")
    assert peers.tidy_name("HARBOUR ENERGY PLC") == "Harbour Energy"


def test_tally_sums_grouped_entities_by_month():
    t = peers.Tally("gom")
    t.add("00689", "SHELL OFFSHORE INC.", "2024-01", 100.0)
    t.add("02117", "SHELL GULF OF MEXICO INC", "2024-01", 20.0)
    t.add("00689", "SHELL OFFSHORE INC.", "2024-03", 90.0)
    t.add("02481", "BP EXPLORATION & PRODUCTION INC", "2024-02", 50.0)
    t.add(None, None, "2024-02", 1.5)
    d = t.dump()
    assert (d["first"], d["last"]) == ("2024-01", "2024-03")
    ops = {o["id"]: o for o in d["operators"]}
    assert ops["shell"]["v"] == [120.0, 0.0, 90.0]
    assert ops["shell"]["entities"] == ["SHELL GULF OF MEXICO INC", "SHELL OFFSHORE INC."]
    assert ops["bp"]["v"] == [0.0, 50.0, 0.0]
    assert d["unattributed"] == [0.0, 1.5, 0.0]


def test_uk_row_uses_pprs_rates_and_boe():
    t = peers.Tally("uk")
    peers.uk_row(t, {"ORGGRPNM": "SHELL PLC", "PERIODYRMN": "202512", "OILPRODMBD": 4.0, "GCONDMBD": 1.0, "AGASPROMMS": 29.0, "DGASPROMMS": None})
    peers.uk_row(t, {"ORGGRPNM": "ADURA ENERGY", "PERIODYRMN": "202512", "OILPRODMBD": 7.0, "GCONDMBD": 0, "AGASPROMMS": 0, "DGASPROMMS": 0})
    assert t.ops["shell"]["months"]["2025-12"] == kboed(5.0, 29.0) == 10.0
    assert t.ops["adura"]["months"]["2025-12"] == 7.0  # the joint venture is its own operator


def test_norway_operator_follows_the_history():
    hist = [(dt.date(1988, 12, 19), dt.date(2018, 11, 29), "A/S Norske Shell"), (dt.date(2018, 11, 30), None, "OKEA ASA")]
    assert peers.operator_at(hist, dt.date(2018, 11, 15)) == "A/S Norske Shell"
    assert peers.operator_at(hist, dt.date(2018, 12, 15)) == "OKEA ASA"
    assert peers.operator_at(hist, dt.date(1980, 1, 15)) is None
    assert peers.operator_at([], dt.date(2020, 1, 15)) is None


def test_lease_depths_and_deepwater_line():
    d = peers.parse_lease_depths(LEASES)
    assert d == {"00008": (56, 63), "G07963": (2920, 3326)}
    assert peers.is_deepwater(d["G07963"]) and not peers.is_deepwater(d["00008"])
    assert peers.is_deepwater((1000, 1200)) and not peers.is_deepwater((900, 1500)) and not peers.is_deepwater(None)


def test_rank_orders_and_drops_non_producers():
    assert peers.rank({"a": 5.0, "shell": 9.0, "b": 0.0, "c": 5.0}) == [("shell", 9.0), ("a", 5.0), ("c", 5.0)]


def test_keep_makes_the_focus_rank_exact():
    series = {"a": [9.0, 1.0], "b": [8.0, 0.0], "c": [7.0, 0.0], "shell": [1.0, 5.0], "d": [0.5, 0.2]}
    # top 1 only: 'a' leads month 1, shell leads month 2; b and c beat shell in month 1, d never does
    assert peers.keep(series, top_n=1) == {"a", "b", "c", "shell"}
    assert peers.keep(series, top_n=5) == set(series)


def test_bundle_aligns_to_timeline_and_keeps_totals():
    months = month_range("2024-01", "2024-06")
    extra = {
        "basins": {
            # starts before the timeline and stops two months short of it
            "gom": _basin("2023-12", shell=[50.0, 60.0, 70.0, 0.0, 80.0], bp=[90.0, 40.0, 75.0, 30.0, 0.0], tiny=[1.0, 1.0, 1.0, 1.0, 1.0], gone=[5.0, 0.0, 0.0, 0.0, 0.0]),
            "uk": _basin("2024-03", shell=[10.0, 2.0], adura=[0.0, 9.0], big=[30.0, 30.0]),
        }
    }
    out = peers.bundle(extra, months, top_n=2)
    assert out["months"] == months and [b["id"] for b in out["basins"]] == ["gom", "uk"]
    g = out["basins"][0]
    assert g["through"] == "2024-04"
    assert g["total"] == [101.0, 146.0, 31.0, 81.0, None, None]
    assert g["n"] == [3, 3, 2, 2, None, None]
    ops = {o["id"]: o for o in g["operators"]}
    assert set(ops) == {"shell", "bp", "tiny"}  # 'tiny' is second in March and April; 'gone' has nothing in range
    assert ops["shell"]["focus"] == "shell" and ops["shell"]["start"] == 0 and ops["shell"]["v"] == [60.0, 70.0, 0.0, 80.0]
    assert ops["bp"]["v"] == [40.0, 75.0, 30.0]  # trailing zero trimmed
    u = out["basins"][1]
    assert u["total"] == [None, None, 40.0, 41.0, None, None]
    ops = {o["id"]: o for o in u["operators"]}
    assert ops["adura"]["focus"] == "jv" and ops["adura"]["start"] == 3 and ops["adura"]["v"] == [9.0]
    # Shell's rank in April: behind the big operator and the joint venture
    april = peers.rank({k: (o["v"][3 - o["start"]] if 0 <= 3 - o["start"] < len(o["v"]) else 0.0) for k, o in ops.items()})
    assert [k for k, _ in april] == ["big", "adura", "shell"]


def test_bundle_without_data_is_empty():
    assert peers.bundle({}, ["2024-01"])["basins"] == []


def test_one_regulator_down_reuses_its_last_snapshot(monkeypatch):
    def down():
        raise RuntimeError("503")

    old = {"uk": _basin("2024-01", shell=[1.0]), "gom": _basin("2024-01", shell=[2.0]), "gom_deep": _basin("2024-01", shell=[2.0])}
    monkeypatch.setattr(peers, "_previous", lambda: old)
    monkeypatch.setattr(peers, "_gulf", lambda: {"gom": _basin("2024-02", shell=[3.0])})
    monkeypatch.setattr(peers, "_uk", down)
    monkeypatch.setattr(peers, "_norway", lambda: {"no": _basin("2024-02", shell=[4.0])})
    r = peers.build()
    b = r.extra["basins"]
    assert set(b) == {"gom", "uk", "no"}  # a fresh Gulf result replaces the old one, deepwater cut included
    assert b["uk"]["stale"] is True and b["uk"]["first"] == "2024-01" and "stale" not in b["gom"]
    assert any("UK reused from the last good snapshot" in n for n in r.notes)
    assert peers.bundle(r.extra, ["2024-01", "2024-02"])["basins"][1]["stale"] is True

    monkeypatch.setattr(peers, "_gulf", down)
    monkeypatch.setattr(peers, "_norway", down)
    try:
        peers.build()
        raise AssertionError("expected a failure when every regulator is down")
    except RuntimeError:
        pass  # build.py then falls back to the whole snapshot and marks the source stale
