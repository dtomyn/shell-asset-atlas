import './style.css';
import { AreaChart, fmtMonth, fmtNum } from './chart';
import { KIND_LABEL, SEGMENTS, STAKE_LABEL, loadAtlas, segmentOf, type AssetProps, type Atlas, type Region, type Stake } from './data';
import { Drawer } from './drawer';
import { hud, starfield } from './fx';
import { COLOR_MODES, createMap, escapeHtml, type Basemap, type ColorMode, type LayerKey, type MapController } from './map';
import { Race } from './race';
import { buildTour, type TourStop } from './tour';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const REGION_COLORS: Record<string, string> = { gom: '#ffb703', uk: '#ff8c42', no: '#4cc9f0' };
const REGION_SHORT: Record<string, string> = { gom: 'US Gulf', uk: 'UK', no: 'Norway' };

async function boot() {
  let atlas: Atlas;
  try {
    atlas = await loadAtlas();
  } catch (e) {
    $('loader').innerHTML = `<p class="err">Could not load data: ${escapeHtml(String(e))}<br>Run the pipeline first: <code>cd pipeline &amp;&amp; uv run atlas-build</code></p>`;
    return;
  }
  const P = atlas.production;

  // The timeline stops at the latest month every region has reported, so the stacked total
  // never shows a fake drop where one regulator simply hasn't published yet.
  const regions = (['gom', 'uk', 'no'] as const).filter((r) => P.latest[r]);
  const commonLatest = regions.map((r) => P.latest[r]!).sort()[0] ?? P.months[P.months.length - 1];
  const endIdx = P.months.indexOf(commonLatest);
  const tlMonths = P.months.slice(0, endIdx + 1);

  // --- state ---------------------------------------------------------------------------
  const state = {
    month: endIdx,
    playing: false,
    layers: { assets: true, fields: true, pipelines: true, fuel: true, ev: false } as Record<LayerKey, boolean>,
    stakes: new Set<Stake>(['operated', 'jv', 'partner']),
    selected: null as string | null,
    basemap: 'dark' as Basemap,
    color: 'segment' as ColorMode,
    hex: false,
  };

  let ctrl: MapController;
  const drawer = new Drawer(
    atlas,
    () => {
      state.selected = null;
      ctrl?.select(null);
      writeHash();
    },
    (id) => selectById(id, true),
    (idx) => setMonth(Math.min(idx, endIdx)),
  );

  ctrl = await createMap('map', atlas, (props, kind, raw) => {
    if (kind === 'pipeline' && raw) {
      state.selected = null;
      ctrl.select(null);
      drawer.showPipeline(raw);
      return;
    }
    if (!props) {
      drawer.close();
      return;
    }
    select(props, false);
  });
  const { map } = ctrl;
  // The film renderer (film/render.py) opens the page with ?film and drives the real controls.
  // It needs the map to find where an asset is on screen and to know when tiles have loaded.
  if (new URLSearchParams(location.search).has('film')) (window as unknown as Record<string, unknown>).__atlas = { map, ctrl, atlas };
  starfield($('stars'), map);
  hud($('hud'), map);
  const race = new Race($('race-rows'), atlas, ctrl.seriesOwner, 8, (id) => selectById(id, true));

  // --- KPIs ----------------------------------------------------------------------------
  const k = atlas.manifest.kpis;
  const opTotal = regions.reduce((a, r) => a + (P.totals[`${r}:operated`]?.gross[endIdx] ?? 0) + (P.totals[`${r}:jv`]?.gross[endIdx] ?? 0), 0);
  const tiles: [string, string, string][] = [
    [fmtNum(opTotal), 'kboe/d', `operated + JV, gross · ${fmtMonth(commonLatest)}`],
    [fmtNum(k.assets), '', 'installations & sites'],
    [fmtNum(k.pipeline_km), 'km', 'operated pipelines'],
    [fmtNum(k.fuel_stations), '', 'mapped fuel stations'],
    [fmtNum(k.ev_sites), '', 'EV charge sites'],
  ];
  $('kpis').innerHTML = tiles
    .map(([v, u, l]) => `<div class="kpi"><span class="v" data-count="${v.replace(/,/g, '')}">${v}</span>${u ? `<span class="u">${u}</span>` : ''}<small>${l}</small></div>`)
    .join('');
  countUp();

  // --- layers --------------------------------------------------------------------------
  const layerDefs: { key: LayerKey; label: string; count: number; swatch: string }[] = [
    { key: 'assets', label: 'Installations & sites', count: atlas.assets.features.length, swatch: `conic-gradient(${Object.values(SEGMENTS).map((s) => s.color).join(',')})` },
    { key: 'fields', label: 'Oil & gas fields', count: atlas.fields.features.length, swatch: '#ffb703' },
    { key: 'pipelines', label: 'Pipelines', count: atlas.pipelines.features.length, swatch: 'linear-gradient(90deg,#4cc9f0 50%,#ffb703 50%)' },
    { key: 'fuel', label: 'Fuel stations (OSM)', count: atlas.retail.fuel.length, swatch: 'radial-gradient(#ffe08a,#ff5d8f)' },
    { key: 'ev', label: 'EV charge points (OSM)', count: atlas.retail.ev.length, swatch: '#80ed99' },
  ];
  $('layers').innerHTML = layerDefs
    .map(
      (l) => `<label class="layer"><input type="checkbox" data-layer="${l.key}" ${state.layers[l.key] ? 'checked' : ''}/>
        <i style="background:${l.swatch}"></i><span>${l.label}</span><small>${fmtNum(l.count)}</small></label>`,
    )
    .join('');
  $('layers').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const key = t.dataset.layer as LayerKey;
    state.layers[key] = t.checked;
    ctrl.setLayerVisible(key, t.checked);
  });
  for (const l of layerDefs) ctrl.setLayerVisible(l.key, state.layers[l.key]);

  // legend for segments (inside layers section)
  const legend = document.createElement('div');
  legend.className = 'legend';
  const segmentLegend = Object.values(SEGMENTS)
    .map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`)
    .join('');
  legend.innerHTML = segmentLegend;
  $('layers').after(legend);

  // --- map bar: basemap, colour mode, 3D retail, orbit, share, fullscreen -----------------
  const segButtons = (group: string, attr: string, value: string) =>
    document.querySelectorAll<HTMLButtonElement>(`#${group} button`).forEach((b) => b.classList.toggle('on', b.dataset[attr] === value));
  function setBasemap(mode: Basemap) {
    state.basemap = mode;
    ctrl.setBasemap(mode);
    segButtons('basemap', 'base', mode);
    writeHashSoon();
  }
  function setColor(mode: ColorMode) {
    state.color = mode;
    ctrl.setColorMode(mode);
    segButtons('colorby', 'color', mode);
    const lg = COLOR_MODES[mode].legend;
    legend.innerHTML = lg
      ? `<span class="ramp"><b style="background:linear-gradient(90deg,${lg.stops.map((st) => st[1]).join(',')})"></b>
          <div>${lg.stops.map((st) => `<span>${lg.unit ? fmtNum(st[0]) : st[0]}${lg.unit}</span>`).join('')}</div>
          <p>${lg.note}. <i style="background:#566273"></i>not recorded</p></span>`
      : segmentLegend;
    writeHashSoon();
  }
  function setHex(on: boolean, tilt = true) {
    state.hex = on;
    ctrl.setFuelMode(on ? 'hex' : 'heat');
    $('hex-btn').setAttribute('aria-pressed', String(on));
    if (on) {
      if (!state.layers.fuel) {
        state.layers.fuel = true;
        ctrl.setLayerVisible('fuel', true);
        const cb = document.querySelector<HTMLInputElement>('[data-layer="fuel"]');
        if (cb) cb.checked = true;
      }
      // The skyline only reads in perspective and at regional scale.
      if (tilt && (map.getPitch() < 35 || map.getZoom() < 3.2 || map.getZoom() > 8)) {
        ctrl.stopSpin();
        map.flyTo({ center: map.getZoom() < 3.2 || map.getZoom() > 8 ? [5.5, 50.5] : map.getCenter(), zoom: Math.min(Math.max(map.getZoom(), 4.6), 6.5), pitch: 58, bearing: -18, duration: 2600, essential: true });
      }
    }
    writeHashSoon();
  }
  $('basemap').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-base]');
    if (b) setBasemap(b.dataset.base as Basemap);
  });
  $('colorby').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-color]');
    if (b) setColor(b.dataset.color as ColorMode);
  });
  $('hex-btn').addEventListener('click', () => setHex(!state.hex));
  let orbiting = false;
  ctrl.onOrbitChange = (on) => {
    orbiting = on;
    $('orbit-btn').setAttribute('aria-pressed', String(on));
  };
  const toggleOrbit = () => {
    if (!orbiting && map.getPitch() < 30) map.easeTo({ pitch: 50, duration: 900 });
    ctrl.setOrbit(!orbiting);
  };
  $('orbit-btn').addEventListener('click', toggleOrbit);
  $('share-btn').addEventListener('click', async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link to this view copied');
    } catch {
      toast('Copy the address bar to share this view');
    }
  });
  const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}));
  $('fs-btn').addEventListener('click', toggleFullscreen);

  // --- stakes --------------------------------------------------------------------------
  $('stakes').innerHTML = (['operated', 'jv', 'partner'] as Stake[])
    .map((s) => `<button class="chip on stake-chip stake-${s}" data-stake="${s}" aria-pressed="true"><i></i>${STAKE_LABEL[s]}</button>`)
    .join('');
  $('stakes').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-stake]');
    if (!b) return;
    const s = b.dataset.stake as Stake;
    if (state.stakes.has(s) && state.stakes.size > 1) state.stakes.delete(s);
    else state.stakes.add(s);
    document.querySelectorAll<HTMLButtonElement>('[data-stake]').forEach((x) => {
      const on = state.stakes.has(x.dataset.stake as Stake);
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', String(on));
    });
    ctrl.setStakes(state.stakes);
    race.update(state.month, state.stakes);
  });

  // --- regions -------------------------------------------------------------------------
  const views: Record<string, { center: [number, number]; zoom: number; pitch: number; bearing: number }> = {
    World: { center: [-25, 30], zoom: 1.6, pitch: 0, bearing: 0 },
    'US Gulf': { center: [-90.5, 27.6], zoom: 5.6, pitch: 45, bearing: -10 },
    'North Sea': { center: [1.5, 56.5], zoom: 4.8, pitch: 40, bearing: 0 },
    Norway: { center: [5.8, 62.8], zoom: 5.8, pitch: 45, bearing: -20 },
    Europe: { center: [8, 50], zoom: 3.8, pitch: 0, bearing: 0 },
    'Asia-Pacific': { center: [125, -5], zoom: 2.6, pitch: 0, bearing: 0 },
  };
  $('regions').innerHTML = Object.keys(views)
    .map((v) => `<button class="chip" data-view="${v}">${v}</button>`)
    .join('');
  $('regions').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (!b) return;
    ctrl.stopSpin();
    map.flyTo({ ...views[b.dataset.view!], duration: 2600, essential: true });
    if (window.innerWidth < 760) document.body.classList.remove('panel-open');
  });

  // --- timeline ------------------------------------------------------------------------
  const stack = (r: Region) => tlMonths.map((_, i) => (P.totals[`${r}:operated`]?.gross[i] ?? 0) + (P.totals[`${r}:jv`]?.gross[i] ?? 0));
  const tl = new AreaChart($('tl-chart'), {
    months: tlMonths,
    stacks: regions.map((r) => ({ label: REGION_SHORT[r], color: REGION_COLORS[r], values: stack(r) })),
    unit: 'kboe/d',
    cursor: state.month,
    compact: true,
    onScrub: (i) => {
      stopPlay();
      setMonth(i);
    },
  });
  $('tl-legend').innerHTML =
    regions.map((r) => `<span><i style="background:${REGION_COLORS[r]}"></i>${REGION_SHORT[r]}</span>`).join('') +
    `<span class="muted">Shell-operated + JV, gross kboe/d</span>`;

  function setMonth(i: number) {
    state.month = Math.max(0, Math.min(endIdx, i));
    ctrl.setMonth(state.month);
    tl.setCursor(state.month);
    drawer.setCursor(state.month);
    $('tl-month').textContent = fmtMonth(P.months[state.month], true);
    const total = regions.reduce((a, r) => a + (P.totals[`${r}:operated`]?.gross[state.month] ?? 0) + (P.totals[`${r}:jv`]?.gross[state.month] ?? 0), 0);
    $('tl-total').innerHTML = `<b>${fmtNum(total)}</b> kboe/d`;
    race.update(state.month, state.stakes);
    $('race-month').textContent = fmtMonth(P.months[state.month]);
    writeHashSoon();
  }

  let timer = 0;
  function startPlay() {
    state.playing = true;
    document.body.classList.add('playing');
    ctrl.stopSpin();
    if (state.month >= endIdx) setMonth(0);
    timer = window.setInterval(() => {
      if (state.month >= endIdx) return stopPlay();
      setMonth(state.month + 1);
    }, 140);
  }
  function stopPlay() {
    state.playing = false;
    document.body.classList.remove('playing');
    clearInterval(timer);
  }
  $('play').addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));

  // --- selection -----------------------------------------------------------------------
  const everything: { p: AssetProps; c: [number, number]; type: 'asset' | 'field' }[] = [
    ...atlas.assets.features.map((f) => ({ p: f.properties, c: f.geometry.coordinates as [number, number], type: 'asset' as const })),
    ...atlas.fields.features.filter((f) => f.properties.center).map((f) => ({ p: f.properties, c: f.properties.center!, type: 'field' as const })),
  ];

  function select(p: AssetProps, fly: boolean) {
    state.selected = p.id;
    ctrl.select(p.id);
    drawer.show(p, state.month);
    if (fly) {
      const hit = everything.find((e) => e.p.id === p.id);
      if (hit) {
        ctrl.stopSpin();
        map.flyTo({ center: hit.c, zoom: Math.max(map.getZoom(), hit.type === 'field' ? 7 : 8), pitch: 55, duration: 2200, essential: true });
        ctrl.setOrbit(true); // starts turning once the flight lands; any touch of the map stops it
      }
    }
    writeHash();
  }
  function selectById(id: string, fly: boolean) {
    const hit = everything.find((e) => e.p.id === id);
    if (hit) select(hit.p, fly);
  }

  // --- search --------------------------------------------------------------------------
  const input = $<HTMLInputElement>('search');
  const list = $<HTMLUListElement>('search-results');
  let results: typeof everything = [];
  let active = 0;
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const index = everything
    .filter((e) => e.p.kind !== 'subsea')
    .map((e) => ({ e, hay: norm([e.p.name, e.p.country, e.p.operator, e.p.field, e.p.block, KIND_LABEL[e.p.kind], e.p.subtype].filter(Boolean).join(' ')) }));
  function runSearch() {
    const q = norm(input.value.trim());
    if (!q) {
      list.hidden = true;
      return;
    }
    const terms = q.split(/\s+/);
    results = index
      .filter((x) => terms.every((t) => x.hay.includes(t)))
      .map((x) => ({ x, score: (norm(x.e.p.name).startsWith(q) ? 0 : 1) + (x.e.p.featured ? 0 : 0.5) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
      .map((r) => r.x.e);
    active = 0;
    list.innerHTML = results.length
      ? results
          .map(
            (r, i) =>
              `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}"><i style="background:${SEGMENTS[segmentOf(r.p.kind)].color}"></i><span>${escapeHtml(r.p.name)}</span><small>${escapeHtml(KIND_LABEL[r.p.kind] ?? r.p.kind)} · ${escapeHtml(r.p.country ?? '')}</small></li>`,
          )
          .join('')
      : '<li class="empty">No matches</li>';
    list.hidden = false;
  }
  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    input.value = '';
    list.hidden = true;
    input.blur();
    select(r.p, true);
  };
  input.addEventListener('input', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length);
      list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === active));
    } else if (e.key === 'Enter') choose(active);
    else if (e.key === 'Escape') {
      input.value = '';
      list.hidden = true;
      input.blur();
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-i]');
    if (li) choose(Number(li.dataset.i));
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 150));

  // --- tour ----------------------------------------------------------------------------
  const tourEl = $('tour');
  let stops: TourStop[] = [];
  let stop = 0;
  let panelWasOpen = false;
  function showStop(i: number) {
    stop = Math.max(0, Math.min(stops.length - 1, i));
    const s = stops[stop];
    $('tour-kicker').textContent = `${stop + 1} / ${stops.length} · ${s.kicker}`;
    $('tour-title').textContent = s.title;
    $('tour-body').innerHTML = s.body;
    $('tour-progress').style.setProperty('--p', `${((stop + 1) / stops.length) * 100}%`);
    $<HTMLButtonElement>('tour-prev').disabled = stop === 0;
    $('tour-next').textContent = stop === stops.length - 1 ? 'Finish' : 'Next';
    for (const [key, on] of Object.entries(s.layers ?? {})) {
      state.layers[key as LayerKey] = on!;
      ctrl.setLayerVisible(key as LayerKey, on!);
      const cb = document.querySelector<HTMLInputElement>(`[data-layer="${key}"]`);
      if (cb) cb.checked = on!;
    }
    // Keep the subject clear of the tour card (bottom centre) and the drawer (right).
    const mobile = window.innerWidth < 760;
    const padding = mobile ? { top: 120, bottom: 300, left: 0, right: 0 } : { top: 40, bottom: 300, left: 0, right: s.select ? 420 : 0 };
    map.flyTo({ ...s.camera, padding, duration: 3800, curve: 1.6, essential: true });
    ctrl.setOrbit(!!s.select);
    armAuto();
    if (s.select) {
      const hit = everything.find((e) => e.p.id === s.select);
      if (hit) {
        state.selected = hit.p.id;
        ctrl.select(hit.p.id);
        drawer.show(hit.p, state.month);
      }
    } else drawer.close();
  }
  const AUTO_MS = 11000;
  let auto = false;
  let autoTimer = 0;
  function armAuto() {
    clearTimeout(autoTimer);
    tourEl.classList.remove('auto');
    if (!auto || tourEl.hidden) return;
    void tourEl.offsetWidth; // restart the progress animation
    tourEl.style.setProperty('--auto-ms', `${AUTO_MS}ms`);
    tourEl.classList.add('auto');
    autoTimer = window.setTimeout(() => (stop === stops.length - 1 ? setAuto(false) : showStop(stop + 1)), AUTO_MS);
  }
  function setAuto(on: boolean) {
    auto = on;
    $('tour-auto').setAttribute('aria-pressed', String(on));
    $('tour-auto').textContent = on ? 'Pause' : 'Auto-play';
    armAuto();
  }
  $('tour-auto').addEventListener('click', () => setAuto(!auto));
  function startTour() {
    stops = buildTour(atlas, endIdx);
    stopPlay();
    ctrl.stopSpin();
    document.body.classList.add('touring');
    panelWasOpen = document.body.classList.contains('panel-open');
    document.body.classList.remove('panel-open');
    tourEl.hidden = false;
    showStop(0);
  }
  function endTour() {
    map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
    if (panelWasOpen) document.body.classList.add('panel-open');
    tourEl.hidden = true;
    document.body.classList.remove('touring');
    setAuto(false);
    ctrl.setOrbit(false);
  }
  $('tour-btn').addEventListener('click', startTour);
  $('tour-exit').addEventListener('click', endTour);
  $('tour-prev').addEventListener('click', () => showStop(stop - 1));
  $('tour-next').addEventListener('click', () => (stop === stops.length - 1 ? endTour() : showStop(stop + 1)));

  // --- about ---------------------------------------------------------------------------
  const about = $<HTMLDialogElement>('about');
  about.innerHTML = aboutHtml(atlas);
  $('about-btn').addEventListener('click', () => about.showModal());
  about.addEventListener('click', (e) => {
    if (e.target === about || (e.target as HTMLElement).closest('[data-close]')) about.close();
  });

  // --- panel toggle (mobile) -----------------------------------------------------------
  $('panel-toggle').addEventListener('click', () => document.body.classList.toggle('panel-open'));

  // --- keyboard ------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).matches('input, textarea');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      input.focus();
    } else if (e.key === ' ' && !typing && !about.open) {
      e.preventDefault();
      state.playing ? stopPlay() : startPlay();
    } else if (e.key === 'Escape') {
      if (!tourEl.hidden) endTour();
      else drawer.close();
    } else if (!typing && !tourEl.hidden && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      showStop(stop + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (!typing && tourEl.hidden && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      stopPlay();
      setMonth(state.month + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (typing || e.ctrlKey || e.metaKey || e.altKey) {
      return;
    } else if (e.key.toLowerCase() === 't' && tourEl.hidden) startTour();
    else if (e.key.toLowerCase() === 'o') toggleOrbit();
    else if (e.key.toLowerCase() === 'f') toggleFullscreen();
  });

  // --- URL hash (shareable deep links) -------------------------------------------------
  function writeHash() {
    const c = map.getCenter();
    const params = new URLSearchParams();
    params.set('c', `${c.lng.toFixed(3)},${c.lat.toFixed(3)},${map.getZoom().toFixed(2)},${map.getPitch().toFixed(0)},${map.getBearing().toFixed(0)}`);
    if (state.month !== endIdx) params.set('t', P.months[state.month]);
    if (state.selected) params.set('a', state.selected);
    if (state.basemap !== 'dark') params.set('b', state.basemap);
    if (state.color !== 'segment') params.set('m', state.color);
    if (state.hex) params.set('x', '1');
    history.replaceState(null, '', `#${params}`);
  }
  let hashTimer = 0;
  function writeHashSoon() {
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(writeHash, 400);
  }
  map.on('moveend', writeHashSoon);

  const params = new URLSearchParams(location.hash.slice(1));
  const t = params.get('t');
  setMonth(t && P.months.includes(t) ? P.months.indexOf(t) : endIdx);
  const c = params.get('c')?.split(',').map(Number);
  if (c && c.length >= 3 && c.every(Number.isFinite)) {
    ctrl.stopSpin();
    map.jumpTo({ center: [c[0], c[1]], zoom: c[2], pitch: c[3] ?? 0, bearing: c[4] ?? 0 });
  }
  const a = params.get('a');
  if (a) selectById(a, !c);
  const b = params.get('b');
  if (b === 'ocean' || b === 'night') setBasemap(b);
  const m = params.get('m');
  if (m === 'depth' || m === 'age') setColor(m);
  if (params.get('x') === '1') setHex(true, false);

  // --- reveal --------------------------------------------------------------------------
  $('loader').classList.add('done');
  setTimeout(() => $('loader').remove(), 800);
  if (window.innerWidth >= 760) document.body.classList.add('panel-open');
  // Opening shot: arrive from deep space unless the link asked for a specific view.
  if (!c && !a && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    map.jumpTo({ center: [70, 5], zoom: 0.6 });
    map.easeTo({ center: [-30, 30], zoom: 1.6, duration: 5200, easing: (n) => 1 - Math.pow(1 - n, 3) });
  }
  const staleSources = atlas.manifest.sources.filter((s) => s.state === 'stale');
  if (staleSources.length) toast(`Showing cached data for: ${staleSources.map((s) => s.publisher).join(', ')}`);
}

function countUp() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target)) return;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 1400);
      el.textContent = fmtNum(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 6000);
}

function aboutHtml(atlas: Atlas): string {
  const m = atlas.manifest;
  const gen = new Date(m.generated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const rows = m.sources
    .map(
      (s) => `<tr>
        <td><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.publisher)}</a><small>${escapeHtml(s.title)}</small></td>
        <td>${escapeHtml(s.license)}</td>
        <td><span class="state state-${s.state}">${s.state}</span><small>${s.fetched_at ? new Date(s.fetched_at).toLocaleDateString('en-GB') : ''}</small></td>
      </tr>`,
    )
    .join('');
  const notes = m.sources.flatMap((s) => s.notes).map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  return `
    <form method="dialog" class="about-inner">
      <button class="icon-btn close" data-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <p class="kicker">About this atlas</p>
      <h2>Data &amp; method</h2>
      <p>An <b>unofficial</b> portfolio project. It is not affiliated with or endorsed by Shell plc. Every layer is rebuilt by an open-source Python pipeline from public regulator and open-data sources, and is refreshed weekly by GitHub Actions. Data last built <b>${gen}</b>.</p>
      <table class="sources"><thead><tr><th>Source</th><th>Licence</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
      <h3>Method notes</h3>
      <ul>
        ${notes}
        <li>Production is converted to kboe/d with 5,800 scf of gas = 1 barrel of oil equivalent. Liquids include condensate and NGL.</li>
        <li>The timeline stacks Shell-operated and JV assets only, and stops at the latest month all three regulators have published. Partner-only fields (such as Troll) appear in each field's panel with Shell's net share.</li>
        <li>Production towers and extruded fields are scaled to gross kboe/d in the selected month. The 3D retail skyline counts OpenStreetMap-tagged stations per hexagonal cell; cells are drawn in Web Mercator, so they cover less ground at high latitudes.</li>
        <li>Seabed and night-light basemaps are NASA Blue Marble and Black Marble imagery served by NASA EOSDIS GIBS.</li>
        <li>“Operated” follows the regulator's operator of record, not Shell's reported working interest. Gross volumes are not Shell's net production.</li>
      </ul>
      <h3>Keyboard</h3>
      <p class="keys"><kbd>/</kbd> search <kbd>Space</kbd> play <kbd>←</kbd><kbd>→</kbd> step month <kbd>T</kbd> tour <kbd>O</kbd> orbit <kbd>F</kbd> fullscreen <kbd>Esc</kbd> close</p>
    </form>`;
}

boot();
