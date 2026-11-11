"""The explainer's story: what is said, what the cursor does, and in what order.

Each scene is plain code against the Film in render.py:

  f.chapter(id, title, shows, camera, sound)   starts a chapter (YouTube chapter, storyboard section)
  f.say(id, text)                              queues a narrated line; its length sets the timing
  f.wait_voice()                               runs the film until everything queued has been said
  f.click(selector) / f.move(...) / f.key(...) / f.type(...) / f.wheel(...) / f.drag(...)   real input on the real page
  f.run(ms)                                    lets the film run
  f.speed(rate)                                slows the app's own clock (0.5 is half speed); the film's clock is untouched
  f.wait_real(js, what)                        waits, with the clock stopped, for something the app downloads
  f.curtain(on) / f.restart(query)             fade to black, and a cut to a fresh load of the app behind it
  f.board(title, why)                          keeps this moment as a storyboard frame

Every number spoken comes from facts(), which reads the data bundle, or is read from the page at the
moment it is said, so rendering again after a data refresh keeps the narration true. If the data no
longer supports a line, the render stops and says which scene to rewrite.
"""
import json
import re

GAS_PER_BOE = 5.8
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
MARS_SERIES = "gom:MC807"
IDA = "AL092021"  # Hurricane Ida's id at the US National Hurricane Center. It made landfall in Louisiana on 29 August 2021.
TITLE = ("<div><h1>Shell <span>Asset Atlas</span></h1><p>Public production records, from the globe to the bottom of the well</p>"
         "<small>Unofficial portfolio project. Not affiliated with, or endorsed by, Shell plc.</small></div>")


def month_name(month):
    return f"{MONTHS[int(month[5:]) - 1]} {month[:4]}"


def word(n):
    """Small whole numbers as words, which the voice reads more naturally."""
    return WORDS[n] if 0 <= n < len(WORDS) else f"{n:,}"


def spoken(name):
    """The regulator writes 'bp'. The voice needs 'BP' to spell it out."""
    return name.upper() if len(name) <= 3 else name


def hub_name(feature):
    """BOEM names a structure 'Mars A'. People say 'Mars'."""
    return feature["properties"]["name"].removesuffix(" A")


def standing(basin, index):
    """Shell's place among a basin's operators in one month, as web/src/peer-rank.ts works it out."""
    value = lambda op: op["v"][index - op["start"]] if 0 <= index - op["start"] < len(op["v"]) else 0
    ranked = sorted((op for op in basin["operators"] if value(op) > 0), key=lambda op: (-value(op), op["id"]))
    total = basin["total"][index] or 0
    place = next((i for i, op in enumerate(ranked) if op.get("focus") == "shell"), None)
    if place is None or not total:
        return None
    return {"rank": place + 1, "of": max(basin["n"][index] or 0, len(ranked)), "share": value(ranked[place]) / total * 100,
            "leader": ranked[0]["name"], "leader_share": value(ranked[0]) / total * 100}


def facts(data):
    """Everything the narration states, read from the data bundle."""
    load = lambda name: json.loads((data / name).read_text(encoding="utf-8"))
    manifest, production, assets, fields = load("manifest.json"), load("production.json"), load("assets.geojson"), load("fields.geojson")
    storms, peers, wells = load("storms.json"), load("peers.json"), load("wells.json")
    months, series, totals = production["months"], production["series"], production["totals"]
    end = months.index(min(production["latest"].values()))  # the latest month every regulator has published, as in the app

    def boe(series_id, index):
        s = series[series_id]
        i = index - s["start"]
        return s["oil"][i] + s["gas"][i] / GAS_PER_BOE if 0 <= i < len(s["oil"]) else 0.0

    def total(index):
        return sum((totals.get(f"{region}:{stake}", {}).get("gross") or [0] * len(months))[index] for region in ("gom", "uk", "no") for stake in ("operated", "jv"))

    def top(index, count=8):
        return [sid for sid in sorted(series, key=lambda sid: -boe(sid, index)) if boe(sid, index) > 0][:count]

    mars = next(f for f in assets["features"] if f["properties"].get("series") == MARS_SERIES and f["properties"].get("featured"))
    perdido = next(f for f in assets["features"] if hub_name(f) == "Perdido")
    troll = next(f for f in fields["features"] if f["properties"]["id"] == "no-field-troll")
    if series[top(end)[0]]["name"] != "Troll" or series["no:TROLL"]["stake"] != "partner":
        raise SystemExit("Troll is no longer the top partner-held name on the leaderboard; rewrite the 'net' scene")
    kpis = manifest["kpis"]
    million = round(total(end) / 1000, 1)

    # The hurricane: Ida, its estimate, and the month after it on the timeline.
    ida = next((s for s in storms["storms"] if s["id"] == IDA), None)
    if not ida or ida.get("deferred_mboe") is None or ida["month"] not in months:
        raise SystemExit("storms.json no longer has Hurricane Ida with a deferred-volume estimate; rewrite the 'storm' scene")
    if any((s.get("deferred_mboe") or 0) > ida["deferred_mboe"] for s in storms["storms"]):
        raise SystemExit("Ida is no longer the storm with the largest estimate; rewrite the 'storm' scene")
    if sum(1 for s in storms["storms"] if s.get("deferred_mboe") is not None) < 3:
        raise SystemExit("fewer than three storms carry an estimate; rewrite the last line of the 'time' scene")
    hit = [h for h in ida["hubs"] if h.get("deferred_mboe") is not None]
    worst = max(hit, key=lambda h: h["deferred_mboe"])
    if worst["series"] != MARS_SERIES:
        raise SystemExit("Mars is no longer the hub Ida cost the most; rewrite the 'storm' scene")
    after = months.index(ida["month"]) + 1
    gulf = totals["gom:operated"]["gross"]
    drop = 1 - gulf[after] / gulf[after - 1]
    if drop < 0.25:
        raise SystemExit("the data no longer shows Gulf production falling in the month after Ida; rewrite the 'storm' scene")

    # The benchmark: Shell among the Gulf's operators, and in Norway.
    basin = {b["id"]: b for b in peers["basins"]}
    if "gom" not in basin or "no" not in basin or peers["basins"][0]["id"] != "gom":
        raise SystemExit("peers.json no longer opens on the US Gulf or has lost Norway; rewrite the 'bench' scene")
    span = [standing(basin["gom"], i) for i in range(end + 1)]
    gulf_now, gulf_after, norway = span[end], span[after], standing(basin["no"], end)
    if not gulf_now or gulf_now["rank"] != 1:
        raise SystemExit("Shell is no longer the largest operator in the US Gulf in the latest month; rewrite the 'bench' scene")
    if not gulf_after or gulf_after["rank"] == 1:
        raise SystemExit("Shell no longer loses first place in the Gulf in the month after Ida; rewrite the 'bench' scene")
    if not norway or norway["rank"] == 1:
        raise SystemExit("Shell's standing in Norway changed; rewrite the last line of the 'bench' scene")

    # Below the waterline: Perdido's wells.
    hub = wells["hubs"].get(perdido["properties"]["id"])
    if not hub or perdido["properties"]["id"] not in (manifest.get("subsea") or {}):
        raise SystemExit("wells.json no longer has Perdido; rewrite the 'cold' and 'dive' scenes")
    stats = hub["stats"]
    if stats["surveyed"] < 0.9 * stats["wells"]:
        raise SystemExit("fewer than nine in ten of Perdido's wellbores have a survey; rewrite the 'cold' scene")

    # The wider portfolio.
    curated = [f["properties"] for f in assets["features"] if f["properties"].get("curated")]
    if not {"lng", "refinery", "hydrogen", "wind"} <= {p["kind"] for p in curated}:
        raise SystemExit("the hand-placed sites changed; rewrite the 'wider' scene")

    return {
        "built": manifest["generated_at"][:10],
        "end_month": month_name(months[end]),
        "assets": kpis["assets"], "fields": kpis["fields"], "pipeline_km": kpis["pipeline_km"], "countries": kpis["countries"],
        "fuel_thousand": kpis["fuel_stations"] // 1000, "first_year": months[0][:4], "first_month": month_name(months[0]),
        "total_words": "a million" if million == 1.0 else f"{million} million",
        "mars": mars["properties"], "mars_name": hub_name(mars), "mars_at": mars["geometry"]["coordinates"],
        "perdido": perdido["properties"],
        "troll_id": troll["properties"]["id"], "troll_share": round(series["no:TROLL"]["share"] * 100),
        "storm": {
            "name": ida["name"], "month": MONTHS[int(ida["month"][5:]) - 1], "before": month_name(months[months.index(ida["month"]) - 1]),
            "storm_month": month_name(ida["month"]), "after": month_name(months[after]), "closest_km": ida["closest_km"],
            "drop_words": "by more than half" if drop > 0.5 else f"by {round(drop * 100)} percent",
            "baseline": round(worst["baseline"]), "low": worst["low"], "months": worst["months"], "recovered": worst["recovered"],
            "hubs": len(hit), "deferred": ida["deferred_mboe"],
            "active": len(storms["live"]["systems"]) if storms.get("live") else None,
        },
        "bench": {
            "of": gulf_now["of"], "share": round(gulf_now["share"]), "led": sum(1 for s in span if s and s["rank"] == 1), "months": len(span),
            "after_rank": gulf_after["rank"], "after_leader": gulf_after["leader"],
            "norway_rank": norway["rank"], "norway_of": norway["of"], "norway_leader": norway["leader"],
            "norway_far": norway["leader_share"] > 3 * norway["share"],
        },
        "wells": {"water": hub["water_depth_m"], "count": stats["wells"], "surveyed": stats["surveyed"], "schematic": stats["schematic"],
                  "deepest": stats["deepest_tvd_m"], "km": round(stats["drilled_m"] / 1000)},
        "curated": len(curated),
    }


def start(d):
    """Where the film opens: the app's own link to the subsea view under Perdido, and what must be on screen before the first frame."""
    return f"#d={d['perdido']['id']}", "!!document.querySelector('.subsea.diving')"


def play(f, d):
    cold(f, d)
    atlas(f, d)
    gulf(f, d)
    time(f, d)
    storm(f, d)
    bench(f, d)
    dive(f, d)
    net(f, d)
    wider(f, d)
    method(f, d)
    closing(f, d)


def cold(f, d):
    w = d["wells"]
    f.chapter("cold", "Under one platform",
              "A cold open on the app's subsea view: the descent from the sea surface at Perdido, down the water column and in among the well paths. Then the title",
              "No cursor. The app's own dive camera, opened from its deep link and slowed to three-quarter speed. The title fades up, the picture fades to black behind it, "
              "and the film cuts to a fresh load of the app: the globe arriving from space.",
              "The pad fades in under the first line.")
    f.js("__film.cursorVisible(false)")
    f.js("document.querySelector('.subsea [data-dive]').click()")  # the app's own Dive button: the descent, from its first frame
    f.expect(".subsea [data-stats]", f"{w['water']:,} m")
    f.expect(".subsea [data-stats]", f"{w['count']:,}")
    f.speed(0.75)
    f.run(600)
    f.say("cold-1", f"This is the water under one platform in the US Gulf. {w['water']:,} metres of it.")
    f.run(3600)
    f.board("Down the water column", "The film opens inside the app's subsea view, on its own dive camera. The depth readout at the bottom follows the camera.")
    f.wait_voice(250)
    f.say("cold-2", f"And below the seabed: {w['count']} wellbores, almost all of them drawn from survey records that anyone can download.")
    f.run(3600)
    f.board("In among the wells", "Below the seabed the background turns to rock-dark and only the wells are drawn. No geology is invented.")
    f.wait_voice(500)
    f.say("cold-3", "This is the Shell Asset Atlas. An unofficial project, with no connection to Shell, built entirely from public data.")
    f.card(TITLE)
    f.run(1700)
    f.board("Title", "The title comes up over the end of the dive. The disclaimer is on screen from the first card.", thumb=True)
    f.curtain(True)
    f.run(1100)
    f.speed(1)
    f.restart("2")  # the app, loaded afresh with no link: its own opening shot
    f.curtain(False)
    f.wait_voice(600)
    f.board("Arriving from space", "Behind the title the film cuts to the app's real opening: the globe arriving from deep space.")
    f.card(None)
    f.run(1000)


def atlas(f, d):
    f.chapter("atlas", "Public records, one globe",
              "The turning globe and the headline figures in the side panel: production, installations, pipelines",
              "The cursor appears and passes down the figures as each is named. The globe keeps turning.",
              "Pad only.")
    f.js("__film.cursorVisible(true)")
    f.say("atlas-1", "Operators report what they produce to public regulators, every month. The atlas puts those records on a globe.")
    f.move("#kpis .kpi:nth-child(1)", 900)
    f.wait_voice(250)
    f.say("atlas-2", f"{d['assets']} installations and sites. {d['fields']} oil and gas fields. About {round(d['pipeline_km'], -2):,} kilometres of pipeline. "
                     "Drawn from regulators in the United States, the United Kingdom and Norway.")
    f.run(500)
    f.move("#kpis .kpi:nth-child(2)", 700)
    f.run(1900)
    f.board("The headline figures", "Each figure is recomputed from the data on every weekly refresh, and the narration reads the same numbers.")
    f.move("#kpis .kpi:nth-child(3)", 700)
    f.wait_voice(350)


def gulf(f, d):
    mars = d["mars"]
    f.chapter("gulf", "Every column is a hub",
              "Fly to the US Gulf, point at a production tower for its sparkline, click it for the full record",
              "The cursor presses the US Gulf chip and the app flies in and tilts. It glides to the Mars tower, the hover card appears, and a click opens the details drawer.",
              "A tick on each click.")
    f.say("gulf-1", "Start in the US Gulf. Each column is a production hub, and its height is what that hub produced in a month.")
    f.click('[data-view="US Gulf"]', 800)
    f.run(3000)
    f.board("The deepwater Gulf", "One click on a region chip. Towers are scaled to gross production in the selected month.")
    f.wait_voice(200)
    kind = (mars.get("subtype") or "platform").lower()
    f.say("gulf-2", f"Click one for its record. This is {d['mars_name']}: a {kind}, standing in {mars['water_depth_m']:,} metres of water since {mars['installed']}, "
                    f"with every month of production since {d['first_year']}.")
    f.hover(mars["id"], d["mars_at"])
    f.run(900)
    f.expect(".hover-pop", mars["name"])
    f.board("Hover for a sparkline", "The app's own hover card, raised by the real pointer: name, type and a production sparkline.")
    f.press()
    f.run(900)
    f.expect("#drawer h2", mars["name"])
    f.move("#drawer h2", 800)
    f.run(1600)
    f.move("#drawer-chart", 900)
    box = f.page.locator("#drawer-chart").bounding_box()
    f.move((box["x"] + box["width"] * 0.25, box["y"] + box["height"] * 0.5), 600)
    f.move((box["x"] + box["width"] * 0.85, box["y"] + box["height"] * 0.45), 2200)
    f.board("The full record", "The details drawer: facts from the regulator, a liquids-and-gas chart that can be scrubbed, and the source link.")
    f.wait_voice(300)


def time(f, d):
    f.chapter("time", "A decade you can replay",
              "The production timeline plays from the first month to the latest. The towers, the leaderboard and the storm tracks follow it",
              "The drawer is closed to reveal the leaderboard. The cursor presses play and waits on the button while the decade runs, then moves to the total.",
              "A tick on play.")
    f.click("#drawer-close", 700)
    f.say("time-1", "Now press play. A decade of production replays, month by month, and the leaderboard re-ranks as it goes.")
    f.click("#play", 900, after=0)
    f.run(2500)
    f.board("Press play", "The timeline, the towers on the map and the top-producers race all move together.")
    f.wait_voice(300)
    f.say("time-2", f"By {d['end_month']}, the total is about {d['total_words']} barrels of oil equivalent a day, gross. But look at the dips on the way. Several of them are storms.")
    f.wait_text("#tl-month", d["end_month"])
    f.run(500)
    f.move("#tl-total", 800)
    f.board("The latest month", "Play stops at the latest month all three regulators have published, so a reporting lag never looks like a fall.")
    f.wait_voice(350)


def storm(f, d):
    s = d["storm"]
    f.chapter("storm", "What a hurricane does",
              "The Gulf storms panel and the replay of Hurricane Ida: its track drawn across the Gulf, the towers falling in the month after, and the estimate of what was deferred",
              "The cursor scrolls the side panel to the storm list and clicks Ida. The app jumps to the month before, flies to the Gulf and plays the storm through; "
              "the film shows that replay at two-fifths speed. The cursor then reads the hub-by-hub estimate and the weekly forecast snapshot.",
              "Ticks on clicks.")
    rows = f.page.locator("#storms .storm-row")
    if rows.first.get_attribute("data-storm") != IDA:
        raise SystemExit("Ida is not at the top of the app's storm list; rewrite the 'storm' scene")
    category = re.search(r"Cat (\d)", f.page.text_content(f'#storms [data-storm="{IDA}"] em') or "")
    if not category:
        raise SystemExit("the storm list no longer gives Ida a hurricane category; rewrite the 'storm' scene")
    f.say("storm-1", f"The atlas follows {rows.count()} Gulf storms that passed near Shell structures. The costliest was Hurricane {s['name']}.")
    f.move("#storms .storm-legend", 1000)
    f.run(1200)
    f.board("Gulf storms", "The storm list in the side panel, ranked by estimated deferred volume. Every figure is computed by the pipeline from the regulator's monthly data.")
    f.move(f'#storms [data-storm="{IDA}"]', 900)
    f.wait_voice(-600)
    f.press()
    f.speed(0.4)
    f.run(300)
    f.expect("#tl-month", s["before"])
    km = f"{word(s['closest_km'])} kilometre{'' if s['closest_km'] == 1 else 's'}"
    f.say("storm-2", f"Click it, and the atlas goes back to {s['before']}. {s['name']} crosses the Gulf in {s['month']} as a category {word(int(category.group(1)))} hurricane, "
                     f"and its centre passes {km} from the nearest Shell structure.")
    f.wait_text("#tl-month", s["storm_month"])
    f.run(4300)
    f.board("Ida crossing the Gulf", "The storm's marker runs along the National Hurricane Center best track for the month, coloured by wind category, over the production towers.")
    f.wait_text("#tl-month", s["after"])
    f.wait_voice(200)
    low = "nothing" if s["low"] < 0.5 else f"{round(s['low'])} thousand"
    recovery = f"and takes {word(s['months'])} month{'' if s['months'] == 1 else 's'} to recover" if s["recovered"] else f"and has still not recovered {word(s['months'])} months later"
    f.say("storm-3", f"The month after, Shell-operated production in the Gulf falls {s['drop_words']}. "
                     f"{d['mars_name']} goes from about {s['baseline']} thousand barrels of oil equivalent a day to {low}, {recovery}.")
    f.run(3200)
    f.board("The month after", "The towers under the track have collapsed and the total on the timeline has dropped. The dip is in the regulator's own figures; the atlas only draws it.")
    f.wait_for("!document.querySelector('#storms.replaying')", "the end of the storm replay")
    f.speed(1)
    f.wait_voice(300)
    hubs = f"{word(s['hubs'])} hub{'' if s['hubs'] == 1 else 's'}"
    f.say("storm-4", f"Across {hubs}, the atlas estimates about {round(s['deferred'])} million barrels of oil equivalent deferred, relative to the pre-storm baseline. "
                     "It's an estimate, and the panel says so.")
    f.move("#storms .storm-detail", 1000)
    f.run(2600)
    f.board("The estimate, hub by hub", "For each hub near the track: the baseline before the storm, the low, the months to recover and the estimated volume deferred.")
    f.wait_voice(300)
    if s["active"] is not None:
        now = "no storm was" if s["active"] == 0 else "one storm was" if s["active"] == 1 else f"{word(s['active'])} storms were"
        f.say("storm-5", f"Each week, it also checks the National Hurricane Center's feed. At the last check, {now} active.")
        f.move("#storms .storm-live", 1100)
        f.wait_voice(350)


def bench(f, d):
    b, s = d["bench"], d["storm"]
    f.chapter("bench", "Against every other operator",
              "The peer benchmark: every operator in the US Gulf ranked by operated production, re-ranking as the decade plays, then the same for Norway",
              "The B key opens the benchmark. The cursor scrubs the timeline back to its first month and presses play, pauses on the month after Ida, "
              "plays on to the latest month, then switches the basin to Norway and reads the note.",
              "Ticks on clicks and a soft tick on the key.")
    said = f.say("bench-1", "The regulator publishes every operator, not only Shell. Press B, and the atlas ranks them all.")
    f.until(said - 2600)
    f.key("B", "Benchmark")
    f.run(700)
    f.expect("#bench .bench-headline", "Shell ranks")
    f.wait_voice(200)
    f.say("bench-2", f"Go back to {d['first_year']} and play the decade again. This time the bars are companies, ranked by the production they operate.")
    box = f.page.locator("#tl-chart").bounding_box()
    f.click((box["x"] + 30, box["y"] + box["height"] / 2), 900)
    f.expect("#tl-month", d["first_month"])
    f.click("#play", 800, after=0)
    f.run(2600)
    f.board("The operators' race", "Operators ranked by the gross production they operate, from the same regulator files. Shell is the amber bar; every peer is grey.")
    f.wait_text("#tl-month", s["after"])
    f.press(0)  # the cursor is still on the button: pause on this exact month
    f.run(400)
    f.expect("#bench .bench-headline", f"#{b['after_rank']} of")
    f.say("bench-3", f"Stop at {s['after']}, the month after {s['name']}. {spoken(b['after_leader'])} has taken the lead.")
    f.move("#bench .bench-row.focus-shell", 900)
    f.run(1500)
    f.board(f"{s['after']}: second place", "Paused on the month after Ida. The headline is a sentence the app computes from the data, so it reports the bad months too.")
    f.wait_voice(300)
    f.say("bench-4", f"By {d['end_month']}, Shell ranks number one of {b['of']} operators in the US Gulf, with about {b['share']} percent of operated production. "
                     f"It has led in {b['led']} of these {b['months']} months.")
    f.click("#play", 900, after=0)
    f.wait_text("#tl-month", d["end_month"])
    f.run(400)
    f.expect("#bench .bench-headline", f"#1 of {b['of']} operators")
    f.move("#bench .bench-headline", 900)
    f.run(1800)
    f.board("Number one in the Gulf", "The headline for the latest month. It is operated production by operator of record, as the note under the chart says, not equity.")
    f.wait_voice(300)
    behind = "far behind" if b["norway_far"] else "behind"
    f.say("bench-5", f"It isn't first everywhere. In Norway, Shell ranks number {word(b['norway_rank'])}, {behind} {spoken(b['norway_leader'])}. "
                     "And this is production by operator of record, not equity.")
    f.click('#bench [data-basin="no"]', 900)
    f.run(600)
    f.expect("#bench .bench-headline", f"#{b['norway_rank']} of {b['norway_of']}")
    f.run(2400)
    f.board("The same test in Norway", "The basin switcher: US Gulf, Gulf deepwater, UK and Norway. Where Shell is not the leader, the panel says so.")
    f.move("#bench .bench-note", 1100)
    f.wait_voice(350)


def dive(f, d):
    w, perdido = d["wells"], d["perdido"]
    f.chapter("dive", "Below the waterline",
              "Search for Perdido, press Dive below, and the subsea view: the water column to scale, the surveyed well paths, the depth staff, "
              "the depth stretch, colour by spud year, a turn of the camera and a well's own record",
              "The cursor switches to the seabed map, searches for Perdido and presses Dive below. It is hidden for the descent, which the film shows at three-fifths speed. "
              "The view then orbits by itself while the cursor reads the figures, presses Depth x3 and Spud year, drags the scene round and points at one well.",
              "Ticks on clicks, soft ticks on keys. Nothing is added for the descent.")
    f.key("Escape", "Close")
    f.say("dive-1", f"Now, the place this film began. Search for {hub_name({'properties': perdido})}: "
                    f"a {(perdido.get('subtype') or 'platform').lower()}, moored in {perdido['water_depth_m']:,} metres of water.")
    f.click('[data-base="ocean"]', 900)
    f.run(500)
    f.key("/", "Search")
    f.type("Perdido")
    f.run(700)
    f.key("Enter", after=0)
    f.run(4300)
    f.expect("#drawer h2", perdido["name"])
    f.board("Perdido, on the seabed map", "Search flies to the hub and opens its record. On NASA's seabed relief the platform stands far beyond the continental shelf.")
    f.wait_voice(200)
    f.say("dive-2", "Its record has one more button. Dive below.")
    f.click("#drawer [data-dive]", 1300)
    f.wait_real("!!document.querySelector('.subsea.diving')", "the subsea view opening")
    f.speed(0.6)
    f.js("__film.cursorVisible(false)")
    stack = re.search(r"as deep as ([\d.]+) (.+?)s \(", f.page.text_content(".subsea [data-scale]") or "")
    if not stack:
        raise SystemExit("the subsea view no longer compares the water depth with a landmark; rewrite the 'dive' scene")
    f.wait_voice(200)
    f.say("dive-3", f"Everything here is drawn to true scale. The water is as deep as {stack.group(1)} {stack.group(2)}s, stood on end.")
    f.run(4600)
    f.board("The descent", "The dive camera follows the well paths down from the platform. In the water column the wells run together as one bundle of risers.")
    f.wait_voice(200)
    rest = "The rest are drawn dashed, as schematics." if w["schematic"] else ""
    surveyed = f"{w['surveyed']} of them follow" if w["schematic"] else "All of them follow"
    f.say("dive-4", f"Then the seabed, and below it, {w['count']} wellbores. {surveyed} the directional surveys filed with the regulator. {rest}")
    f.run(4200)
    f.board("Below the seabed", "Each line is one wellbore from BOEM's borehole file, on its surveyed path. Colour is the regulator's status code.")
    f.wait_for("!document.querySelector('.subsea.diving')", "the end of the dive")
    f.speed(1)
    f.js("__film.cursorVisible(true)")
    f.expect(".subsea [data-stats]", f"{w['deepest']:,} m")
    f.wait_voice(200)
    f.say("dive-5", f"The deepest ends {w['deepest']:,} metres below sea level. Together, they come to about {w['km']} kilometres of drilled hole.")
    f.move(".subsea [data-stats] .stat:nth-child(3)", 1100)
    f.run(1700)
    f.move(".subsea [data-stats] .stat:nth-child(4)", 700)
    f.run(900)
    f.board("The whole picture", "The view the dive ends on, turning slowly: water above the seabed line, wells below it, and a depth staff in metres and feet. "
                                 "The landmark on the seabed is drawn to its real height.")
    f.wait_voice(300)
    times = f.page.get_attribute(".subsea [data-ve] button:nth-child(2)", "data-v")
    f.say("dive-6", f"Stretch the depth {word(int(times))} times, and each path is easier to follow.")
    f.click(".subsea [data-ve] button:nth-child(2)", 900)
    f.run(2600)
    f.board("Depth stretched", "The vertical scale is one switch. True scale is the default, and the stretched view is labelled as stretched.")
    f.wait_voice(300)
    f.click('.subsea [data-c="year"]', 800)
    f.run(300)
    years = [t for t in f.page.locator(".subsea-legend .ramp > span").all_text_contents() if t.strip().isdigit()]
    if len(years) != 2:
        raise SystemExit("the subsea legend no longer gives a first and last spud year; rewrite the 'dive' scene")
    f.say("dive-7", f"Colour them by the year drilling began, and the field grows in front of you, from {years[0]} to {years[1]}.")
    f.move(".subsea-legend .ramp", 1300)
    f.run(2200)
    f.board("By spud year", "The same wells coloured by the year each was spudded, with the range in the legend.")
    f.wait_voice(300)
    f.say("dive-8", "Drag to look around. Then point at any well for its name, its depth and its status.")
    f.drag((1010, 300), (1230, 250), 2200)
    f.run(1300)  # the camera's damping settles
    spot = f.js("""() => {
      const paths = __subsea.wells(), canvas = document.querySelector('.subsea-canvas');
      const free = (p) => p && p[0] > 520 && p[0] < innerWidth - 330 && p[1] > 130 && p[1] < innerHeight - 110 && document.elementFromPoint(p[0], p[1]) === canvas;
      let best = null;
      paths.forEach((path, i) => {
        for (let k = Math.floor(path.length * 0.55); k < path.length; k++) {
          const p = path[k];
          if (!free(p)) continue;
          let near = Infinity;
          paths.forEach((other, j) => { if (j !== i) for (const q of other) if (q) near = Math.min(near, Math.hypot(q[0] - p[0], q[1] - p[1])); });
          if (!best || near > best.near) best = { near, x: p[0], y: p[1] };
        }
      });
      return best;
    }""")
    if not spot:
        raise SystemExit("no well is clear enough of the others to point at from this camera; rewrite the 'dive' scene")
    f.move((spot["x"], spot["y"]), 1200)
    for dx in (1.5, 0):
        f.page.mouse.move(spot["x"] + dx, spot["y"])
        f.step()
    f.run(900)
    if f.js("document.querySelector('.subsea-tip').hidden"):
        raise SystemExit("pointing at a well raised no card; rewrite the 'dive' scene")
    f.run(1300)
    f.board("One well's record", "The app's own hover card: the well's name, its API number, total depth, spud date and status, and whether its path is surveyed.")
    f.wait_voice(300)
    f.say("dive-9", "The atlas draws only what is public. The seabed is interpolated from well-site depths, and no geology is shown, because none is published.")
    f.move(".subsea-legend p", 1300)
    f.wait_voice(400)
    f.key("Escape", "Close")
    f.run(500)


def net(f, d):
    f.chapter("net", "Gross is not net",
              "Back on the globe: the leaderboard as a way in, a partner-held field, Shell's equity in it and its net share",
              "Escape closes the record. The cursor presses Troll at the top of the leaderboard and the app flies to Norway. The cursor passes over the gross and net figures, then along the chart's net line.",
              "Ticks on clicks.")
    f.key("Escape")
    f.say("net-1", f"Back on the surface, Troll, off Norway, tops the leaderboard. But Shell doesn't operate it. It holds about {d['troll_share']} percent.")
    f.click(f'.race-row[data-owner="{d["troll_id"]}"]', 1000)
    f.run(3600)
    f.board("Troll, a partner field", "A click on the leaderboard flies to the field. Its outline is extruded by production.")
    f.wait_voice(250)
    f.expect("#drawer h2", "Troll")
    f.expect("#drawer .stat-row", "Shell net")
    f.say("net-2", "So the atlas shows Shell's net figure beside the gross one. Gross is never passed off as net.")
    f.move("#drawer .stat-row .stat:nth-child(2)", 900)
    f.run(1700)
    box = f.page.locator("#drawer-chart").bounding_box()
    f.move((box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.8), 800)
    f.move((box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.8), 2000)
    f.board("Gross and net", "Where licence equity is public, the drawer shows Shell's net beside the gross figure and draws it as a dashed line.")
    f.wait_voice(400)


def wider(f, d):
    f.chapter("wider", "Beyond the wellhead",
              "The night-lights basemap, the hand-placed sites around Rotterdam, the fuel station heatmap and the 3D retail skyline",
              "Escape closes the record. The cursor switches to Night, presses the Europe chip and 3D retail, and the app tilts into the skyline. Orbit starts the camera turning.",
              "Ticks on clicks.")
    f.key("Escape", "Close")
    f.say("wider-1", f"Beyond production, {d['curated']} more sites are placed by hand, from LNG plants and refineries to hydrogen and wind.")
    f.click('[data-base="night"]', 900)
    f.click('[data-view="Europe"]', 900)
    f.run(3400)
    f.board("Stations at night", "The station heatmap over NASA's night lights. These are crowd-sourced counts, not an official network size.")
    f.wait_voice(250)
    f.say("wider-2", f"And on the street, OpenStreetMap volunteers have mapped more than {d['fuel_thousand']} thousand Shell-branded fuel stations. One click turns them into a skyline.")
    f.run(2600)
    f.click("#hex-btn", 900)
    f.run(3400)
    f.click("#orbit-btn", 800)
    f.run(2200)
    f.board("The 3D retail skyline", "Stations binned into hexagonal cells and extruded by count, with the orbit camera on.")
    f.wait_voice(900)


def method(f, d):
    f.chapter("method", "Nothing taken on trust",
              "Data & method: every source with its licence and fetch status, and the method notes",
              "The cursor presses Data & method, reads down the source table, scrolls through the method notes and closes the dialog.",
              "Ticks on clicks.")
    f.say("method-1", "None of it has to be taken on trust. Data and method lists every source, with its licence.")
    f.click("#about-btn", 1000)
    f.run(600)
    f.move("#about table.sources tbody tr:nth-child(1)", 800)
    f.move("#about table.sources tbody tr:nth-child(4)", 2400)
    f.board("Data & method", "Every public source, each with its licence and whether this build is fresh or a fallback snapshot.")
    f.wait_voice(250)
    f.say("method-2", "A pipeline rebuilds the atlas from them every week. If a regulator's site is down, it falls back to the last good copy, and says so.")
    f.run(600)
    f.wheel(520, 2200)
    f.board("The method notes", "How each figure is derived, including what the storm estimates, the benchmark and the subsea view do not claim.")
    f.wait_voice(400)
    f.click("#about [data-close]", 900)


def closing(f, d):
    f.chapter("close", "One globe",
              "Back out to the whole world, then the end card with sources and the disclaimer",
              "The cursor puts the map back as it found it, presses the World chip and leaves. The app flies back out to the globe and the end card fades up.",
              "The pad fades out under the last line.")
    f.say("close-1", "The Shell Asset Atlas. Public records, on one globe, from the sea surface to the bottom of the deepest well.")
    f.click("#hex-btn", 700)
    f.click('[data-base="dark"]', 600)
    f.click('[data-view="World"]', 800)
    f.js("__film.cursorVisible(false)")
    f.run(3200)
    f.board("Back to the world", "The World chip flies back out to the globe.")
    f.wait_voice(300)
    f.say("close-2", "It's an unofficial project, and it isn't endorsed by Shell. The data belongs to the regulators, and to OpenStreetMap's contributors. This narration is a synthetic voice.")
    link = f'<p class="url">{f.url}</p>' if f.url else ""
    f.card("<div><h1>Shell <span>Asset Atlas</span></h1><p>" + ("Explore it yourself" if f.url else "Public records, one globe") + "</p>" + link +
           "<small>Unofficial portfolio project. Not affiliated with, or endorsed by, Shell plc. No Shell logos or proprietary data are used.<br>"
           "Data: US Bureau of Ocean Energy Management · North Sea Transition Authority (OGL v3.0) · Norwegian Offshore Directorate (NLOD 2.0) · "
           "US National Hurricane Center · © OpenStreetMap contributors · Imagery: NASA EOSDIS GIBS · Basemap © CARTO<br>"
           "Storm impacts are estimates from monthly data. The benchmark is production by operator of record, not equity. The subsea seabed is interpolated.<br>"
           "Filmed from the real application. Narration: synthetic voice (Kokoro). Music: synthesized.</small></div>", "solid")
    f.run(1500)
    f.board("End card", "Sources, licences, what the figures do not claim, and the disclaimer, held until the narration ends.")
    f.wait_voice(2200)
