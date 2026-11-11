// MapLibre globe + all thematic layers. Everything is native MapLibre (no deck.gl) so the
// globe projection, 3D extrusions and atmosphere work together without a second renderer.
import maplibregl, { type GeoJSONSource, type Map as MLMap, type ExpressionSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { SEGMENTS, segmentOf, seriesAt, type Atlas, type AssetProps, type Stake } from './data';

const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export type LayerKey = 'assets' | 'fields' | 'pipelines' | 'fuel' | 'ev';

export const LAYER_IDS: Record<LayerKey, string[]> = {
  assets: ['assets-halo', 'assets-pulse', 'assets', 'assets-label'],
  fields: ['fields-fill', 'fields-extrusion', 'fields-line'],
  pipelines: ['pipelines-glow', 'pipelines', 'pipelines-flow'],
  fuel: ['fuel-heat', 'fuel-points'],
  ev: ['ev-points'],
};

const segmentColor: ExpressionSpecification = [
  'match',
  ['get', 'segment'],
  ...Object.entries(SEGMENTS).flatMap(([k, v]) => [k, v.color]),
  SEGMENTS.upstream.color,
] as unknown as ExpressionSpecification;

const productColor: ExpressionSpecification = [
  'case',
  ['in', 'gas', ['downcase', ['coalesce', ['get', 'product'], '']]],
  '#4cc9f0',
  ['any', ['in', 'oil', ['downcase', ['coalesce', ['get', 'product'], '']]], ['in', 'blko', ['downcase', ['coalesce', ['get', 'product'], '']]]],
  '#ffb703',
  '#9aa7b8',
];

export interface MapController {
  map: MLMap;
  setMonth(idx: number): void;
  setLayerVisible(key: LayerKey, on: boolean): void;
  setStakes(stakes: Set<Stake>): void;
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
    minZoom: 0.8,
    maxPitch: 75,
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

  // Pre-compute derived props once.
  const assets = atlas.assets;
  for (const f of assets.features) {
    (f.properties as AssetProps & { segment: string }).segment = segmentOf(f.properties.kind);
  }
  const fieldMarkers: FeatureCollection<Point, AssetProps> = { type: 'FeatureCollection', features: [] };
  for (const f of atlas.fields.features) {
    const p = f.properties;
    (p as AssetProps & { segment: string }).segment = 'upstream';
    if (p.center) fieldMarkers.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.center }, properties: { ...p } });
  }

  const retailFc = (rows: [number, number, number][]): FeatureCollection<Point> => ({
    type: 'FeatureCollection',
    features: rows.map(([x, y, f]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { f } })),
  });

  let spinning = true;
  let userInteracting = false;
  const stopSpin = () => {
    spinning = false;
  };
  const spin = () => {
    if (!spinning || userInteracting || map.getZoom() > 3) return;
    const c = map.getCenter();
    c.lng -= 6;
    map.easeTo({ center: c, duration: 1000, easing: (n) => n });
  };
  map.on('mousedown', () => (userInteracting = true));
  map.on('touchstart', () => (userInteracting = true));
  map.on('dragstart', stopSpin);
  map.on('wheel', stopSpin);
  map.on('moveend', spin);

  return new Promise((resolve) => {
    map.on('style.load', () => {
      map.setProjection({ type: 'globe' });
      map.setSky({
        'sky-color': '#0b1a2e',
        'horizon-color': '#1c3d63',
        'fog-color': '#070a0f',
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.6,
        'fog-ground-blend': 0.5,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
      });
      // Calm the basemap down so the data reads first.
      for (const layer of map.getStyle().layers ?? []) {
        if (layer.type === 'symbol' && /place|label/.test(layer.id) && !/country|continent/.test(layer.id)) {
          map.setPaintProperty(layer.id, 'text-opacity', 0.55);
        }
      }

      map.addSource('fields', { type: 'geojson', data: atlas.fields, promoteId: 'id' });
      map.addSource('pipelines', { type: 'geojson', data: atlas.pipelines, promoteId: 'id' });
      map.addSource('assets', { type: 'geojson', data: assets, promoteId: 'id' });
      map.addSource('field-markers', { type: 'geojson', data: fieldMarkers, promoteId: 'id' });
      map.addSource('fuel', { type: 'geojson', data: retailFc(atlas.retail.fuel) });
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
          'line-opacity': 0.55,
          'line-dasharray': [0, 4, 3],
        },
      });

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
          'circle-radius': radiusExpr(2.4),
          'circle-color': segmentColor,
          'circle-blur': 1,
          'circle-opacity': ['case', ['>', ['coalesce', ['get', 'kboe'], 0], 0], 0.35, ['boolean', ['get', 'featured'], false], 0.22, 0],
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
          'circle-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.15, 1],
          'circle-stroke-opacity': ['case', ['boolean', ['feature-state', 'dim'], false], 0.15, 1],
          'circle-pitch-alignment': 'map',
        },
      });
      map.addLayer({
        id: 'assets-label',
        type: 'symbol',
        source: 'assets',
        filter: ['boolean', ['get', 'featured'], false],
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
      let hovered: { source: string; id: string } | null = null;
      const setHover = (source: string, id: string | null) => {
        if (hovered) map.setFeatureState(hovered, { hover: false });
        hovered = id ? { source, id } : null;
        if (hovered) map.setFeatureState(hovered, { hover: true });
      };
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'hover-pop', offset: 12 });
      const hoverable: [string, string][] = [
        ['assets', 'assets'],
        ['fields-fill', 'fields'],
        ['pipelines', 'pipelines'],
      ];
      for (const [layer, source] of hoverable) {
        map.on('mousemove', layer, (e) => {
          const f = e.features?.[0];
          if (!f) return;
          map.getCanvas().style.cursor = 'pointer';
          setHover(source, String(f.properties.id));
          const p = f.properties as Record<string, unknown>;
          const sub =
            source === 'pipelines'
              ? `${p.product ?? 'Pipeline'} · ${p.length_km} km${p.size_in ? ` · ${p.size_in}″` : ''}`
              : `${p.subtype ?? p.kind} · ${p.country ?? ''}`;
          popup.setLngLat(e.lngLat).setHTML(`<strong>${escapeHtml(String(p.name ?? p.route ?? ''))}</strong><span>${escapeHtml(sub)}</span>`).addTo(map);
        });
        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = '';
          setHover(source, null);
          popup.remove();
        });
      }
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['assets', 'fields-fill', 'pipelines'].filter((l) => map.getLayoutProperty(l, 'visibility') !== 'none') });
        const hit = hits.find((h) => h.layer.id === 'assets') ?? hits.find((h) => h.layer.id === 'fields-fill') ?? hits[0];
        if (!hit) return onPick(null, null);
        stopSpin();
        const kind = hit.layer.id === 'assets' ? 'asset' : hit.layer.id === 'fields-fill' ? 'field' : 'pipeline';
        const id = String(hit.properties.id);
        if (kind === 'pipeline') return onPick(null, 'pipeline', hit.properties);
        const src = kind === 'asset' ? assets : atlas.fields;
        const full = (src.features as Feature[]).find((f) => (f.properties as AssetProps).id === id);
        onPick((full?.properties as AssetProps) ?? null, kind);
      });

      // --- animation loop: pipeline flow + selection pulse -------------------------------
      const dashSeq = [
        [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
        [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
      ];
      let step = -1;
      let last = 0;
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animate = (t: number) => {
        if (t - last > 60 && !reduceMotion) {
          last = t;
          const s = Math.floor(t / 60) % dashSeq.length;
          if (s !== step && map.getLayoutProperty('pipelines-flow', 'visibility') !== 'none') {
            map.setPaintProperty('pipelines-flow', 'line-dasharray', dashSeq[s]);
            step = s;
          }
          const phase = (t % 1600) / 1600;
          map.setPaintProperty('assets-pulse', 'circle-radius', 8 + phase * 26);
          map.setPaintProperty('assets-pulse', 'circle-stroke-opacity', 0.9 * (1 - phase));
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
      // Each production series is drawn once: on its featured hub if there is one, else the first asset.
      const seriesOwner = new Map<string, string>();
      for (const f of assets.features) {
        const s = f.properties.series;
        if (!s) continue;
        const cur = seriesOwner.get(s);
        const curF = cur ? assets.features.find((x) => x.properties.id === cur) : undefined;
        if (!cur || (f.properties.featured && !curF?.properties.featured)) seriesOwner.set(s, f.properties.id);
      }
      for (const f of atlas.fields.features) if (f.properties.series) seriesOwner.set(f.properties.series, f.properties.id);

      const ctrl: MapController = {
        map,
        stopSpin,
        setMonth(idx) {
          for (const f of assets.features) {
            const p = f.properties as AssetProps & { kboe?: number };
            p.kboe = p.series && seriesOwner.get(p.series) === p.id ? productionAt(p.series, idx) : 0;
          }
          for (const f of atlas.fields.features) {
            const p = f.properties as AssetProps & { kboe?: number };
            p.kboe = productionAt(p.series, idx);
          }
          (map.getSource('assets') as GeoJSONSource).setData(assets);
          (map.getSource('fields') as GeoJSONSource).setData(atlas.fields);
        },
        setLayerVisible(key, on) {
          for (const id of LAYER_IDS[key]) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        },
        setStakes(stakes) {
          const list = ['literal', [...stakes]] as unknown as ExpressionSpecification;
          const f: ExpressionSpecification = ['in', ['get', 'stake'], list];
          for (const id of [...LAYER_IDS.assets.filter((l) => l !== 'assets-pulse'), ...LAYER_IDS.fields, ...LAYER_IDS.pipelines]) {
            const base = id === 'assets-label' ? (['all', ['boolean', ['get', 'featured'], false], f] as ExpressionSpecification) : f;
            map.setFilter(id, base);
          }
        },
        select(id) {
          map.setFilter('assets-pulse', ['==', ['get', 'id'], id ?? '__none__']);
          for (const f of atlas.fields.features) map.setFeatureState({ source: 'fields', id: f.properties.id }, { selected: f.properties.id === id });
        },
      };
      resolve(ctrl);
    });
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
