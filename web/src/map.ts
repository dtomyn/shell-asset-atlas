// MapLibre globe + all thematic layers. Everything is native MapLibre (no deck.gl) so the
// globe projection, 3D extrusions and atmosphere work together without a second renderer.
import maplibregl, { type GeoJSONSource, type Map as MLMap, type ExpressionSpecification, type FilterSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import { fmtMonth, fmtNum } from './chart';
import { GAS_PER_BOE, SEGMENTS, segmentOf, seriesAt, type Atlas, type AssetProps, type Stake } from './data';
import { graticule, hexAround, hexbin } from './fx';

const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

export type LayerKey = 'assets' | 'fields' | 'pipelines' | 'fuel' | 'ev';
export type Basemap = 'dark' | 'ocean' | 'night';
export type ColorMode = 'segment' | 'depth' | 'age';
export type FuelMode = 'heat' | 'hex';

const COMET_IDS = ['pipelines-comet-gas-0', 'pipelines-comet-gas-1', 'pipelines-comet-oil-0', 'pipelines-comet-oil-1'];

export const LAYER_IDS: Record<LayerKey, string[]> = {
  assets: ['assets-halo', 'assets-beacon', 'assets-pulse', 'towers', 'assets', 'assets-label'],
  fields: ['fields-fill', 'fields-extrusion', 'fields-line'],
  pipelines: ['pipelines-glow', 'pipelines', 'pipelines-flow', ...COMET_IDS],
  fuel: ['fuel-heat', 'fuel-hex', 'fuel-points'],
  ev: ['ev-points'],
};

const segmentColor: ExpressionSpecification = [
  'match',
  ['get', 'segment'],
  ...Object.entries(SEGMENTS).flatMap(([k, v]) => [k, v.color]),
  SEGMENTS.upstream.color,
] as unknown as ExpressionSpecification;

const NO_DATA = '#566273';
const DEPTH_STOPS: [number, string][] = [[0, '#d8f6ff'], [200, '#4cc9f0'], [1000, '#4361ee'], [2000, '#b5179e'], [3000, '#ff5d8f']];
const AGE_STOPS: [number, string][] = [[1975, '#ff5d8f'], [2000, '#ffb703'], [2025, '#80ed99']];
const ramp = (prop: string, stops: [number, string][]): ExpressionSpecification =>
  ['case', ['>', ['to-number', ['get', prop], 0], 0], ['interpolate', ['linear'], ['to-number', ['get', prop], 0], ...stops.flat()], NO_DATA] as unknown as ExpressionSpecification;

export const COLOR_MODES: Record<ColorMode, { label: string; expr: ExpressionSpecification; legend?: { stops: [number, string][]; unit: string; note: string } }> = {
  segment: { label: 'Segment', expr: segmentColor },
  depth: { label: 'Water depth', expr: ramp('water_depth_m', DEPTH_STOPS), legend: { stops: DEPTH_STOPS, unit: ' m', note: 'Water depth at the installation' } },
  age: { label: 'Year installed', expr: ramp('installed', AGE_STOPS), legend: { stops: AGE_STOPS, unit: '', note: 'Year the installation was set' } },
};

const productColor: ExpressionSpecification = ['match', ['get', 'pc'], 'gas', '#4cc9f0', 'oil', '#ffb703', '#9aa7b8'];

/** A bright head with a fading tail at position `h` (0..1) along each line. */
function comet(h: number, rgb: string): ExpressionSpecification {
  const L = 0.4;
  const alpha = (p: number) => {
    const d = (((h - p) % 1) + 1) % 1;
    return d < L ? Math.pow(1 - d / L, 2) : 0;
  };
  const ps = new Set<number>();
  for (let i = 0; i <= 16; i++) ps.add(i / 16);
  for (const p of [h, h + 0.004, (((h - L) % 1) + 1) % 1]) if (p >= 0 && p <= 1) ps.add(Math.round(p * 10000) / 10000);
  const stops = [...ps].sort((a, b) => a - b).flatMap((p) => [p, `rgba(${rgb},${alpha(p).toFixed(3)})`]);
  return ['interpolate', ['linear'], ['line-progress'], ...stops] as unknown as ExpressionSpecification;
}

export interface MapController {
  map: MLMap;
  /** production series id → the asset or field that represents it on the map */
  seriesOwner: Map<string, string>;
  setMonth(idx: number): void;
  setLayerVisible(key: LayerKey, on: boolean): void;
  setStakes(stakes: Set<Stake>): void;
  setBasemap(mode: Basemap): void;
  setColorMode(mode: ColorMode): void;
  setFuelMode(mode: FuelMode): void;
  setOrbit(on: boolean): void;
  onOrbitChange: (on: boolean) => void;
  select(id: string | null): void;
  stopSpin(): void;
}

export function createMap(
  container: string,
  atlas: Atlas,
  onPick: (props: AssetProps | null, kind: 'asset' | 'field' | 'pipeline' | null, raw?: Record<string, unknown>) => void,
): Promise<MapController> {
  const map = new maplibregl.Map({
    container,
    style: STYLE,
    center: [-30, 30],
    zoom: 1.6,
    minZoom: 0.6,
    maxPitch: 78,
    attributionControl: false,
    canvasContextAttributes: { antialias: true },
  });
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        'Data: <a href="https://www.data.boem.gov/" target="_blank">BOEM</a> · <a href="https://www.nstauthority.co.uk/" target="_blank">NSTA (OGL)</a> · <a href="https://factpages.sodir.no/" target="_blank">Sodir (NLOD)</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors · © <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
    }),
    'bottom-right',
  );
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110 }), 'bottom-right');

  // Pre-compute derived props once.
  const assets = atlas.assets;
  for (const f of assets.features) {
    (f.properties as AssetProps & { segment: string }).segment = segmentOf(f.properties.kind);
  }
  for (const f of atlas.fields.features) (f.properties as AssetProps & { segment: string }).segment = 'upstream';
  atlas.pipelines.features.forEach((f, i) => {
    const p = f.properties as unknown as Record<string, unknown>;
    const product = String(p.product ?? '').toLowerCase();
    p.pc = product.includes('gas') ? 'gas' : product.includes('oil') || product.includes('blko') ? 'oil' : 'other';
    p.ph = i % 2;
  });

  // Each production series is drawn once: on its field outline if there is one, else on its
  // featured hub, else on the first installation that reports under it.
  const seriesOwner = new Map<string, string>();
  for (const f of assets.features) {
    const s = f.properties.series;
    if (!s) continue;
    const cur = seriesOwner.get(s);
    const curF = cur ? assets.features.find((x) => x.properties.id === cur) : undefined;
    if (!cur || (f.properties.featured && !curF?.properties.featured)) seriesOwner.set(s, f.properties.id);
  }
  for (const f of atlas.fields.features) if (f.properties.series) seriesOwner.set(f.properties.series, f.properties.id);

  // Production towers: a hexagonal column on every installation that owns a series.
  type TowerProps = Pick<AssetProps, 'id' | 'name' | 'kind' | 'subtype' | 'country' | 'stake' | 'series'> & { kboe: number };
  const towers: FeatureCollection<Polygon, TowerProps> = { type: 'FeatureCollection', features: [] };
  for (const f of assets.features) {
    const p = f.properties;
    if (!p.series || seriesOwner.get(p.series) !== p.id) continue;
    towers.features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [hexAround(f.geometry.coordinates as [number, number], 5.5)] },
      properties: { id: p.id, name: p.name, kind: p.kind, subtype: p.subtype, country: p.country, stake: p.stake, series: p.series, kboe: 0 },
    });
  }

  const retailFc = (rows: [number, number, number][]): FeatureCollection<Point> => ({
    type: 'FeatureCollection',
    features: rows.map(([x, y, f]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { f } })),
  });
  const fuelHex = hexbin(atlas.retail.fuel, 0.26);
  const hexMax = Math.max(1, ...fuelHex.features.map((f) => f.properties.n));

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let spinning = true;
  let userInteracting = false;
  let orbit = false;
  const stopSpin = () => {
    spinning = false;
  };
  const spin = () => {
    if (!spinning || userInteracting || map.getZoom() > 3) return;
    const c = map.getCenter();
    c.lng -= 6;
    map.easeTo({ center: c, duration: 1000, easing: (n) => n });
  };
  map.on('moveend', spin);

  return new Promise((resolve) => {
    map.on('style.load', () => {
      map.setProjection({ type: 'globe' });
      // Start with the attribution collapsed to its (i) button so it doesn't run under the HUD.
      map.getContainer().querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
      map.setSky({
        'sky-color': '#0b1a2e',
        'horizon-color': '#2a5d94',
        'fog-color': '#070a0f',
        'sky-horizon-blend': 0.7,
        'horizon-fog-blend': 0.6,
        'fog-ground-blend': 0.5,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
      });
      // Calm the basemap down so the data reads first.
      const baseLayers = (map.getStyle().layers ?? []).map((l) => ({ id: l.id, type: l.type, visibility: (l.layout as { visibility?: 'visible' | 'none' } | undefined)?.visibility ?? 'visible' }));
      for (const layer of baseLayers) {
        if (layer.type === 'symbol' && /place|label/.test(layer.id) && !/country|continent/.test(layer.id)) {
          map.setPaintProperty(layer.id, 'text-opacity', 0.55);
        }
      }
      const firstBase = baseLayers.find((l) => l.type !== 'background')?.id;
      // Carto layers that would hide or clash with satellite imagery.
      const hiddenOnImagery = baseLayers.filter((l) => l.type === 'fill' || l.type === 'fill-extrusion' || (l.type === 'line' && !/boundary|admin/.test(l.id)));
      const boundaryLines = baseLayers.filter((l) => l.type === 'line' && /boundary|admin/.test(l.id)).map((l) => ({ id: l.id, color: map.getPaintProperty(l.id, 'line-color') }));

      // --- alternative basemaps (NASA GIBS, public domain) ------------------------------------
      const gibsAttr = 'Imagery: <a href="https://earthdata.nasa.gov/gibs" target="_blank">NASA EOSDIS GIBS</a>';
      map.addSource('bm-ocean', { type: 'raster', tiles: [`${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`], tileSize: 256, maxzoom: 8, attribution: gibsAttr });
      map.addSource('bm-night', { type: 'raster', tiles: [`${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`], tileSize: 256, maxzoom: 8, attribution: gibsAttr });
      map.addLayer({ id: 'bm-ocean', type: 'raster', source: 'bm-ocean', layout: { visibility: 'none' }, paint: { 'raster-brightness-max': 0.72, 'raster-saturation': -0.15, 'raster-contrast': 0.12, 'raster-fade-duration': 400 } }, firstBase);
      map.addLayer({ id: 'bm-night', type: 'raster', source: 'bm-night', layout: { visibility: 'none' }, paint: { 'raster-contrast': 0.25, 'raster-brightness-min': 0.02, 'raster-fade-duration': 400 } }, firstBase);

      map.addSource('graticule', { type: 'geojson', data: graticule(15) });
      map.addLayer({
        id: 'graticule',
        type: 'line',
        source: 'graticule',
        maxzoom: 5,
        paint: { 'line-color': '#9fc4ff', 'line-width': 0.5, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 1, 0.13, 5, 0] },
      });

      map.addSource('fields', { type: 'geojson', data: atlas.fields, promoteId: 'id' });
      map.addSource('pipelines', { type: 'geojson', data: atlas.pipelines, promoteId: 'id', lineMetrics: true });
      map.addSource('assets', { type: 'geojson', data: assets, promoteId: 'id' });
      map.addSource('towers', { type: 'geojson', data: towers, promoteId: 'id' });
      map.addSource('fuel', { type: 'geojson', data: retailFc(atlas.retail.fuel) });
      map.addSource('fuel-hex', { type: 'geojson', data: fuelHex });
      map.addSource('ev', { type: 'geojson', data: retailFc(atlas.retail.ev) });

      // --- retail ------------------------------------------------------------------------
      map.addLayer({
        id: 'fuel-heat',
        type: 'heatmap',
        source: 'fuel',
        maxzoom: 9,
        paint: {
          'heatmap-weight': 0.6,
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 9, 2.2],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 2, 4, 8, 9, 18],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.85, 9, 0],
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(0,0,0,0)', 0.15, 'rgba(255,93,143,0.35)', 0.4, 'rgba(255,140,66,0.6)', 0.7, 'rgba(255,183,3,0.85)', 1, 'rgba(255,240,180,1)',
          ],
        },
      });
      map.addLayer({
        id: 'fuel-hex',
        type: 'fill-extrusion',
        source: 'fuel-hex',
        maxzoom: 9,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'n'], 1, '#3b1d63', 4, '#a01a8c', 10, '#ff5d8f', 22, '#ff8c42', 45, '#ffb703', Math.max(hexMax, 46), '#fff6cf'],
          'fill-extrusion-height': ['*', ['get', 'n'], 4200],
          'fill-extrusion-opacity': 0.88,
          'fill-extrusion-vertical-gradient': true,
        },
      });
      map.addLayer({
        id: 'fuel-points',
        type: 'circle',
        source: 'fuel',
        minzoom: 6.5,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 2, 14, 6],
          'circle-color': ['case', ['==', ['get', 'f'], 1], '#80ed99', '#ff8c42'],
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 6.5, 0, 8, 0.9],
          'circle-stroke-width': 0.5,
          'circle-stroke-color': '#070a0f',
        },
      });
      map.addLayer({
        id: 'ev-points',
        type: 'circle',
        source: 'ev',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 1.2, 8, 3, 14, 7],
          'circle-color': '#80ed99',
          'circle-blur': 0.2,
          'circle-opacity': 0.9,
        },
        layout: { visibility: 'none' },
      });

      // --- fields ------------------------------------------------------------------------
      const stakeFieldColor: ExpressionSpecification = ['match', ['get', 'stake'], 'operated', '#ffb703', 'jv', '#ff8c42', '#6aa8ff'];
      map.addLayer({
        id: 'fields-fill',
        type: 'fill',
        source: 'fields',
        paint: {
          'fill-color': stakeFieldColor,
          'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.45, ['boolean', ['feature-state', 'hover'], false], 0.32, 0.16],
        },
      });
      map.addLayer({
        id: 'fields-extrusion',
        type: 'fill-extrusion',
        source: 'fields',
        minzoom: 4.5,
        paint: {
          'fill-extrusion-color': stakeFieldColor,
          'fill-extrusion-height': ['*', ['coalesce', ['get', 'kboe'], 0], 220],
          'fill-extrusion-opacity': 0.55,
        },
      });
      map.addLayer({
        id: 'fields-line',
        type: 'line',
        source: 'fields',
        paint: {
          'line-color': stakeFieldColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 9, 1.8],
          'line-dasharray': ['case', ['==', ['get', 'stake'], 'partner'], ['literal', [2, 2]], ['literal', [1, 0]]],
          'line-opacity': 0.8,
        },
      });

      // --- pipelines -----------------------------------------------------------------------
      map.addLayer({
        id: 'pipelines-glow',
        type: 'line',
        source: 'pipelines',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': productColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2, 8, 8],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 2, 2, 8, 6],
          'line-opacity': 0.25,
        },
      });
      map.addLayer({
        id: 'pipelines',
        type: 'line',
        source: 'pipelines',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': productColor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 8, 1.6, 12, 3],
          'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.7],
        },
      });
      map.addLayer({
        id: 'pipelines-flow',
        type: 'line',
        source: 'pipelines',
        minzoom: 5,
        layout: { 'line-cap': 'butt' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 12, 2],
          'line-opacity': 0.35,
          'line-dasharray': [0, 4, 3],
        },
      });
      // Comets: a glowing pulse that travels down every trunk line. Two phases per product
      // so neighbouring lines don't all flash together.
      const COMET_RGB: Record<string, string> = { gas: '190,240,255', oil: '255,232,170' };
      const baseFilter: Record<string, FilterSpecification> = {};
      for (const id of COMET_IDS) {
        const [, , pc, ph] = id.split('-');
        baseFilter[id] = ['all', ['==', ['get', 'pc'], pc], ['==', ['get', 'ph'], Number(ph)], ['>=', ['get', 'length_km'], 12]];
        map.addLayer({
          id,
          type: 'line',
          source: 'pipelines',
          minzoom: 2.5,
          filter: baseFilter[id],
          layout: { 'line-cap': 'round', 'line-join': 'round', visibility: reduceMotion ? 'none' : 'visible' },
          paint: {
            'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.4, 8, 3.2, 12, 5],
            'line-blur': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 8, 1.5],
            'line-gradient': comet(Number(ph) * 0.5, COMET_RGB[pc]),
          },
        });
      }

      // --- assets ------------------------------------------------------------------------
      // `zoom` may only appear in a top-level interpolate, so the halo gets its own scaled copy.
      const radiusExpr = (k: number): ExpressionSpecification => [
        'interpolate', ['linear'], ['zoom'],
        1, ['*', k, ['+', ['case', ['boolean', ['get', 'featured'], false], 3, 1.6], ['*', ['sqrt', ['coalesce', ['get', 'kboe'], 0]], 0.35]]],
        6, ['*', k, ['+', ['case', ['boolean', ['get', 'featured'], false], 6, 3], ['*', ['sqrt', ['coalesce', ['get', 'kboe'], 0]], 0.9]]],
        12, ['*', k, ['+', ['case', ['boolean', ['get', 'featured'], false], 12, 7], ['*', ['sqrt', ['coalesce', ['get', 'kboe'], 0]], 1.6]]],
      ];
      const radius = radiusExpr(1);
      map.addLayer({
        id: 'assets-halo',
        type: 'circle',
        source: 'assets',
        paint: {
          'circle-radius': radiusExpr(2.6),
          'circle-color': segmentColor,
          'circle-blur': 1,
          'circle-opacity': ['case', ['>', ['coalesce', ['get', 'kboe'], 0], 0], 0.4, ['boolean', ['get', 'featured'], false], 0.28, 0],
        },
      });
      // Flagship sites breathe: an expanding ring in the segment colour.
      baseFilter['assets-beacon'] = ['boolean', ['get', 'featured'], false];
      map.addLayer({
        id: 'assets-beacon',
        type: 'circle',
        source: 'assets',
        filter: baseFilter['assets-beacon'],
        minzoom: 2.4,
        layout: { visibility: reduceMotion ? 'none' : 'visible' },
        paint: {
          'circle-radius': 6,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': segmentColor,
          'circle-stroke-width': 1.4,
          'circle-stroke-opacity': 0.6,
        },
      });
      map.addLayer({
        id: 'assets-pulse',
        type: 'circle',
        source: 'assets',
        filter: ['==', ['get', 'id'], '__none__'],
        paint: {
          'circle-radius': 10,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.8,
        },
      });
      baseFilter.towers = ['>', ['get', 'kboe'], 0];
      map.addLayer({
        id: 'towers',
        type: 'fill-extrusion',
        source: 'towers',
        minzoom: 3,
        filter: baseFilter.towers,
        paint: {
          'fill-extrusion-color': [
            'case',
            ['boolean', ['feature-state', 'hover'], false], '#ffffff',
            ['interpolate', ['linear'], ['get', 'kboe'], 0, '#ff7b29', 60, '#ffb703', 220, '#fff1b8'],
          ],
          'fill-extrusion-height': ['*', ['get', 'kboe'], 520],
          'fill-extrusion-opacity': 0.86,
          'fill-extrusion-vertical-gradient': true,
        },
      });
      map.addLayer({
        id: 'assets',
        type: 'circle',
        source: 'assets',
        paint: {
          'circle-radius': radius,
          // operated = solid, JV = solid with light ring, partner = hollow ring
          'circle-color': ['case', ['==', ['get', 'stake'], 'partner'], 'rgba(7,10,15,0.6)', segmentColor],
          'circle-stroke-color': ['case', ['==', ['get', 'stake'], 'operated'], '#070a0f', ['==', ['get', 'stake'], 'jv'], '#ffffff', segmentColor],
          'circle-stroke-width': ['case', ['==', ['get', 'stake'], 'operated'], 0.8, 1.6],
          'circle-pitch-alignment': 'map',
        },
      });
      baseFilter['assets-label'] = ['boolean', ['get', 'featured'], false];
      map.addLayer({
        id: 'assets-label',
        type: 'symbol',
        source: 'assets',
        filter: baseFilter['assets-label'],
        minzoom: 2.2,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Montserrat Medium', 'Open Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 10, 13],
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-optional': true,
          'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'kboe'], 0]],
        },
        paint: {
          'text-color': '#e9eef5',
          'text-halo-color': 'rgba(7,10,15,0.9)',
          'text-halo-width': 1.4,
        },
      });

      // --- interaction ---------------------------------------------------------------------
      let curMonth = 0;
      const sparkline = (seriesId: unknown): string => {
        const s = typeof seriesId === 'string' ? atlas.production.series[seriesId] : undefined;
        if (!s || s.oil.length < 2) return '';
        const vals = s.oil.map((o, i) => o + s.gas[i] / GAS_PER_BOE);
        const max = Math.max(1e-6, ...vals);
        const W = 132;
        const H = 26;
        const x = (i: number) => (i / (vals.length - 1)) * W;
        const y = (v: number) => H - 2 - (v / max) * (H - 4);
        const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
        const ci = Math.max(0, Math.min(vals.length - 1, curMonth - s.start));
        const now = seriesAt(s, curMonth);
        const read = now ? `${fmtNum(now.boe, now.boe < 10 ? 1 : 0)} kboe/d gross · ${fmtMonth(atlas.production.months[curMonth])}` : 'not producing in this month';
        return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><path d="${d}L${W},${H}L0,${H}Z" class="a"/><path d="${d}"/><circle cx="${x(ci).toFixed(1)}" cy="${y(vals[ci]).toFixed(1)}" r="2.5"/></svg><em>${read}</em>`;
      };

      let hovered: { source: string; id: string } | null = null;
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'hover-pop', offset: 12 });
      const setHover = (source: string, id: string | null) => {
        if (hovered) map.setFeatureState(hovered, { hover: false });
        hovered = id ? { source, id } : null;
        if (hovered) map.setFeatureState(hovered, { hover: true });
      };
      const hoverable: [string, string][] = [
        ['assets', 'assets'],
        ['towers', 'towers'],
        ['fields-fill', 'fields'],
        ['pipelines', 'pipelines'],
      ];
      for (const [layer, source] of hoverable) {
        map.on('mousemove', layer, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          map.getCanvas().style.cursor = 'pointer';
          const id = String(f.properties.id);
          popup.setLngLat(e.lngLat);
          if (hovered?.source === source && hovered.id === id && popup.isOpen()) return;
          setHover(source, id);
          const p = f.properties as Record<string, unknown>;
          const sub =
            source === 'pipelines'
              ? `${p.product ?? 'Pipeline'} · ${p.length_km} km${p.size_in ? ` · ${p.size_in}″` : ''}`
              : `${p.subtype ?? p.kind} · ${p.country ?? ''}`;
          popup
            .setHTML(`<strong>${escapeHtml(String(p.name ?? p.route ?? ''))}</strong><span>${escapeHtml(sub)}</span>${source === 'pipelines' ? '' : sparkline(p.series)}`)
            .addTo(map);
        });
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = '';
          setHover(source, null);
          popup.remove();
        });
      }
      const pickable = ['assets', 'towers', 'fields-fill', 'pipelines'];
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: pickable.filter((l) => map.getLayoutProperty(l, 'visibility') !== 'none') });
        const isAsset = (id: string) => id === 'assets' || id === 'towers';
        const hit = hits.find((h) => isAsset(h.layer.id)) ?? hits.find((h) => h.layer.id === 'fields-fill') ?? hits[0];
        if (!hit) return onPick(null, null);
        stopSpin();
        const kind = isAsset(hit.layer.id) ? 'asset' : hit.layer.id === 'fields-fill' ? 'field' : 'pipeline';
        const id = String(hit.properties.id);
        if (kind === 'pipeline') return onPick(null, 'pipeline', hit.properties);
        const src = kind === 'asset' ? assets : atlas.fields;
        const full = (src.features as Feature[]).find((f) => (f.properties as AssetProps).id === id);
        onPick((full?.properties as AssetProps) ?? null, kind);
      });

      // --- animation loop: orbit, pipeline flow, comets, beacons, selection pulse -----------
      const dashSeq = [
        [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
        [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
      ];
      let step = -1;
      let last = 0;
      let prev = 0;
      const ctrl = {} as MapController;
      const setOrbit = (on: boolean) => {
        on = on && !reduceMotion;
        if (on === orbit) return;
        orbit = on;
        if (on) stopSpin();
        ctrl.onOrbitChange?.(on);
      };
      const interrupt = () => {
        userInteracting = true;
        setOrbit(false);
      };
      map.on('mousedown', interrupt);
      map.on('touchstart', interrupt);
      map.on('dragstart', stopSpin);
      map.on('wheel', () => {
        stopSpin();
        setOrbit(false);
      });

      const animate = (t: number) => {
        const dt = Math.min(64, t - prev);
        prev = t;
        if (orbit && !map.isMoving()) map.setBearing(map.getBearing() + dt * 0.0045);
        if (t - last > 60 && !reduceMotion) {
          last = t;
          const pipesOn = map.getLayoutProperty('pipelines', 'visibility') !== 'none';
          const s = Math.floor(t / 60) % dashSeq.length;
          if (s !== step && pipesOn && map.getZoom() >= 5) {
            map.setPaintProperty('pipelines-flow', 'line-dasharray', dashSeq[s]);
            step = s;
          }
          if (pipesOn && map.getZoom() >= 2.5) {
            const head = (t % 3600) / 3600;
            for (const id of COMET_IDS) {
              const [, , pc, ph] = id.split('-');
              map.setPaintProperty(id, 'line-gradient', comet((head + Number(ph) * 0.5) % 1, COMET_RGB[pc]));
            }
          }
          const phase = (t % 1600) / 1600;
          map.setPaintProperty('assets-pulse', 'circle-radius', 8 + phase * 26);
          map.setPaintProperty('assets-pulse', 'circle-stroke-opacity', 0.9 * (1 - phase));
          const beat = (t % 2800) / 2800;
          map.setPaintProperty('assets-beacon', 'circle-radius', 5 + beat * 20);
          map.setPaintProperty('assets-beacon', 'circle-stroke-opacity', 0.55 * (1 - beat) * (1 - beat));
        }
        requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);

      // --- controller --------------------------------------------------------------------
      const productionAt = (seriesId: string | undefined, idx: number) => {
        if (!seriesId) return 0;
        const v = seriesAt(atlas.production.series[seriesId], idx);
        return v ? Math.round(v.boe * 10) / 10 : 0;
      };
      const visible: Record<LayerKey, boolean> = { assets: true, fields: true, pipelines: true, fuel: true, ev: false };
      let fuelMode: FuelMode = 'heat';
      const applyVisibility = (key: LayerKey) => {
        for (const id of LAYER_IDS[key]) {
          let on = visible[key];
          if (id === 'fuel-heat') on &&= fuelMode === 'heat';
          if (id === 'fuel-hex') on &&= fuelMode === 'hex';
          if (reduceMotion && (COMET_IDS.includes(id) || id === 'assets-beacon')) on = false;
          map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        }
      };

      Object.assign(ctrl, {
        map,
        seriesOwner,
        stopSpin,
        setOrbit,
        onOrbitChange: () => {},
        setMonth(idx) {
          curMonth = idx;
          for (const f of assets.features) {
            const p = f.properties as AssetProps & { kboe?: number };
            p.kboe = p.series && seriesOwner.get(p.series) === p.id ? productionAt(p.series, idx) : 0;
          }
          for (const f of atlas.fields.features) {
            const p = f.properties as AssetProps & { kboe?: number };
            p.kboe = productionAt(p.series, idx);
          }
          for (const f of towers.features) f.properties.kboe = productionAt(f.properties.series, idx);
          (map.getSource('assets') as GeoJSONSource).setData(assets);
          (map.getSource('fields') as GeoJSONSource).setData(atlas.fields);
          (map.getSource('towers') as GeoJSONSource).setData(towers);
        },
        setLayerVisible(key, on) {
          visible[key] = on;
          applyVisibility(key);
        },
        setStakes(stakes) {
          const f: FilterSpecification = ['in', ['get', 'stake'], ['literal', [...stakes]]];
          for (const id of [...LAYER_IDS.assets.filter((l) => l !== 'assets-pulse'), ...LAYER_IDS.fields, ...LAYER_IDS.pipelines]) {
            map.setFilter(id, baseFilter[id] ? (['all', baseFilter[id], f] as FilterSpecification) : f);
          }
        },
        setBasemap(mode) {
          const imagery = mode !== 'dark';
          for (const l of hiddenOnImagery) map.setLayoutProperty(l.id, 'visibility', imagery ? 'none' : l.visibility);
          for (const l of boundaryLines) map.setPaintProperty(l.id, 'line-color', imagery ? 'rgba(255,255,255,0.32)' : l.color);
          map.setLayoutProperty('bm-ocean', 'visibility', mode === 'ocean' ? 'visible' : 'none');
          map.setLayoutProperty('bm-night', 'visibility', mode === 'night' ? 'visible' : 'none');
        },
        setColorMode(mode) {
          const c = COLOR_MODES[mode].expr;
          map.setPaintProperty('assets', 'circle-color', ['case', ['==', ['get', 'stake'], 'partner'], 'rgba(7,10,15,0.6)', c]);
          map.setPaintProperty('assets', 'circle-stroke-color', ['case', ['==', ['get', 'stake'], 'operated'], '#070a0f', ['==', ['get', 'stake'], 'jv'], '#ffffff', c]);
          map.setPaintProperty('assets-halo', 'circle-color', c);
          map.setPaintProperty('assets-beacon', 'circle-stroke-color', c);
        },
        setFuelMode(mode) {
          fuelMode = mode;
          applyVisibility('fuel');
        },
        select(id) {
          map.setFilter('assets-pulse', ['==', ['get', 'id'], id ?? '__none__']);
          for (const f of atlas.fields.features) map.setFeatureState({ source: 'fields', id: f.properties.id }, { selected: f.properties.id === id });
        },
      } satisfies MapController);
      resolve(ctrl);
    });
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
