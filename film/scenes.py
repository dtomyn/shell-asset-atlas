"""The explainer's story: what is said, what the cursor does, and in what order.

Each scene is plain code against the Film in render.py:

  f.chapter(id, title, shows, camera, sound)   starts a chapter (YouTube chapter, storyboard section)
  f.say(id, text)                              queues a narrated line; its length sets the timing
  f.wait_voice()                               runs the film until everything queued has been said
  f.click(selector) / f.move(...) / f.key(...) / f.type(...) / f.wheel(...)   real input on the real page
  f.run(ms)                                    lets the film run
  f.board(title, why)                          keeps this moment as a storyboard frame

Every number spoken comes from facts(), which reads the data bundle, so rendering again after a
data refresh keeps the narration true. If the data no longer supports a line, facts() stops the render.
"""
import json

GAS_PER_BOE = 5.8
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
MARS_SERIES = "gom:MC807"
IDA_MONTH = "2021-09"  # Hurricane Ida made landfall in Louisiana on 29 August 2021.


def month_name(month):
    return f"{MONTHS[int(month[5:]) - 1]} {month[:4]}"


def hub_name(feature):
    """BOEM names a structure 'Mars A'. People say 'Mars'."""
    return feature["properties"]["name"].removesuffix(" A")


def facts(data):
    """Everything the narration states, read from the data bundle."""
    load = lambda name: json.loads((data / name).read_text(encoding="utf-8"))
    manifest, production, assets, fields = load("manifest.json"), load("production.json"), load("assets.geojson"), load("fields.geojson")
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
    ida = months.index(IDA_MONTH)
    gulf = totals["gom:operated"]["gross"]
    drop = 1 - gulf[ida] / gulf[ida - 1]
    if drop < 0.25:
        raise SystemExit("the data no longer shows the September 2021 drop in the Gulf; rewrite the 'time' scene")
    # Gulf hubs installed after the hurricane whose production now ranks in the leaderboard.
    leaders = top(end)
    new_hubs = [hub_name(f) for f in sorted(assets["features"], key=lambda f: f["properties"].get("installed") or 0)
                if f["properties"].get("featured") and f["properties"]["region"] == "gom" and (f["properties"].get("installed") or 0) > 2021
                and f["properties"].get("series") in leaders]
    if series[leaders[0]]["name"] != "Troll" or series["no:TROLL"]["stake"] != "partner":
        raise SystemExit("Troll is no longer the top partner-held name on the leaderboard; rewrite the 'net' scene")
    kpis = manifest["kpis"]
    million = round(total(end) / 1000, 1)
    return {
        "built": manifest["generated_at"][:10],
        "end_month": month_name(months[end]),
        "assets": kpis["assets"], "fields": kpis["fields"], "pipeline_km": kpis["pipeline_km"], "countries": kpis["countries"],
        "fuel_thousand": kpis["fuel_stations"] // 1000, "first_year": months[0][:4],
        "total_words": "a million" if million == 1.0 else f"{million} million",
        "mars": mars["properties"], "mars_name": hub_name(mars), "mars_at": mars["geometry"]["coordinates"],
        "mars_in_ida": boe(MARS_SERIES, ida),
        "ida_drop_words": "by more than half" if drop > 0.5 else f"by {round(drop * 100)} percent",
        "new_hubs": new_hubs,
        "perdido": perdido["properties"],
        "troll_id": troll["properties"]["id"], "troll_share": round(series["no:TROLL"]["share"] * 100),
    }


def play(f, d):
    opening(f, d)
    atlas(f, d)
    gulf(f, d)
    time(f, d)
    seabed(f, d)
    net(f, d)
    retail(f, d)
    tour(f, d)
    method(f, d)
    closing(f, d)


def opening(f, d):
    f.chapter("open", "Public records, one globe",
              "The app's own opening: the globe arrives from deep space over a starfield and begins to turn",
              "No cursor. The app's fly-in runs untouched, then its idle spin. The title fades up over it.",
              "The pad fades in under the first line.")
    f.js("__film.cursorVisible(false)")
    f.run(700)
    f.say("open-1", "Every month, oil and gas operators tell public regulators exactly what they produced. The numbers are open to anyone. Almost no one looks.")
    f.run(4200)
    f.board("Arriving from space", "The app's real opening shot. Nothing is staged: the film starts the moment the page finishes loading.")
    f.wait_voice(300)
    f.say("open-2", "This is what happens when you put them on a globe.")
    f.run(900)
    f.card("<div><h1>Shell <span>Asset Atlas</span></h1><p>A decade of public production records, on one globe</p>"
           "<small>Unofficial portfolio project. Not affiliated with, or endorsed by, Shell plc.</small></div>")
    f.wait_voice(900)
    f.board("Title", "The title sits over the turning globe. The disclaimer is on screen from the first card.", thumb=True)
    f.run(900)
    f.card(None)
    f.run(900)


def atlas(f, d):
    f.chapter("atlas", "What the atlas is",
              "The headline figures in the side panel: production, installations, pipelines, fuel stations",
              "The cursor appears and passes down the figures as each is named. The globe keeps turning.",
              "Pad only.")
    f.js("__film.cursorVisible(true)")
    f.say("atlas-1", "This is the Shell Asset Atlas. It's an unofficial portfolio project, with no connection to Shell, built entirely from public data.")
    f.move("#kpis .kpi:nth-child(1)", 900)
    f.wait_voice(250)
    f.say("atlas-2", f"{d['assets']} installations and sites. {d['fields']} oil and gas fields. About {round(d['pipeline_km'], -2):,} kilometres of pipeline. "
                     "All of it drawn from regulators in the United States, the United Kingdom and Norway.")
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
    f.say("gulf-2", "Point at one for a quick read. Click it, and the full record opens.")
    f.hover(mars["id"], d["mars_at"])
    f.run(1500)
    f.expect(".hover-pop", mars["name"])
    f.board("Hover for a sparkline", "The app's own hover card, raised by the real pointer: name, type and a production sparkline.")
    f.wait_voice(-500)
    f.press()
    f.run(900)
    f.expect("#drawer h2", mars["name"])
    kind = (mars.get("subtype") or "platform").lower()
    f.say("gulf-3", f"This is {d['mars_name']}: a {kind}, standing in {mars['water_depth_m']:,} metres of water since {mars['installed']}.")
    f.move("#drawer h2", 800)
    f.wait_voice(250)
    f.say("gulf-4", f"Below that, every month of production since {d['first_year']}, split into liquids and gas, with a link back to the regulator's own record.")
    f.move("#drawer-chart", 900)
    f.run(600)
    box = f.page.locator("#drawer-chart").bounding_box()
    f.move((box["x"] + box["width"] * 0.25, box["y"] + box["height"] * 0.5), 600)
    f.move((box["x"] + box["width"] * 0.85, box["y"] + box["height"] * 0.45), 2200)
    f.board("The full record", "The details drawer: facts from the regulator, a liquids-and-gas chart that can be scrubbed, and the source link.")
    f.wait_voice(300)


def time(f, d):
    f.chapter("time", "A decade you can replay",
              "The production timeline plays from the first month, the towers and the leaderboard follow, and it is paused on September 2021",
              "The drawer is closed to reveal the leaderboard. The cursor presses play, waits on the button, and pauses on September 2021. It points at the Mars hub, then presses play again and the timeline runs to the latest month.",
              "Ticks on play and pause.")
    f.click("#drawer-close", 700)
    f.say("time-1", "Now press play. A decade of production replays, month by month. The columns rise and fall, and the leaderboard re-ranks as it goes.")
    f.click("#play", 900, after=0)
    f.run(2500)
    f.board("Press play", "The timeline, the towers on the map and the top-producers race all move together.")
    f.wait_text("#tl-month", month_name(IDA_MONTH))
    f.press(0)  # the cursor is still on the button: pause on this exact month
    f.run(500)
    f.wait_voice(100)
    mars_then = "The Mars hub reports nothing at all." if d["mars_in_ida"] < 0.5 else f"The Mars hub is down to {round(d['mars_in_ida'])} thousand barrels a day."
    f.say("time-2", f"Stop here: September 2021. Hurricane Ida struck at the end of August, and Shell-operated production in the Gulf fell {d['ida_drop_words']} in a single month. {mars_then}")
    f.run(1200)
    f.hover(d["mars"]["id"], d["mars_at"])
    f.run(1800)
    f.board("September 2021", "Paused on the month after Hurricane Ida. The dip is in the regulator's own figures; the atlas only draws it.")
    f.wait_voice(350)
    hubs = " and ".join(d["new_hubs"][-2:])
    f.say("time-3", f"Press play again, and the recovery is there too. By {d['end_month']}, newer hubs like {hubs} are on the leaderboard, "
                    f"and the total is about {d['total_words']} barrels of oil equivalent a day, gross.")
    f.click("#play", 900, after=0)
    f.wait_text("#tl-month", d["end_month"])
    f.run(600)
    f.move("#tl-total", 800)
    f.board("The latest month", "Play stops at the latest month all three regulators have published, so a reporting lag never looks like a fall.")
    f.wait_voice(350)


def seabed(f, d):
    perdido = d["perdido"]
    f.chapter("seabed", "Why it's called deepwater",
              "The seabed basemap, colour by water depth with its legend, and search",
              "The cursor switches the basemap to Seabed and the colours to Depth. The slash key opens search, 'Perdido' is typed and chosen, and the app flies there and begins to orbit.",
              "Ticks on clicks and soft ticks on keys.")
    f.say("seabed-1", "Change the view. The seabed basemap shows why this is called deepwater: the platforms stand far beyond the continental shelf.")
    f.click('[data-base="ocean"]', 900)
    f.run(2600)
    f.board("Seabed basemap", "NASA Blue Marble with seabed relief. The shelf edge and the canyons under the platforms become visible.")
    f.wait_voice(250)
    f.say("seabed-2", f"Colour by water depth, then search for Perdido. It's moored in {perdido['water_depth_m']:,} metres of water.")
    f.click('[data-color="depth"]', 800)
    f.run(900)
    f.key("/", "Search")
    f.type("Perdido")
    f.run(700)
    f.board("Search", "Typed into the real search box. Results rank featured assets first.")
    f.key("Enter", after=0)
    f.run(4200)
    f.board("Perdido, by depth", "Search flies to the asset, opens its record and starts a slow orbit. Colours now show water depth, with a legend in the panel.")
    f.wait_voice(900)


def net(f, d):
    f.chapter("net", "Gross is not net",
              "The leaderboard as a way in, a partner-held field, Shell's equity in it and its net share",
              "Escape closes the drawer. The cursor presses Troll at the top of the leaderboard and the app flies to Norway. The cursor passes over the gross and net figures, then along the chart's net line.",
              "Ticks on clicks.")
    f.key("Escape", "Close")
    f.say("net-1", f"The leaderboard is a way in, too. Troll, off Norway, is the biggest name on it. But Shell doesn't operate Troll. It holds about {d['troll_share']} percent.")
    f.click(f'.race-row[data-owner="{d["troll_id"]}"]', 1000)
    f.run(3600)
    f.board("Troll, a partner field", "A click on the leaderboard flies to the field. Its outline is extruded by production.")
    f.wait_voice(250)
    f.expect("#drawer h2", "Troll")
    f.expect("#drawer .stat-row", "Shell net")
    f.say("net-2", "So the atlas marks it as a partner asset, shows Shell's net figure beside the gross one, and draws the net share as its own line. Gross is never passed off as net.")
    f.move("#drawer .stat-row .stat:nth-child(2)", 900)
    f.run(2200)
    box = f.page.locator("#drawer-chart").bounding_box()
    f.move((box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.8), 800)
    f.move((box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.8), 2000)
    f.board("Gross and net", "Where licence equity is public, the drawer shows Shell's net beside the gross figure and draws it as a dashed line.")
    f.wait_voice(400)


def retail(f, d):
    f.chapter("retail", "Fuel stations as a skyline",
              "The night-lights basemap, the fuel station heatmap, the 3D retail skyline and the orbit camera",
              "Escape closes the drawer. The cursor switches to Night, presses the Europe chip, then 3D retail, and the app tilts into the skyline. Orbit starts the camera turning.",
              "Ticks on clicks.")
    f.key("Escape", "Close")
    f.say("retail-1", f"Shell is also a name on the street. OpenStreetMap volunteers have mapped more than {d['fuel_thousand']} thousand Shell-branded fuel stations.")
    f.click('[data-base="night"]', 900)
    f.click('[data-view="Europe"]', 900)
    f.run(3200)
    f.board("Stations at night", "The station heatmap over NASA's night lights. These are crowd-sourced counts, not an official network size.")
    f.wait_voice(250)
    f.say("retail-2", "One click turns them into a skyline, where taller means more stations. Then set the camera turning.")
    f.click("#hex-btn", 900)
    f.run(3400)
    f.click("#orbit-btn", 800)
    f.run(2200)
    f.board("The 3D retail skyline", "Stations binned into hexagonal cells and extruded by count, with the orbit camera on.")
    f.wait_voice(1400)


def tour(f, d):
    f.chapter("tour", "Or take the tour",
              "The guided tour: its card, its camera moves and the record it opens at each stop",
              "The cursor returns the map to its dark basemap, flat stations and segment colours, then presses Guided tour and steps through the first stops with Next. Escape closes the last record.",
              "Ticks on clicks.")
    f.say("tour-1", "Prefer to be shown around?")
    f.click("#hex-btn", 700)
    f.click('[data-base="dark"]', 600)
    f.click('[data-color="segment"]', 600)
    f.click("#tour-btn", 1000)
    stops = int(f.page.text_content("#tour-kicker").split("/")[1].split("·")[0])
    f.say("tour-2", f"The guided tour makes {stops} stops, from the deepwater Gulf to a floating gas plant off Australia.")
    f.run(4200)
    f.board("The guided tour", "Stop one of the tour. The side panel steps aside and the card takes over.")
    f.click("#tour-next", 800)
    f.wait_voice(250)
    f.say("tour-3", "Every figure in its text is computed from the data. So after each weekly refresh, the story is still true.")
    f.run(3600)
    f.click("#tour-next", 800)
    f.run(4600)
    f.board("A stop on the tour", "Each stop flies the camera, opens the asset's record and writes its text from the current data.")
    f.wait_voice(600)
    f.click("#tour-exit", 800)
    f.key("Escape", after=500)


def method(f, d):
    f.chapter("method", "Nothing taken on trust",
              "Data & method: every source with its licence and fetch status, and the method notes",
              "The cursor presses Data & method, reads down the source table, scrolls through the method notes and closes the dialog.",
              "Ticks on clicks.")
    f.say("method-1", "And none of it has to be taken on trust. Data and method lists every source, its licence, and when it was last fetched.")
    f.click("#about-btn", 1000)
    f.run(600)
    f.move("#about table.sources tbody tr:nth-child(1)", 800)
    f.move("#about table.sources tbody tr:nth-child(4)", 2400)
    f.board("Data & method", "Five public sources, each with its licence and whether this build is fresh or a fallback snapshot.")
    f.wait_voice(250)
    f.say("method-2", "A pipeline rebuilds the whole atlas from those sources every week. If a regulator's site is down, it falls back to the last good copy, and says so.")
    f.run(1200)
    f.wheel(380, 2600)
    f.wait_voice(400)
    f.click("#about [data-close]", 900)


def closing(f, d):
    f.chapter("close", "One globe",
              "Back out to the whole world, then the end card with sources and the disclaimer",
              "The cursor presses the World chip and leaves. The app flies back out to the globe and the end card fades up.",
              "The pad fades out under the last line.")
    f.say("close-1", "The Shell Asset Atlas. Public records, one globe, and a decade you can replay.")
    f.click('[data-view="World"]', 900)
    f.js("__film.cursorVisible(false)")
    f.run(3200)
    f.board("Back to the world", "The World chip flies back out to where the film began.")
    f.wait_voice(300)
    f.say("close-2", "It's an unofficial project, and it isn't endorsed by Shell. The data belongs to the regulators, and to OpenStreetMap's contributors. This narration is a synthetic voice.")
    link = f'<p class="url">{f.url}</p>' if f.url else ""
    f.card("<div><h1>Shell <span>Asset Atlas</span></h1><p>" + ("Explore it yourself" if f.url else "Public records, one globe") + "</p>" + link +
           "<small>Unofficial portfolio project. Not affiliated with, or endorsed by, Shell plc. No Shell logos or proprietary data are used.<br>"
           "Data: US Bureau of Ocean Energy Management · North Sea Transition Authority (OGL v3.0) · Norwegian Offshore Directorate (NLOD 2.0) · "
           "© OpenStreetMap contributors · Imagery: NASA EOSDIS GIBS · Basemap © CARTO<br>"
           "Filmed from the real application. Narration: synthetic voice (Kokoro). Music: synthesized.</small></div>", "solid")
    f.run(1500)
    f.board("End card", "Sources, licences and the disclaimer, held until the narration ends.")
    f.wait_voice(2200)
