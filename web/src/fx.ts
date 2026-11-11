// Visual effects and geometry helpers that sit around the map: parallax starfield, HUD read-out,
// hexagonal binning for the 3D retail skyline, and small polygon builders.
import type { Map as MLMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function starTile(size: number, count: number, seed: number, maxR: number): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.25 + Math.pow(rnd(), 3) * maxR;
    const tint = rnd();
    g.fillStyle = tint < 0.15 ? `rgba(255,214,170,${0.4 + rnd() * 0.5})` : tint < 0.35 ? `rgba(170,205,255,${0.4 + rnd() * 0.5})` : `rgba(255,255,255,${0.25 + rnd() * 0.6})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  return c.toDataURL();
}

/** Two tiled star layers behind the (transparent) globe canvas that drift as the globe turns. */
export function starfield(el: HTMLElement, map: MLMap) {
  el.style.backgroundImage = `url(${starTile(640, 260, 7, 1.3)}), url(${starTile(900, 180, 99, 0.9)})`;
  const update = () => {
    const c = map.getCenter();
    const b = map.getBearing();
    const x = -c.lng * 5 + b * 2;
    const y = c.lat * 5;
    el.style.backgroundPosition = `${x.toFixed(1)}px ${y.toFixed(1)}px, ${(x * 0.45).toFixed(1)}px ${(y * 0.45).toFixed(1)}px`;
    // Stars fade out as the camera drops towards the surface.
    el.style.opacity = String(Math.max(0, Math.min(1, (5.5 - map.getZoom()) / 2)));
  };
  map.on('move', update);
  update();
}

const fmtCoord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? pos : neg}`;

/** Cockpit-style read-out: cursor position and approximate camera altitude. */
export function hud(el: HTMLElement, map: MLMap) {
  let cursor = map.getCenter();
  let pointed = false;
  const render = () => {
    const lat = map.getCenter().lat;
    const metresPerPx = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * Math.pow(2, map.getZoom()));
    const altKm = (metresPerPx * (map.getContainer().clientHeight / 2)) / Math.tan((18.435 * Math.PI) / 180) / 1000;
    const alt = altKm >= 100 ? `${Math.round(altKm).toLocaleString('en-US')} km` : `${altKm.toFixed(1)} km`;
    el.innerHTML = `<span>${fmtCoord(cursor.lat, 'N', 'S')}</span><span>${fmtCoord(cursor.lng, 'E', 'W')}</span><span><i>ALT</i>${alt}</span><span><i>HDG</i>${String(Math.round((map.getBearing() + 360) % 360)).padStart(3, '0')}°</span>`;
  };
  map.on('mousemove', (e) => {
    cursor = e.lngLat.wrap();
    pointed = true;
    render();
  });
  map.on('move', () => {
    if (!pointed) cursor = map.getCenter().wrap();
    render();
  });
  render();
}

/** Hexagon (closed ring) of `km` circumradius around a point. */
export function hexAround([lng, lat]: [number, number], km: number): number[][] {
  const dLat = km / 110.57;
  const dLng = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  const ring: number[][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = (Math.PI / 3) * (i % 6);
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}

/**
 * Bins points into pointy-top hexagons laid out in Web Mercator space, so cells look regular
 * on the map. `radiusDeg` is the cell circumradius in degrees of longitude.
 */
export function hexbin(points: [number, number, number][], radiusDeg: number): FeatureCollection<Polygon, { n: number }> {
  const R = radiusDeg / 360;
  const S3 = Math.sqrt(3);
  const mx = (lng: number) => (lng + 180) / 360;
  const my = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const lngOf = (x: number) => x * 360 - 180;
  const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

  const bins = new Map<string, { q: number; r: number; n: number }>();
  for (const [lng, lat] of points) {
    if (Math.abs(lat) > 84) continue;
    const x = mx(lng);
    const y = my(lat);
    const qf = ((S3 / 3) * x - y / 3) / R;
    const rf = ((2 / 3) * y) / R;
    // cube rounding
    let q = Math.round(qf);
    let r = Math.round(rf);
    const s = Math.round(-qf - rf);
    const dq = Math.abs(q - qf);
    const dr = Math.abs(r - rf);
    const ds = Math.abs(s + qf + rf);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    const key = `${q},${r}`;
    const b = bins.get(key);
    if (b) b.n++;
    else bins.set(key, { q, r, n: 1 });
  }

  const features: Feature<Polygon, { n: number }>[] = [];
  for (const { q, r, n } of bins.values()) {
    const cx = R * S3 * (q + r / 2);
    const cy = R * 1.5 * r;
    const ring: number[][] = [];
    for (let i = 0; i <= 6; i++) {
      const a = (Math.PI / 3) * (i % 6) - Math.PI / 6;
      ring.push([lngOf(cx + R * 0.9 * Math.cos(a)), latOf(cy + R * 0.9 * Math.sin(a))]);
    }
    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { n } });
  }
  return { type: 'FeatureCollection', features };
}

/** Lat/lon grid every `step` degrees, densified so lines curve properly on the globe. */
export function graticule(step: number): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (let lng = -180; lng < 180; lng += step) {
    const coords: number[][] = [];
    for (let lat = -80; lat <= 80; lat += 4) coords.push([lng, lat]);
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
  }
  for (let lat = -60; lat <= 60; lat += step) {
    const coords: number[][] = [];
    for (let lng = -180; lng <= 180; lng += 4) coords.push([lng, lat]);
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
  }
  return { type: 'FeatureCollection', features };
}
