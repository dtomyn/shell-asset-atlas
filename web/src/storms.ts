// Gulf storms: historical tracks replayed over the production timeline, the estimated
// production each one deferred, and a snapshot of the live NHC forecast with the
// "production in the path". Everything shown is read from storms.json (pipeline/atlas/
// sources/storms.py and storms_live.py); nothing here is hard-coded.
import type { ExpressionSpecification, GeoJSONSource, LngLatBoundsLike, Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import { fmtMonth, fmtNum } from './chart';
import { seriesAt, type Atlas } from './data';
import { escapeHtml } from './map';
import { STORM_CLASSES, productionInPath, stormClass, trackAt, type Hub, type LngLat, type TrackPoint } from './storm-risk';

export interface StormHub {
  series: string;
  name: string;
  month: string;
  /** closest pass of the storm centre, and its wind there */
  km: number;
  kt: number;
  baseline?: number;
  low?: number;
  deferred_mboe?: number;
  months?: number;
  recovered?: boolean;
  /** the dip is counted under this other storm (same month, or before recovery) */
  shared_with?: string;
}

export interface Storm {
  id: string;
  name: string;
  year: number;
  peak_kt: number;
  /** month of the closest pass to a Shell structure */
  month: string;
  closest_km: number;
  structures: number;
  track: TrackPoint[];
  hubs: StormHub[];
  deferred_mboe: number | null;
  months: number | null;
  recovered: boolean | null;
}

export interface LiveSystem {
  id: string;
  name: string | null;
  classification: string | null;
  wind_kt: number | null;
  pressure_mb: number | null;
  lon: number | null;
  lat: number | null;
  updated: string | null;
  advisory: string | null;
  url: string | null;
  track?: LngLat[] | null;
  cone?: LngLat[] | null;
}

export interface StormData {
  through: number | null;
  method: { radius_km: number; min_kt: number; baseline_months: number; recovery: number; horizon_months: number; noise_factor: number };
  storms: Storm[];
  live: { systems: LiveSystem[]; checked_at: string } | null;
}

/** Storms are an optional layer: a missing or broken file must never stop the app. */
export async function loadStorms(): Promise<StormData | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/storms.json`);
    if (!r.ok) return null;
    const d = (await r.json()) as StormData;
    return Array.isArray(d?.storms) && d.method ? d : null;
  } catch {
    return null;
  }
}

export const hubLabel = (name: string) => name.replace(/\s*\([^)]*\)$/, '');
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Hubs where this storm carries a deferred-volume estimate. */
export const hubsHit = (s: Storm) => s.hubs.filter((h) => h.deferred_mboe != null);

const LIVE_CLASS: Record<string, string> = {
  HU: 'Hurricane',
  MH: 'Major hurricane',
  TS: 'Tropical storm',
  TD: 'Tropical depression',
  STS: 'Subtropical storm',
  STD: 'Subtropical depression',
  PTC: 'Potential tropical cyclone',
  PC: 'Post-tropical cyclone',
};

const LAYERS = ['storm-track-glow', 'storm-track', 'storm-eye-halo', 'storm-eye', 'storm-eye-label', 'storm-live-cone', 'storm-live-cone-line', 'storm-live-track', 'storm-live-pos', 'storm-live-label'];
const IDLE_MS = 2600; // one pass along the month's stretch of track when the timeline is paused
const IDLE_HOLD_MS = 1400;
const REPLAY_LEAD_MS = 2400; // time on the month before, while the camera flies in
const REPLAY_STORM_MS = 2600;
const REPLAY_AFTER_MS = 900;

interface Indexed extends Storm {
  /** timeline month indexes: first and last month of the track, the impact month, and the last month before recovery */
  first: number;
  last: number;
  m: number;
  until: number;
  segments: Feature<LineString, { cls: number; ghost: number }>[];
}

export interface StormHooks {
  /** last month of the timeline */
  endIdx: number;
  setMonth(idx: number): void;
  stopPlay(): void;
  onToggle(on: boolean): void;
}

export class Storms {
  private storms: Indexed[];
  private visible = true;
  private month = 0;
  private raf = 0;
  private loopTimer = 0;
  private replay: { id: string; timer: number } | null = null;
  private replayMs: number | undefined;
  private selected: string | null = null;
  private reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private map: MLMap;
  private atlas: Atlas;
  private data: StormData;
  private el: HTMLElement;
  private hooks: StormHooks;

  constructor(map: MLMap, atlas: Atlas, data: StormData, el: HTMLElement, hooks: StormHooks) {
    this.map = map;
    this.atlas = atlas;
    this.data = data;
    this.el = el;
    this.hooks = hooks;
    const months = atlas.production.months;
    const idxOf = (minutes: number) => months.indexOf(new Date(minutes * 60000).toISOString().slice(0, 7));
    this.storms = data.storms
      .filter((s) => s.track.length >= 2)
      .map((s) => {
        const m = months.indexOf(s.month);
        return {
          ...s,
          m,
          first: idxOf(s.track[0][0]),
          last: idxOf(s.track[s.track.length - 1][0]),
          until: m + Math.max(0, (s.months ?? 0) - 1),
          segments: s.track.slice(1).map((b, i) => {
            const a = s.track[i];
            return {
              type: 'Feature' as const,
              geometry: { type: 'LineString' as const, coordinates: [[a[2], a[1]], [b[2], b[1]]] },
              properties: { cls: stormClass(Math.max(a[3], b[3]), a[4]), ghost: 0 },
            };
          }),
        };
      })
      .filter((s) => s.m >= 0 && s.first >= 0 && s.last >= 0 && s.m <= hooks.endIdx);
    this.addLayers();
    this.renderPanel();
  }

  // --- map ------------------------------------------------------------------------------
  private addLayers() {
    const map = this.map;
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const classColor = ['match', ['get', 'cls'], ...STORM_CLASSES.flatMap((c, i) => [i, c.color]), STORM_CLASSES[0].color] as unknown as ExpressionSpecification;
    const font = ['Montserrat Medium', 'Open Sans Regular'];
    map.addSource('storm-tracks', { type: 'geojson', data: empty });
    map.addSource('storm-eye', { type: 'geojson', data: empty });
    map.addSource('storm-live-cone', { type: 'geojson', data: empty });
    map.addSource('storm-live-track', { type: 'geojson', data: empty });
    map.addSource('storm-live-pos', { type: 'geojson', data: empty });

    map.addLayer({
      id: 'storm-live-cone',
      type: 'fill',
      source: 'storm-live-cone',
      paint: { 'fill-color': '#ff5d8f', 'fill-opacity': 0.14 },
    });
    map.addLayer({
      id: 'storm-live-cone-line',
      type: 'line',
      source: 'storm-live-cone',
      paint: { 'line-color': '#ff5d8f', 'line-width': 1.2, 'line-opacity': 0.8 },
    });
    map.addLayer({
      id: 'storm-live-track',
      type: 'line',
      source: 'storm-live-track',
      paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-dasharray': [2, 2], 'line-opacity': 0.85 },
    });
    map.addLayer({
      id: 'storm-track-glow',
      type: 'line',
      source: 'storm-tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': classColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 4, 6, 12],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 1, 3, 6, 8],
        'line-opacity': ['case', ['==', ['get', 'ghost'], 1], 0.08, 0.3],
      },
    });
    map.addLayer({
      id: 'storm-track',
      type: 'line',
      source: 'storm-tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': classColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.4, 6, 3.2],
        'line-opacity': ['case', ['==', ['get', 'ghost'], 1], 0.28, 0.95],
      },
    });
    map.addLayer({
      id: 'storm-eye-halo',
      type: 'circle',
      source: 'storm-eye',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 9, 6, 34],
        'circle-color': classColor,
        'circle-blur': 0.9,
        'circle-opacity': 0.5,
      },
    });
    map.addLayer({
      id: 'storm-eye',
      type: 'circle',
      source: 'storm-eye',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 6, 7],
        'circle-color': '#070a0f',
        'circle-stroke-color': classColor,
        'circle-stroke-width': 3,
      },
    });
    map.addLayer({
      id: 'storm-eye-label',
      type: 'symbol',
      source: 'storm-eye',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': font,
        'text-size': 12,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(7,10,15,0.92)', 'text-halo-width': 1.6 },
    });
    map.addLayer({
      id: 'storm-live-pos',
      type: 'circle',
      source: 'storm-live-pos',
      paint: { 'circle-radius': 7, 'circle-color': '#ff5d8f', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    });
    map.addLayer({
      id: 'storm-live-label',
      type: 'symbol',
      source: 'storm-live-pos',
      layout: { 'text-field': ['get', 'label'], 'text-font': font, 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(7,10,15,0.92)', 'text-halo-width': 1.6 },
    });

    const systems = this.data.live?.systems ?? [];
    const polygons: Feature<Polygon>[] = [];
    const lines: Feature<LineString>[] = [];
    const points: Feature<Point>[] = [];
    for (const s of systems) {
      if (s.cone && s.cone.length >= 4) polygons.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [s.cone] }, properties: {} });
      if (s.track && s.track.length >= 2) lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: s.track }, properties: {} });
      if (s.lon != null && s.lat != null) points.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { label: liveTitle(s) } });
    }
    this.setData('storm-live-cone', polygons);
    this.setData('storm-live-track', lines);
    this.setData('storm-live-pos', points);
  }

  private setData(source: string, features: Feature[]) {
    (this.map.getSource(source) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  /** Month index → [start, end) in minutes since the epoch. */
  private monthSpan(idx: number): [number, number] {
    const [y, mo] = this.atlas.production.months[idx].split('-').map(Number);
    return [Date.UTC(y, mo - 1, 1) / 60000, Date.UTC(y, mo, 1) / 60000];
  }

  /**
   * Show the storms of timeline month `idx`. Each storm's marker runs along the stretch of
   * track that falls inside the month, over `ms` (the playback tick), so a storm crosses the
   * Gulf while the towers shrink. With no `ms` (timeline paused) the pass repeats.
   */
  setMonth(idx: number, ms?: number) {
    this.month = idx;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.loopTimer);
    const active = this.storms.filter((s) => s.first <= idx && idx <= s.last);
    const ghosts = this.storms.filter((s) => idx > s.last && idx <= s.until && s.deferred_mboe != null);
    this.el.querySelectorAll<HTMLElement>('[data-storm]').forEach((row) => {
      const id = row.dataset.storm;
      row.classList.toggle('now', active.some((s) => s.id === id) || ghosts.some((s) => s.id === id));
    });
    if (!this.visible) return;
    this.setData('storm-tracks', [...ghosts.flatMap((s) => s.segments.map((f) => ({ ...f, properties: { ...f.properties, ghost: 1 } }))), ...active.flatMap((s) => s.segments)]);
    if (!active.length) return this.setData('storm-eye', []);

    const [m0, m1] = this.monthSpan(idx);
    const runs = active.map((s) => ({ s, t0: Math.max(m0, s.track[0][0]), t1: Math.min(m1, s.track[s.track.length - 1][0]) }));
    const draw = (p: number) =>
      this.setData(
        'storm-eye',
        runs.map(({ s, t0, t1 }) => {
          const at = trackAt(s.track, t0 + p * (t1 - t0));
          const cls = stormClass(at.kt, at.status);
          const day = new Date(at.t * 60000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
          return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [at.lng, at.lat] },
            properties: { cls, label: `${s.name} · ${STORM_CLASSES[cls].short} · ${at.kt} kt\n${day}` },
          } satisfies Feature<Point>;
        }),
      );
    const dur = this.replayMs ?? ms ?? IDLE_MS;
    const loop = !this.replay && ms === undefined;
    if (this.reduceMotion) return draw(1);
    const run = () => {
      const start = performance.now();
      const frame = (now: number) => {
        const p = Math.min(1, (now - start) / dur);
        draw(p);
        if (p < 1) this.raf = requestAnimationFrame(frame);
        else if (loop) this.loopTimer = window.setTimeout(run, IDLE_HOLD_MS);
      };
      this.raf = requestAnimationFrame(frame);
    };
    run();
  }

  get isVisible() {
    return this.visible;
  }

  setVisible(on: boolean) {
    this.visible = on;
    for (const id of LAYERS) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const cb = this.el.querySelector<HTMLInputElement>('input[data-storms-toggle]');
    if (cb) cb.checked = on;
    if (on) this.setMonth(this.month);
    else {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.loopTimer);
    }
  }

  // --- replay ---------------------------------------------------------------------------
  /**
   * Jump to the month before the storm, fly to the Gulf and step through the storm month(s)
   * slowly, then on to the month the hubs recovered.
   */
  play(id: string, opts: { fly?: boolean } = {}) {
    const s = this.storms.find((x) => x.id === id);
    if (!s) return;
    this.hooks.stopPlay(); // also ends any replay already running
    if (!this.visible) {
      this.setVisible(true);
      this.hooks.onToggle(true);
    }
    this.select(id);
    const end = Math.min(this.hooks.endIdx, Math.max(s.last, s.until + (s.recovered ? 1 : 0)));
    const start = Math.max(0, Math.min(s.first, s.m) - 1);
    this.replay = { id, timer: 0 };
    this.el.classList.add('replaying');
    this.hooks.setMonth(start);
    if (opts.fly !== false) this.flyToGulf(s);
    const step = (i: number) => {
      if (!this.replay) return;
      if (i > end) return this.stopReplay();
      const stormMonth = s.first <= i && i <= s.last;
      this.replayMs = stormMonth ? REPLAY_STORM_MS : REPLAY_AFTER_MS;
      this.hooks.setMonth(i);
      this.replay.timer = window.setTimeout(() => step(i + 1), this.replayMs);
    };
    this.replay.timer = window.setTimeout(() => step(start + 1), this.reduceMotion ? 600 : REPLAY_LEAD_MS);
  }

  stopReplay() {
    if (!this.replay) return;
    clearTimeout(this.replay.timer);
    this.replay = null;
    this.replayMs = undefined;
    this.el.classList.remove('replaying');
  }

  /** Frame Shell's Gulf structures plus the part of the track that crosses them. */
  private flyToGulf(s: Storm) {
    const pts = this.atlas.assets.features.filter((f) => f.properties.region === 'gom').map((f) => f.geometry.coordinates as LngLat);
    if (!pts.length) return;
    const box = (list: LngLat[], pad: number) => [
      Math.min(...list.map((p) => p[0])) - pad,
      Math.min(...list.map((p) => p[1])) - pad,
      Math.max(...list.map((p) => p[0])) + pad,
      Math.max(...list.map((p) => p[1])) + pad,
    ];
    const [w, sth, e, n] = box(pts, 3);
    const near = s.track.map((p) => [p[2], p[1]] as LngLat).filter((p) => p[0] >= w && p[0] <= e && p[1] >= sth && p[1] <= n);
    const [bw, bs, be, bn] = box([...pts, ...near], 0.5);
    const desktop = window.innerWidth >= 760;
    const cam = this.map.cameraForBounds([[bw, bs], [be, bn]] as LngLatBoundsLike, {
      padding: desktop ? { top: 70, bottom: 150, left: document.body.classList.contains('panel-open') ? 350 : 20, right: 20 } : { top: 120, bottom: 150, left: 10, right: 10 },
    });
    this.map.flyTo({ center: cam?.center ?? [(bw + be) / 2, (bs + bn) / 2], zoom: Math.min(cam?.zoom ?? 5, 6.4), pitch: 40, bearing: 0, duration: this.reduceMotion ? 0 : 2200, essential: true });
  }

  // --- live risk ------------------------------------------------------------------------
  /** One hub per Gulf production series, valued at the latest month the regulator has published. */
  private gulfHubs(): { hubs: Hub[]; month: string | undefined } {
    const P = this.atlas.production;
    const month = P.latest.gom;
    const idx = month ? P.months.indexOf(month) : -1;
    const byId = new Map<string, Hub>();
    for (const f of this.atlas.assets.features) {
      const p = f.properties;
      if (p.region !== 'gom' || !p.series || !P.series[p.series]) continue;
      let hub = byId.get(p.series);
      if (!hub) byId.set(p.series, (hub = { id: p.series, name: P.series[p.series].name, sites: [], kboed: seriesAt(P.series[p.series], idx)?.boe ?? 0 }));
      hub.sites.push(f.geometry.coordinates as LngLat);
    }
    return { hubs: [...byId.values()], month };
  }

  private liveHtml(): string {
    const live = this.data.live;
    if (!live) return '';
    const checked = new Date(live.checked_at);
    if (Number.isNaN(checked.getTime())) return '';
    const when = `${checked.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
    const days = Math.floor((Date.now() - checked.getTime()) / 86400000);
    const age = days >= 1 ? ` (${plural(days, 'day')} ago)` : '';
    const foot = `<small>NHC active-storms feed, checked ${escapeHtml(when)}${age}. A snapshot from the last data refresh, not a live feed.</small>`;
    if (!live.systems.length) return `<div class="storm-live quiet"><p><i></i>No active Atlantic systems at the last check</p>${foot}</div>`;
    const { hubs, month } = this.gulfHubs();
    const radius = this.data.method.radius_km;
    const rows = live.systems
      .map((s, i) => {
        const risk = productionInPath(hubs, s, radius);
        const basis = s.cone ? `inside the forecast cone or within ${fmtNum(radius)} km of the forecast track` : s.track ? `within ${fmtNum(radius)} km of the forecast track` : `within ${fmtNum(radius)} km of its current position`;
        const names = risk.hubs.map((h) => hubLabel(h.name)).join(', ');
        const link = s.url && /^https:\/\/www\.nhc\.noaa\.gov\//.test(s.url) ? ` · <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">NHC advisory${s.advisory ? ` ${escapeHtml(String(Number(s.advisory) || s.advisory))}` : ''}</a>` : '';
        return `<div class="storm-live-row">
          <button class="storm-live-name" data-live="${i}" title="Fly to this system"><i></i>${escapeHtml(liveTitle(s))}${s.wind_kt != null ? ` · ${fmtNum(s.wind_kt)} kt` : ''}</button>
          <p><b>${fmtNum(risk.kboed)} kboe/d</b> in the path: ${risk.hubs.length ? `${plural(risk.hubs.length, 'hub')} (${escapeHtml(names)})` : 'no Shell hub'} ${basis}. Gross production${month ? ` in ${fmtMonth(month, true)}` : ''}; not a forecast of shut-ins${link}.</p>
        </div>`;
      })
      .join('');
    return `<div class="storm-live active">${rows}${foot}</div>`;
  }

  // --- panel ----------------------------------------------------------------------------
  private renderPanel() {
    const m = this.data.method;
    const ranked = [...this.storms].sort((a, b) => (b.deferred_mboe ?? -1) - (a.deferred_mboe ?? -1) || b.track[0][0] - a.track[0][0]);
    const nameOf = (id: string) => this.storms.find((s) => s.id === id)?.name ?? id;
    const rows = ranked
      .map((s) => {
        const cls = STORM_CLASSES[stormClass(s.peak_kt)];
        const hit = hubsHit(s);
        const shared = s.hubs.find((h) => h.shared_with);
        const sub = hit.length
          ? `${plural(hit.length, 'hub')} hit · ${s.months}${s.recovered ? '' : '+'} ${s.months === 1 ? 'month' : 'months'} to recover`
          : shared
            ? `dip counted under ${escapeHtml(nameOf(shared.shared_with!))}`
            : s.hubs.length
              ? `no measurable dip · ${plural(s.hubs.length, 'hub')} within ${fmtNum(m.radius_km)} km`
              : `no producing hub within ${fmtNum(m.radius_km)} km`;
        return `<button class="storm-row" data-storm="${escapeHtml(s.id)}" title="Replay ${escapeHtml(s.name)} on the timeline">
          <i style="background:${cls.color}"></i>
          <span class="name">${escapeHtml(s.name)}<em>${s.year} · peak ${cls.short}</em></span>
          <b>${s.deferred_mboe != null ? fmtNum(s.deferred_mboe, 1) : '—'}</b>
          <small>${sub}</small>
        </button>`;
      })
      .join('');
    const total = this.storms.reduce((a, s) => a + (s.deferred_mboe ?? 0), 0);
    const years = this.storms.length && this.data.through ? `, ${Math.min(...this.storms.map((s) => s.year))}–${this.data.through}` : '';
    this.el.innerHTML = `
      <h2>Gulf storms <label class="storm-toggle"><input type="checkbox" data-storms-toggle ${this.visible ? 'checked' : ''}/>tracks</label></h2>
      ${this.liveHtml()}
      <div class="storm-head"><span>${plural(this.storms.length, 'storm')} near Shell structures${years}</span><span>est. million boe deferred</span></div>
      <div class="storm-list">${rows}</div>
      <div class="storm-detail" hidden></div>
      <div class="storm-legend">${STORM_CLASSES.slice(1)
        .map((c) => `<span title="${c.label}"><i style="background:${c.color}"></i>${c.short.replace('Cat ', '')}</span>`)
        .join('')}</div>
      <p class="race-note">Estimates from monthly data, relative to the pre-storm baseline (mean of the ${m.baseline_months} months before), for hubs within ${fmtNum(m.radius_km)} km of the track, counted until production is back to ${fmtNum(m.recovery * 100)}%. All storms together: ${fmtNum(total, 1)} million boe gross. A dip can have other causes, such as a planned turnaround. Click a storm to replay it.</p>`;
    this.el.hidden = false;
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>('[data-storm]');
      if (row) return this.play(row.dataset.storm!);
      const live = t.closest<HTMLElement>('[data-live]');
      const sys = live ? this.data.live?.systems[Number(live.dataset.live)] : undefined;
      if (sys && sys.lon != null && sys.lat != null) {
        this.hooks.stopPlay();
        this.map.flyTo({ center: [sys.lon, sys.lat], zoom: 4.6, pitch: 30, duration: 2200, essential: true });
      }
    });
    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (!t.matches('[data-storms-toggle]')) return;
      this.setVisible(t.checked);
      this.hooks.onToggle(t.checked);
    });
  }

  /** Highlight a storm in the list and show its hub-by-hub estimate. */
  private select(id: string) {
    this.selected = id;
    const s = this.storms.find((x) => x.id === id);
    const detail = this.el.querySelector<HTMLElement>('.storm-detail');
    this.el.querySelectorAll<HTMLElement>('[data-storm]').forEach((row) => row.classList.toggle('on', row.dataset.storm === this.selected));
    if (!s || !detail) return;
    const nameOf = (sid: string) => this.storms.find((x) => x.id === sid)?.name ?? sid;
    const cls = STORM_CLASSES[stormClass(s.peak_kt)];
    const rows = s.hubs
      .map((h) => {
        const est =
          h.deferred_mboe != null
            ? `<b>${fmtNum(h.deferred_mboe, 2)}</b> million boe · ${fmtNum(h.baseline!)} → ${fmtNum(h.low!)} kboe/d · ${h.months}${h.recovered ? '' : '+'} ${h.months === 1 ? 'month' : 'months'}`
            : h.shared_with
              ? `counted under ${escapeHtml(nameOf(h.shared_with))}`
              : 'no measurable dip';
        return `<li><span>${escapeHtml(hubLabel(h.name))}<em>${fmtNum(h.km)} km from the centre · ${fmtNum(h.kt)} kt</em></span><small>${est}</small></li>`;
      })
      .join('');
    detail.innerHTML = `<p><b>${escapeHtml(s.name)}</b> · ${fmtMonth(s.month, true)} · ${cls.label.toLowerCase()}, peak ${fmtNum(s.peak_kt)} kt · centre passed ${fmtNum(s.closest_km)} km from the nearest of ${plural(s.structures, 'Shell structure')} within ${fmtNum(this.data.method.radius_km)} km</p>${rows ? `<ul>${rows}</ul>` : ''}`;
    detail.hidden = false;
  }
}

function liveTitle(s: LiveSystem): string {
  const kind = LIVE_CLASS[s.classification ?? ''] ?? s.classification ?? 'System';
  return `${kind} ${s.name ?? s.id}`.trim();
}
