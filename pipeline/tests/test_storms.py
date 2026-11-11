from atlas.build import month_range
from atlas.sources import storms, storms_live

# Real HURDAT2 records (two Idas: 2009, before the timeline, and 2021), not every line of either storm.
HURDAT = """\
AL112009,                IDA,     31,
20091104, 0600,  , TD, 11.0N,  81.3W,  30, 1007,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0, -999
20091104, 1200,  , TS, 11.4N,  81.8W,  35, 1004,   30,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0,    0, -999
AL092021,                IDA,     40,
20210828, 1800,  , HU, 25.6N,  86.6W,  80,  976,  110,  100,   70,  100,   50,   40,   20,   40,   25,   20,   10,   20,   20
20210829, 0600,  , HU, 27.6N,  88.7W, 115,  950,  120,  100,   80,  110,   70,   60,   40,   60,   35,   30,   20,   30,   15
20210829, 1200,  , HU, 28.5N,  89.6W, 130,  929,  130,  110,   80,  110,   70,   60,   40,   60,   45,   35,   20,   30,   10
20210829, 1655, L, HU, 29.1N,  90.2W, 130,  931,  130,  110,   80,  110,   70,   60,   40,   60,   45,   35,   20,   30,   10
20210830, 1200,  , TS, 31.5N,  90.9W,  40,  992,   50,  160,   60,   30,    0,    0,    0,    0,    0,    0,    0,    0,   40
"""
MARS = (-89.2229, 28.1695)


def _hub(lon, lat, series=None, region="gom"):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {"id": f"h{lon}", "region": region, "series": series}}


def _prod(months, **series):
    return {"months": months, "series": {k: {"name": k, "start": 0, "oil": v, "gas": [0.0] * len(v)} for k, v in series.items()}}


def test_hurdat2_parse_and_url():
    out = storms.parse_hurdat2(HURDAT)
    assert [s["id"] for s in out] == ["AL092021"]  # the 2009 storm is before the timeline
    ida = out[0]
    assert ida["name"] == "Ida" and ida["year"] == 2021 and len(ida["track"]) == 5
    t, lat, lon, kt, status = ida["track"][3]
    assert (lat, lon, kt, status) == (29.1, -90.2, 130, "HU")
    assert t == 27170935  # 2021-08-29 16:55 UTC in minutes since the epoch
    assert storms.peak_kt(ida) == 130 and storms.enters_gulf(ida)
    html = (
        '<a href="/data/hurdat/hurdat2-1851-2024-040425.txt">x</a> <a href="/data/hurdat/hurdat2-1851-2025-092326.txt">y</a>'
        ' <a href="/data/hurdat/hurdat2-nepac-1949-2025-092926.txt">z</a>'
    )
    assert storms.find_hurdat_url(html) == "https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2025-092326.txt"
    assert storms.find_hurdat_url("<html></html>") is None


def test_closest_approach_measures_to_the_segment_and_needs_storm_strength():
    track = storms.parse_hurdat2(HURDAT)[0]["track"]
    km, when, kt = storms.closest_approach(track, *MARS)
    # Mars lies between two best-track points about 130 km apart; either point alone is 50+ km off
    assert km < 30 and 115 <= kt <= 130
    assert track[1][0] < when < track[2][0]
    weak = [[p[0], p[1], p[2], 30, "TD"] for p in track]
    assert storms.closest_approach(weak, *MARS) is None
    post = [[p[0], p[1], p[2], 60, "EX"] for p in track]
    assert storms.closest_approach(post, *MARS) is None


def test_storm_filter_keeps_only_tracks_near_shell_structures():
    ida = storms.parse_hurdat2(HURDAT)[0]
    far = {"id": "AL992021", "name": "Far", "year": 2021, "track": [[p[0], p[1], p[2] + 8, p[3], p[4]] for p in ida["track"]]}
    weak = {"id": "AL982021", "name": "Weak", "year": 2021, "track": [[p[0], p[1], p[2], 25, "TD"] for p in ida["track"]]}
    months = month_range("2021-01", "2021-12")
    prod = _prod(months, **{"gom:X": [100.0] * 7 + [50.0, 0.0, 100.0, 100.0, 100.0]})
    assets = [_hub(*MARS, series="gom:X"), _hub(-94.9, 26.1), _hub(-81.3, 28.2, region="uk")]
    out = storms.bundle([far, weak, ida], assets, prod, through=2021)
    assert [s["id"] for s in out["storms"]] == ["AL092021"]
    s = out["storms"][0]
    assert s["structures"] == 1 and s["month"] == "2021-08" and s["peak_kt"] == 130 and len(s["track"]) == 5
    hub = s["hubs"][0]
    assert hub["series"] == "gom:X" and hub["month"] == "2021-08" and hub["months"] == 2 and hub["recovered"]
    assert hub["deferred_mboe"] == s["deferred_mboe"] == round((50 * 31 + 100 * 30) / 1000, 2)
    assert s["months"] == 2 and s["recovered"] is True and out["method"]["radius_km"] == 150


def test_impact_baseline_deferred_and_months():
    days = [30] * 12
    # baseline 100; storm month at 40, then 70, then back to 95
    est = storms.impact([100, 100, 100, 40, 70, 95, 100, 100, 100, 100, 100, 100], days, 3)
    assert est == {"baseline": 100.0, "low": 40.0, "deferred_mboe": round((60 + 30) * 30 / 1000, 2), "months": 2, "recovered": True}
    # a storm late in the month: the dip shows in the month after
    late = storms.impact([100, 100, 100, 97, 20, 100, 100, 100, 100, 100, 100, 100], days, 3)
    assert late["months"] == 2 and late["deferred_mboe"] == round((3 + 80) * 30 / 1000, 2)
    # data runs out before recovery: kept, flagged as not recovered
    open_end = storms.impact([100, 100, 100, 40, 50, None], days[:6], 3)
    assert open_end["months"] == 2 and open_end["recovered"] is False


def test_impact_skips_what_is_not_storm_shaped():
    days = [30] * 20
    assert storms.impact([100.0] * 20, days, 5) is None  # no dip
    assert storms.impact([100, 100, 100, 95, 92, 100] + [100.0] * 14, days, 3) is None  # within 90%
    assert storms.impact([100, 100, 5, 5], days, 2) is None  # no 3-month baseline
    assert storms.impact([0.5, 0.5, 0.5, 0.1, 0.5], days, 3) is None  # hub barely producing
    noisy = [100, 60, 130, 70, 120, 80, 75, 110]
    assert storms.impact(noisy, days, 6) is None  # a dip inside the usual month-to-month swing
    decline = [100, 100, 100, 85, 80, 60, 50, 40, 30, 20, 10, 5, 5, 5, 5, 5, 5, 5, 5, 5]
    assert storms.impact(decline, days, 3) is None  # keeps making new lows
    never = [100, 100, 100] + [50.0] * 17
    assert storms.impact(never, days, 3) is None  # still down after 12 months
    # an earlier one-month outage must not hide a real dip (robust noise)
    assert storms.impact([100, 100, 10, 100, 100, 100, 70, 100], days, 6)["deferred_mboe"] == 0.9


def test_attribution_never_counts_a_month_twice():
    days = [30] * 12
    vals = [100, 100, 100, 40, 70, 95, 100, 100, 100, 100, 100, 100]
    # same month: the stronger pass carries the estimate
    same = storms.attribute(vals, days, [{"storm": "A", "km": 10, "kt": 50, "m": 3}, {"storm": "B", "km": 90, "kt": 100, "m": 3}])
    by = {h["storm"]: h for h in same}
    assert by["B"]["deferred_mboe"] == 2.7 and by["A"] == {"storm": "A", "km": 10, "kt": 50, "m": 3, "shared_with": "B"}
    # a weaker storm before recovery is folded into the first
    fold = {h["storm"]: h for h in storms.attribute(vals, days, [{"storm": "A", "km": 10, "kt": 100, "m": 3}, {"storm": "B", "km": 10, "kt": 50, "m": 4}])}
    assert fold["A"]["months"] == 2 and fold["B"]["shared_with"] == "A"
    # a stronger one takes over: the first storm's count stops there
    vals2 = [100, 100, 100, 70, 10, 95, 100, 100, 100, 100, 100, 100]
    take = {h["storm"]: h for h in storms.attribute(vals2, days, [{"storm": "A", "km": 10, "kt": 50, "m": 3}, {"storm": "B", "km": 10, "kt": 100, "m": 4}])}
    assert take["A"]["months"] == 1 and take["A"]["recovered"] is False and take["A"]["deferred_mboe"] == 0.9
    assert take["B"]["months"] == 1 and "shared_with" not in take["B"]
    # each month is claimed once, so the total cannot exceed the shortfall against the first baseline
    assert sum(h.get("deferred_mboe", 0) for h in take.values()) <= (30 + 90) * 30 / 1000


TRACK_KML = """<Folder><Placemark><LineString><coordinates> -88.0,25.0,0 -89.0,27.0,0 </coordinates></LineString></Placemark>
<Placemark><LineString> <coordinates>  -88.0,25.0,0 -89.0,27.0,0 -90.0,29.0,0 -90.5,31.0,0 </coordinates> </LineString></Placemark>
<Placemark><Point><coordinates>-88.0,25.0,0</coordinates></Point></Placemark></Folder>"""
CONE_KML = """<Placemark><Polygon><outerBoundaryIs><LinearRing>
<coordinates>-88.5,25.0,0 -87.5,25.0,0 -88.0,29.0,0 -89.25,31.5,0 -91.75,31.5,0 -91.0,29.0,0 -88.5,25.0,0</coordinates>
</LinearRing></outerBoundaryIs></Polygon></Placemark>"""


def test_live_feed_parsing():
    assert storms_live.parse_track_kml(TRACK_KML) == [[-88.0, 25.0], [-89.0, 27.0], [-90.0, 29.0], [-90.5, 31.0]]
    cone = storms_live.parse_cone_kml(CONE_KML)
    assert cone[0] == cone[-1] == [-88.5, 25.0] and len(cone) == 7
    assert storms_live.parse_track_kml(TRACK_KML.replace("-88.0", "272.0"))[0] == [-88.0, 25.0]  # 0-360 longitudes
    assert storms_live.parse_track_kml("<kml/>") is None and storms_live.parse_cone_kml("<kml/>") is None
    feed = {
        "activeStorms": [
            {"id": "cp042026", "name": "Pena", "classification": "TS", "intensity": "40"},
            {
                "id": "al092021", "name": "Ida", "classification": "HU", "intensity": "130", "pressure": "930",
                "latitudeNumeric": 28.5, "longitudeNumeric": -89.6, "lastUpdate": "2021-08-29T12:00:00.000Z",
                "publicAdvisory": {"advNum": "013", "url": "https://www.nhc.noaa.gov/text/MIATCPAT4.shtml"},
            },
        ]
    }
    systems = [storms_live.normalise(s, graphics=False) for s in storms_live.atlantic(feed)]
    assert systems == [
        {
            "id": "AL092021", "name": "Ida", "classification": "HU", "wind_kt": 130, "pressure_mb": 930, "lon": -89.6, "lat": 28.5,
            "updated": "2021-08-29T12:00:00.000Z", "advisory": "013", "url": "https://www.nhc.noaa.gov/text/MIATCPAT4.shtml",
        }
    ]
    assert storms_live.atlantic({"activeStorms": []}) == [] and storms_live.atlantic({}) == []
