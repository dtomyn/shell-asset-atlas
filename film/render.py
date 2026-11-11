"""Render the Shell Asset Atlas explainer from the real application, one exact frame at a time.

The story (scenes, narration, clicks) is in film/scenes.py. This file is the machinery: it serves
the built app, opens it in headless Edge with the page's clock paused, and steps that clock one
frame at a time while it moves a cursor over the real controls. Narration is voiced first and its
length sets the timing, so changing a line retimes the picture.

  render.py --storyboard    Storyboard page, script, captions, thumbnail and YouTube text. About 2 minutes.
  render.py --preview       Quick 960x540 video to check timing and sound.
  render.py                 The 1080p film and all of the above. About an hour and a half.
  render.py --remix         Rebuilds only the sound on the film already rendered. Under a minute.

Options: --url puts an address on the end card. --scale 1.6 renders 1440p. --no-build skips `npm run build`.
         --no-music leaves out the synthesized bed (clicks stay).

Needs: playwright, imageio-ffmpeg, kokoro-onnx, soundfile, numpy, and Microsoft Edge. The voice is
Kokoro af_heart, the same model and settings as C:/DevSource/IRISIdeas/scripts/render_explainer.py.
Its model files (kokoro-v1.0.onnx, voices-v1.0.bin from github.com/thewh1teagle/kokoro-onnx) are
read from KOKORO_DIR, by default IRISIdeas' .venv/kokoro. The simplest way to run this is with
that project's interpreter:

  C:/DevSource/IRISIdeas/.venv/Scripts/python.exe film/render.py

To use a real voice, save a line as film/out/vo/recorded/<id>.wav (ids are in script.md).
"""
import argparse
import base64
import datetime
import functools
import hashlib
import html
import http.server
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time

import imageio_ffmpeg
import numpy
import soundfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILM = ROOT / "film"
WEB = ROOT / "web"
OUT = FILM / "out"
NAME = "shell-asset-atlas-explainer"
LAYOUT = (1600, 900)  # CSS pixels. Scale 1.2 gives 1920x1080 and keeps the interface readable on a phone.
SCALE_MASTER, SCALE_PREVIEW, SCALE_BOARD = 1.2, 0.6, 0.8
VOICE_DIR = OUT / "vo"
VOICE_MODEL = pathlib.Path(os.environ.get("KOKORO_DIR", r"C:\DevSource\IRISIdeas\.venv\kokoro"))
VOICE, VOICE_SPEED, VOICE_RATE = "af_heart", 0.97, 24000
# Words the voice reads wrongly from their spelling, given as sounds: {"wrong phonemes": "right phonemes"}.
SOUNDS = {}
CAPTION_MAX = 84
BED_RATE = 48000
CLOCK_START = datetime.datetime(2026, 1, 1, 12, 0, 0)

sys.path.insert(0, str(FILM))


# --- voice ------------------------------------------------------------------------------------

class Voice:
    """Voices each line once and keeps it in film/out/vo. A line is remade only when its text changes."""

    def __init__(self):
        VOICE_DIR.mkdir(parents=True, exist_ok=True)
        (VOICE_DIR / "recorded").mkdir(exist_ok=True)
        self.book = VOICE_DIR / "made.json"
        self.made = json.loads(self.book.read_text(encoding="utf-8")) if self.book.exists() else {}
        self.engine = None

    def line(self, line_id, text):
        """Returns (path, length in ms)."""
        path = VOICE_DIR / "recorded" / f"{line_id}.wav"
        if not path.exists():
            path = VOICE_DIR / f"{line_id}.wav"
            key = hashlib.sha1(f"{VOICE}|{VOICE_SPEED}|{SOUNDS}|{text}".encode()).hexdigest()
            if self.made.get(line_id) != key or not path.exists():
                if self.engine is None:
                    from kokoro_onnx import Kokoro
                    self.engine = Kokoro(str(VOICE_MODEL / "kokoro-v1.0.onnx"), str(VOICE_MODEL / "voices-v1.0.bin"))
                sounds = self.engine.tokenizer.phonemize(text, lang="en-us")
                for wrong, right in SOUNDS.items():
                    sounds = sounds.replace(wrong, right)
                audio, rate = self.engine.create(sounds, voice=VOICE, speed=VOICE_SPEED, is_phonemes=True)
                soundfile.write(str(path), audio, rate)
                self.made[line_id] = key
                self.book.write_text(json.dumps(self.made, indent=1), encoding="utf-8")
                with open(VOICE_DIR / "phonemes.txt", "a", encoding="utf-8") as log:
                    log.write(f"{line_id}\t{text}\n\t{sounds}\n")
                print("voice", line_id, flush=True)
        return path, round(soundfile.info(str(path)).duration * 1000)


# --- the film: a clock, a cursor and a list of what was said ------------------------------------

class Film:
    def __init__(self, page, fps, encoder, quality, settle_s, url):
        self.page = page
        self.frame_ms = 1000 / fps
        self.encoder = encoder
        self.quality = quality
        self.settle_s = settle_s
        self.url = url
        self.voice = Voice()
        self.t = 0.0          # film time in ms
        self.ticked = 0       # whole ms the page's clock has been advanced
        self.frames = 0
        self.voice_end = 0.0
        self.cursor = (LAYOUT[0] * 0.62, LAYOUT[1] * 0.55)
        self.voiced, self.chapters, self.boards, self.sounds = [], [], [], []
        self.thumbnail = None
        self.started = time.time()

    # clock
    def settle(self, limit):
        """Waits (in real time, the film's clock is stopped) for map tiles, then redraws the map."""
        deadline = time.time() + limit
        while not self.page.evaluate("__film.ready()") and time.time() < deadline:
            time.sleep(0.03)
        self.page.evaluate("__film.redraw()")
        self.page.evaluate("t => __film.tick(t)", self.t)

    def step(self):
        self.t += self.frame_ms
        ticks = round(self.t) - self.ticked
        self.ticked += ticks
        self.page.clock.run_for(ticks)
        ready = self.page.evaluate("t => __film.tick(t)", self.t)
        if self.encoder:
            if not ready:
                self.settle(self.settle_s)
            self.encoder.stdin.write(self.page.screenshot(type="jpeg", quality=self.quality))
        self.frames += 1
        if self.frames % 300 == 0:
            scene = self.chapters[-1]["id"] if self.chapters else ""
            print(f"frame {self.frames} ({self.t / 1000:.0f}s of film), {time.time() - self.started:.0f}s elapsed, scene {scene}", flush=True)

    def run(self, ms):
        end = self.t + ms
        while self.t < end - 0.5:
            self.step()

    def until(self, at):
        self.run(at - self.t)

    def wait_voice(self, pad=450):
        """Runs until the narration so far has been said."""
        self.until(self.voice_end + pad)

    def wait_text(self, selector, text, limit_ms=30000):
        end = self.t + limit_ms
        while text not in (self.page.text_content(selector) or ""):
            if self.t > end:
                raise SystemExit(f"{selector} never read {text!r}")
            self.step()

    # story
    def chapter(self, chapter_id, title, shows, camera, sound):
        self.chapters.append({"id": chapter_id, "title": title, "shows": shows, "camera": camera, "sound": sound, "at": self.t})
        if len(self.chapters) > 1:
            self.page.evaluate("([n, t]) => __film.chapter(n, t)", [f"{len(self.chapters) - 1:02}", title])

    def say(self, line_id, text, lead=250):
        """Queues a line after whatever is still being said, and returns the film time at which it ends."""
        path, length = self.voice.line(line_id, text)
        at = max(self.t + lead, self.voice_end + 380)
        self.voiced.append({"id": line_id, "text": text, "at": at, "end": at + length, "path": str(path), "scene": self.chapters[-1]["id"]})
        self.voice_end = at + length
        return self.voice_end

    def board(self, title, why, thumb=False):
        """Keeps this moment as a storyboard frame."""
        self.settle(6)
        shot = self.page.screenshot(type="jpeg", quality=62, scale="css")
        self.boards.append({"title": title, "why": why, "at": self.t, "scene": self.chapters[-1]["id"], "image": base64.b64encode(shot).decode()})
        if thumb:
            self.thumbnail = self.page.screenshot(type="jpeg", quality=90)

    def card(self, body=None, kind="scrim"):
        self.page.evaluate("([h, k]) => __film.card(h, k)", [body, kind])

    def js(self, expression, arg=None):
        return self.page.evaluate(expression, arg)

    # cursor
    def point(self, target):
        if isinstance(target, str):
            box = self.page.locator(target).first.bounding_box()
            if not box:
                raise SystemExit(f"nothing on screen matches {target}")
            return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        return target

    def pick(self, asset_id, lnglat):
        """Where to point so that the app's own picking returns this asset."""
        spot = self.page.evaluate("([id, at]) => __film.pick(id, at)", [asset_id, lnglat])
        if not spot:
            raise SystemExit(f"{asset_id} can't be picked on screen from this camera")
        return tuple(spot)

    def expect(self, selector, text):
        """Stops the render if the page doesn't show what the narration is about to say it shows."""
        seen = self.page.text_content(selector, timeout=3000) or ""
        if text not in seen:
            raise SystemExit(f"{selector} shows {seen[:80]!r}, expected {text!r}")

    def reveal(self, selector):
        """If the target is scrolled out of its panel, puts the cursor on the panel and wheels it into view."""
        for _ in range(3):
            need = self.page.evaluate("s => __film.scrollNeed(s)", selector)
            if not need:
                return
            if abs(self.cursor[0] - need["x"]) > 100 or abs(self.cursor[1] - need["y"]) > 150:
                self.move((need["x"], need["y"]), 550)
            self.wheel(need["dy"], 500 + min(700, abs(need["dy"]) * 2))
            self.run(120)

    def move(self, target, ms=650):
        if isinstance(target, str):
            self.reveal(target)
        x1, y1 = self.point(target)
        x0, y0 = self.cursor
        steps = max(1, round(ms / self.frame_ms))
        for i in range(1, steps + 1):
            k = i / steps
            k = k * k * (3 - 2 * k)
            self.page.mouse.move(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k)
            self.step()
        self.cursor = (x1, y1)

    def hover(self, asset_id, lnglat, ms=1100):
        """Points at an asset on the map, and settles the pointer the way a hand does, so the app's hover card is up."""
        x, y = self.pick(asset_id, lnglat)
        self.move((x, y), ms)
        for dx in (1.5, 0):
            self.page.mouse.move(x + dx, y)
            self.step()

    def press(self, hold=100):
        self.page.mouse.down()
        self.sounds.append((self.t, "click"))
        self.run(hold)
        self.page.mouse.up()

    def click(self, target, ms=650, after=200):
        self.move(target, ms)
        self.run(90)
        self.press()
        self.run(after)

    def wheel(self, dy, ms=900):
        steps = max(1, round(ms / self.frame_ms))
        done = 0
        for i in range(1, steps + 1):
            k = i / steps
            target = round(dy * k * k * (3 - 2 * k))
            self.page.mouse.wheel(0, target - done)
            done = target
            self.step()

    def key(self, name, label=None, after=200):
        if label:
            self.page.evaluate("([c, l]) => __film.key(c, l)", [name if len(name) == 1 else {"Escape": "Esc", "Enter": "Enter", " ": "Space"}.get(name, name), label])
            self.run(250)
        self.page.keyboard.press("Space" if name == " " else name)
        self.sounds.append((self.t, "key"))
        self.run(after)

    def type(self, text, per=95):
        for ch in text:
            self.page.keyboard.type(ch)
            self.sounds.append((self.t, "key"))
            self.run(per)

    def timeline(self):
        return {"total": self.t, "voiced": self.voiced, "chapters": self.chapters, "sounds": self.sounds}


# --- sound ------------------------------------------------------------------------------------

PAD_CHORDS = [  # D minor 9, B flat major 7, F major 7, C add 9
    [73.42, 110.00, 174.61, 261.63, 329.63],
    [58.27, 87.31, 146.83, 220.00, 293.66],
    [87.31, 130.81, 220.00, 261.63, 329.63],
    [65.41, 98.00, 164.81, 293.66, 392.00],
]


def write_bed(total_ms, sounds, path, music=True):
    """A quiet synthesized pad, plus a tick for every click and key press. The same input gives the same file."""
    n = int(total_ms / 1000 * BED_RATE) + BED_RATE
    bed = numpy.zeros((n, 2), dtype="float32")
    if music:
        rng = numpy.random.default_rng(7)
        chord_s, cross_s = 11.0, 4.0
        for index in range(int(n / BED_RATE / chord_s) + 2):
            start = int((index * chord_s - cross_s / 2) * BED_RATE)
            length = int((chord_s + cross_s) * BED_RATE)
            a, b = max(0, start), min(n, start + length)
            if a >= b:
                continue
            t = numpy.arange(a, b, dtype="float64") / BED_RATE
            local = (numpy.arange(a, b) - start) / BED_RATE
            envelope = numpy.clip(numpy.minimum(local, chord_s + cross_s - local) / cross_s, 0, 1)
            envelope = 0.5 - 0.5 * numpy.cos(numpy.pi * envelope)
            for rank, freq in enumerate(PAD_CHORDS[index % len(PAD_CHORDS)]):
                weight = 1.0 / (1 + rank * 0.55)
                swell = 0.72 + 0.28 * numpy.sin(2 * numpy.pi * rng.uniform(0.05, 0.12) * t + rng.uniform(0, 6.28))
                for channel, detune in enumerate((0.9982, 1.0018)):
                    wave = numpy.sin(2 * numpy.pi * freq * detune * t) + 0.22 * numpy.sin(2 * numpy.pi * freq * 2 * detune * t + 1.0)
                    bed[a:b, channel] += (wave * swell * envelope * weight).astype("float32")
        bed *= 0.07 / max(1e-6, float(numpy.abs(bed).max()))
        fade_in, fade_out = int(2.5 * BED_RATE), int(4 * BED_RATE)
        bed[:fade_in] *= numpy.linspace(0, 1, fade_in, dtype="float32")[:, None]
        end = int(total_ms / 1000 * BED_RATE)
        bed[end - fade_out:end] *= numpy.linspace(1, 0, fade_out, dtype="float32")[:, None]
        bed[end:] = 0
    for at, kind in sounds:
        freq, level, decay = (1150, 0.10, 0.012) if kind == "click" else (1700, 0.04, 0.006)
        t = numpy.arange(int(0.05 * BED_RATE)) / BED_RATE
        tick = (numpy.sin(2 * numpy.pi * freq * t) * numpy.exp(-t / decay) * level).astype("float32")
        start = int(at / 1000 * BED_RATE)
        bed[start:start + len(tick)] += tick[:max(0, n - start), None]
    soundfile.write(str(path), bed, BED_RATE)


def write_narration(timeline, path):
    """Lays every line on one track at the moment the picture expects it."""
    track = numpy.zeros(int(timeline["total"] / 1000 * VOICE_RATE) + VOICE_RATE, dtype="float32")
    for said in timeline["voiced"]:
        audio, rate = soundfile.read(said["path"], dtype="float32", always_2d=True)
        audio = audio.mean(axis=1)
        if rate != VOICE_RATE:
            audio = numpy.interp(numpy.arange(int(len(audio) * VOICE_RATE / rate)) * rate / VOICE_RATE, numpy.arange(len(audio)), audio).astype("float32")
        start = int(said["at"] / 1000 * VOICE_RATE)
        track[start:start + len(audio)] += audio[:len(track) - start]
    soundfile.write(str(path), track, VOICE_RATE)


def mix(ffmpeg, video, bed, narration, final):
    """Muxes picture, bed and narration, levelled for YouTube. The bed ducks under the voice. Same graph as IRISIdeas."""
    graph = ("[2:a]aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=70,acompressor=threshold=0.12:ratio=2.5:attack=8:release=160:makeup=1.6,asplit[voice][key];"
             "[1:a][key]sidechaincompress=threshold=0.02:ratio=7:attack=25:release=650[bed];"
             "[bed][voice]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11:linear=false,aresample=48000[out]")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(video), "-i", str(bed), "-i", str(narration), "-filter_complex", graph, "-map", "0:v", "-map", "[out]",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", str(final)], check=True)


def sound(ffmpeg, timeline, silent, final, music):
    """Builds the bed and the narration track from the timeline and lays them on the silent picture, which is kept for --remix."""
    bed, narration = OUT / f"{NAME}-bed.wav", VOICE_DIR / "narration.wav"
    write_bed(timeline["total"], timeline["sounds"], bed, music)
    write_narration(timeline, narration)
    mix(ffmpeg, silent, bed, narration, final)
    print("wrote", final, round(final.stat().st_size / 1e6, 1), "MB", flush=True)


# --- the paper trail: captions, script, storyboard, YouTube text ----------------------------------

def stamp(ms, sep="."):
    total = int(ms)
    return f"{total // 3600000:02}:{total // 60000 % 60:02}:{total // 1000 % 60:02}{sep}{total % 1000:03}"


def clock_label(ms):
    seconds = int(ms // 1000)
    return f"{seconds // 60}:{seconds % 60:02}"


def caption_parts(text):
    """Breaks a line at its sentences, then its commas, so no caption is too long to read."""
    parts = []
    for sentence in re.split(r"(?<=[.?!:])\s+", text):
        current = ""
        for piece in re.split(r"(?<=,)\s+", sentence):
            if current and len(current) + len(piece) + 1 > CAPTION_MAX:
                parts.append(current)
                current = piece
            else:
                current = f"{current} {piece}".strip()
        parts.append(current)
    return parts


def write_captions(timeline):
    lines, count = [], 0
    for said in timeline["voiced"]:
        parts = caption_parts(said["text"])
        total = sum(map(len, parts))
        at = said["at"]
        for part in parts:
            end = at + (said["end"] - said["at"]) * len(part) / total
            count += 1
            lines += [str(count), f"{stamp(at, ',')} --> {stamp(end, ',')}", part, ""]
            at = end
    (OUT / f"{NAME}.srt").write_text("\n".join(lines), encoding="utf-8")


def write_script(timeline, facts):
    parts = [f"# Shell Asset Atlas: explainer script\n\n{clock_label(timeline['total'])} in all. Written by `film/render.py` from `film/scenes.py`, "
             f"with numbers from the data built {facts['built']} (timeline to {facts['end_month']}). Voice: Kokoro `{VOICE}` at speed {VOICE_SPEED}. "
             "To replace a line with a real recording, save it as `film/out/vo/recorded/<id>.wav` and render again.\n"]
    for chapter in timeline["chapters"]:
        parts.append(f"\n## {clock_label(chapter['at'])} {chapter['title']}\n\n**Shows:** {chapter['shows']}\n\n**Camera and cursor:** {chapter['camera']}\n\n**Sound:** {chapter['sound']}\n")
        parts.extend(f"\n`{clock_label(said['at'])}` `{said['id']}` {said['text']}\n" for said in timeline["voiced"] if said["scene"] == chapter["id"])
    (OUT / "script.md").write_text("".join(parts), encoding="utf-8")


def write_youtube_text(timeline, facts, url):
    chapters = "\n".join(f"{clock_label(c['at'])} {c['title']}" for c in timeline["chapters"])
    text = f"""TITLE
A decade of offshore production on one globe, from public records | Shell Asset Atlas (unofficial)

DESCRIPTION
Oil and gas operators report what they produce to public regulators every month. Shell Asset Atlas puts those records on a 3D globe: {facts['assets']} installations and sites, {facts['fields']} fields, {facts['pipeline_km']:,} km of pipelines and a production history you can replay month by month.

Try it yourself: {url or '[add the link]'}

Everything in this video is the real application, filmed frame by frame, with the cursor pressing the real controls. The narration uses a synthetic voice (Kokoro). The music is synthesized.

{chapters}

Sources: US Bureau of Ocean Energy Management (BOEM / BSEE Data Center), North Sea Transition Authority (Open Government Licence v3.0), Norwegian Offshore Directorate (NLOD 2.0), OpenStreetMap contributors (ODbL), NASA EOSDIS GIBS imagery, CARTO basemap. Data built {facts['built']}.
Production is gross (100%) volume for the asset, not Shell's net share, unless it says net. Retail counts are what OpenStreetMap volunteers have mapped, not an official network size.
Unofficial portfolio project. Not affiliated with, or endorsed by, Shell plc. No Shell logos or proprietary data are used.

TAGS
data visualization, open data, offshore, oil and gas, energy, MapLibre, WebGL, 3D globe, production data, Gulf of America, North Sea, portfolio project
"""
    (OUT / "youtube.txt").write_text(text, encoding="utf-8")


STORYBOARD_CSS = """
:root { --bg: #f5f6f8; --panel: #fff; --ink: #161b26; --muted: #5a6577; --line: #dde1e8; --accent: #a8620a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #070a0f; --panel: #10161f; --ink: #e7ebf3; --muted: #94a1b8; --line: #27304280; --accent: #ffb703; } }
:root[data-theme="dark"] { --bg: #070a0f; --panel: #10161f; --ink: #e7ebf3; --muted: #94a1b8; --line: #27304280; --accent: #ffb703; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/1.5 "Segoe UI", system-ui, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 30px; line-height: 1.2; margin: 0 0 6px; }
.lede { color: var(--muted); margin: 0 0 12px; max-width: 76ch; }
section { margin-top: 36px; border-top: 1px solid var(--line); padding-top: 18px; }
h2 { font-size: 20px; margin: 0 0 2px; }
h2 time { color: var(--accent); font-variant-numeric: tabular-nums; margin-right: 10px; }
dl { display: grid; grid-template-columns: 76px 1fr; gap: 3px 12px; margin: 10px 0 16px; }
dt { color: var(--muted); font-size: 13px; }
dd { margin: 0; }
.boards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
figure img { display: block; width: 100%; height: auto; }
figcaption { padding: 10px 12px 12px; font-size: 14px; }
figcaption b { display: block; font-weight: 600; }
figcaption time { color: var(--accent); font-variant-numeric: tabular-nums; }
.said { margin: 0 0 16px; padding-left: 14px; border-left: 3px solid var(--accent); }
.said p { margin: 0 0 6px; }
.said time { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; margin-right: 6px; }
"""


def write_storyboard(timeline, boards, facts):
    parts = []
    for chapter in timeline["chapters"]:
        figures = "".join(
            f"<figure><img alt=\"{html.escape(b['title'])}\" src=\"data:image/jpeg;base64,{b['image']}\"><figcaption>"
            f"<time>{clock_label(b['at'])}</time> <b>{html.escape(b['title'])}</b>{html.escape(b['why'])}</figcaption></figure>"
            for b in boards if b["scene"] == chapter["id"])
        said = "".join(f"<p><time>{clock_label(s['at'])}</time>{html.escape(s['text'])}</p>" for s in timeline["voiced"] if s["scene"] == chapter["id"])
        parts.append(
            f"<section><h2><time>{clock_label(chapter['at'])}</time>{html.escape(chapter['title'])}</h2><dl>"
            f"<dt>Shows</dt><dd>{html.escape(chapter['shows'])}</dd>"
            f"<dt>Camera</dt><dd>{html.escape(chapter['camera'])}</dd>"
            f"<dt>Sound</dt><dd>{html.escape(chapter['sound'])}</dd></dl>"
            f"<div class=\"said\">{said}</div>"
            f"<div class=\"boards\">{figures}</div></section>")
    page = (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>Shell Asset Atlas Storyboard</title><style>{STORYBOARD_CSS}</style></head><body><main>"
        "<h1>Shell Asset Atlas: explainer storyboard</h1>"
        f"<p class=\"lede\">{clock_label(timeline['total'])}, {len(timeline['chapters'])} chapters, {len(timeline['voiced'])} narrated lines. Every frame here is the real application, "
        "captured by <code>film/render.py</code> while it pressed the real controls, and the narration and timing come from <code>film/scenes.py</code>. "
        f"Numbers come from the data built {html.escape(facts['built'])}.</p>"
        "<p class=\"lede\">Unofficial portfolio project. Not affiliated with, or endorsed by, Shell plc. The narration uses a synthetic voice.</p>"
        + "".join(parts) + "</main></body></html>")
    path = OUT / "storyboard.html"
    path.write_text(page, encoding="utf-8")
    print("wrote", path, round(path.stat().st_size / 1e6, 1), "MB", flush=True)


# --- running it -----------------------------------------------------------------------------

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(WEB / "dist"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def open_app(playwright, port, scale):
    """Loads the app once to warm the browser's cache, then again with the clock stopped at the moment the app reveals itself."""
    browser = playwright.chromium.launch(channel="msedge", headless=True, args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-smooth-scrolling"])
    context = browser.new_context(viewport={"width": LAYOUT[0], "height": LAYOUT[1]}, device_scale_factor=scale)
    address = f"http://127.0.0.1:{port}/?film"
    warm = context.new_page()
    warm.goto(address)
    warm.wait_for_function("window.__atlas && !document.getElementById('loader')", timeout=90000)
    warm.wait_for_timeout(6000)
    warm.close()

    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script(path=str(FILM / "overlay.js"))
    page.clock.install(time=CLOCK_START)
    page.goto(address, wait_until="commit")
    page.clock.pause_at(CLOCK_START + datetime.timedelta(seconds=20))
    deadline = time.time() + 90
    # The app hides its loader and starts its fly-in from space in the same breath. The film starts there.
    while not page.evaluate("!!window.__atlas && !!document.querySelector('#loader.done') && document.fonts.status === 'loaded'"):
        if time.time() > deadline:
            raise SystemExit(f"the app did not start: {errors}")
        page.clock.run_for(20)
        time.sleep(0.02)
    return browser, page, errors


def build():
    print("building the app", flush=True)
    subprocess.run("npm run build", cwd=str(WEB), shell=True, check=True, stdout=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--url", help="address to show on the end card and in the YouTube description")
    parser.add_argument("--storyboard", action="store_true", help="only the storyboard, script, captions, thumbnail and YouTube text")
    parser.add_argument("--preview", action="store_true", help="quick 960x540 render")
    parser.add_argument("--scale", type=float, default=SCALE_MASTER, help="1.2 is 1080p, 1.6 is 1440p")
    parser.add_argument("--no-build", action="store_true", help="film web/dist as it is")
    parser.add_argument("--no-music", action="store_true", help="leave out the synthesized bed")
    parser.add_argument("--remix", action="store_true", help="rebuild only the sound, from the last render's picture and timing")
    args = parser.parse_args()

    import scenes
    OUT.mkdir(parents=True, exist_ok=True)
    suffix = "-preview" if args.preview else ""
    silent = OUT / f"{NAME}{suffix}-silent.mp4"
    timing = OUT / f"timeline{suffix}.json"
    if args.remix:
        sound(imageio_ffmpeg.get_ffmpeg_exe(), json.loads(timing.read_text(encoding="utf-8")), silent, OUT / f"{NAME}{suffix}.mp4", not args.no_music)
        return
    if not args.no_build:
        build()
    facts = scenes.facts(WEB / "dist" / "data")
    server = serve()
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    draw = not args.storyboard
    scale = SCALE_BOARD if args.storyboard else SCALE_PREVIEW if args.preview else args.scale
    fps = 24 if args.preview else args.fps

    with sync_playwright() as playwright:
        browser, page, errors = open_app(playwright, server.server_address[1], scale)
        encoder = None
        if draw:
            encoder = subprocess.Popen(
                [ffmpeg, "-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-r", str(fps), "-i", "-",
                 # Screenshot JPEGs are full-range BT.601. Convert to standard video range so every player shows the same colours.
                 "-vf", "scale=in_color_matrix=bt601:out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv420p",
                 "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
                 "-c:v", "libx264", "-preset", "veryfast" if args.preview else "medium", "-crf", "26" if args.preview else "17", "-movflags", "+faststart", str(silent)],
                stdin=subprocess.PIPE,
            )
        film = Film(page, fps, encoder, 70 if args.preview else 94, 0.4 if args.preview else 2.0, args.url)
        try:
            scenes.play(film, facts)
        except BaseException:
            # Leave a picture of where the story stopped, and say what the page thought was under the cursor.
            (OUT / "failed.jpg").write_bytes(page.screenshot(type="jpeg", quality=80))
            print("stopped at", clock_label(film.t), "in", film.chapters[-1]["id"] if film.chapters else "", "cursor", film.cursor, "see", OUT / "failed.jpg", flush=True)
            print("under cursor:", page.evaluate("([x, y]) => document.elementsFromPoint(x, y).slice(0, 4).map(e => e.tagName + '#' + e.id + '.' + e.className)", list(film.cursor)), flush=True)
            if encoder:
                encoder.stdin.close()
            raise
        timeline = film.timeline()
        browser.close()

    print("frames", film.frames, "length", clock_label(timeline["total"]), "boards", len(film.boards), "errors", errors, flush=True)
    write_storyboard(timeline, film.boards, facts)
    write_captions(timeline)
    write_script(timeline, facts)
    write_youtube_text(timeline, facts, args.url)
    if film.thumbnail:
        (OUT / "thumbnail.jpg").write_bytes(film.thumbnail)
    if draw:
        encoder.stdin.close()
        encoder.wait()
        timing.write_text(json.dumps(timeline, indent=1), encoding="utf-8")
        sound(ffmpeg, timeline, silent, OUT / f"{NAME}{suffix}.mp4", not args.no_music)
    if errors:
        raise SystemExit("the page reported errors")


if __name__ == "__main__":
    main()
