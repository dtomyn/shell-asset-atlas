// Storm maths with no DOM or map dependency, so it can be unit-tested with `npm test`:
// Saffir-Simpson categories, position along a track, and "production in the path".

/** [minutes since the Unix epoch (UTC), lat, lon, max sustained wind in kt, HURDAT2 status] */
export type TrackPoint = [number, number, number, number, string];
export type LngLat = [number, number];

// --- Saffir-Simpson -----------------------------------------------------------------
/** Index 0 = not tropical (remnant low, extratropical), 1 = depression, 2 = tropical storm, 3..7 = category 1..5. */
export const STORM_CLASSES = [
  { label: 'Post-tropical / low', short: 'Low', color: '#5b6778' },
  { label: 'Tropical depression', short: 'TD', color: '#8ecae6' },
  { label: 'Tropical storm', short: 'TS', color: '#4cc9f0' },
  { label: 'Category 1 hurricane', short: 'Cat 1', color: '#ffe08a' },
  { label: 'Category 2 hurricane', short: 'Cat 2', color: '#ffb703' },
  { label: 'Category 3 hurricane', short: 'Cat 3', color: '#ff8c42' },
  { label: 'Category 4 hurricane', short: 'Cat 4', color: '#ff5d8f' },
  { label: 'Category 5 hurricane', short: 'Cat 5', color: '#c77dff' },
] as const;

const TROPICAL = new Set(['TD', 'TS', 'HU', 'SD', 'SS']);

/** Index into STORM_CLASSES for a 1-minute sustained wind in knots. */
export function stormClass(kt: number, status = 'HU'): number {
  if (!TROPICAL.has(status)) return 0;
  if (kt >= 137) return 7;
  if (kt >= 113) return 6;
  if (kt >= 96) return 5;
  if (kt >= 83) return 4;
  if (kt >= 64) return 3;
  if (kt >= 34) return 2;
  return 1;
}

// --- track --------------------------------------------------------------------------
/** Interpolated position, wind and status at time `t` (minutes since the epoch), clamped to the track. */
export function trackAt(track: TrackPoint[], t: number): { lng: number; lat: number; kt: number; status: string; t: number } {
  const first = track[0];
  const last = track[track.length - 1];
  if (t <= first[0]) return { lng: first[2], lat: first[1], kt: first[3], status: first[4], t: first[0] };
  if (t >= last[0]) return { lng: last[2], lat: last[1], kt: last[3], status: last[4], t: last[0] };
  let i = 1;
  while (track[i][0] < t) i++;
  const a = track[i - 1];
  const b = track[i];
  const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  return { lng: a[2] + f * (b[2] - a[2]), lat: a[1] + f * (b[1] - a[1]), kt: Math.round(a[3] + f * (b[3] - a[3])), status: f < 0.5 ? a[4] : b[4], t };
}

// --- distance -----------------------------------------------------------------------
const KM_PER_DEG = 111.195;

/** Distance in km from a point to a polyline, on a flat projection centred on the point. */
export function distanceToLineKm([lng, lat]: LngLat, line: LngLat[]): number {
  const kx = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i < line.length; i++) {
    const ax = (line[i][0] - lng) * kx;
    const ay = (line[i][1] - lat) * KM_PER_DEG;
    if (i === line.length - 1) {
      best = Math.min(best, Math.hypot(ax, ay));
      break;
    }
    const dx = (line[i + 1][0] - lng) * kx - ax;
    const dy = (line[i + 1][1] - lat) * KM_PER_DEG - ay;
    const len2 = dx * dx + dy * dy;
    const f = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + f * dx, ay + f * dy));
  }
  return best;
}

/** Even-odd ray cast. `ring` is [lng, lat] pairs; it may or may not repeat its first point. */
export function pointInRing([x, y]: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --- production in the path ---------------------------------------------------------
export interface Hub {
  id: string;
  name: string;
  /** every installation that reports under this production series */
  sites: LngLat[];
  /** gross kboe/d in the latest reported month */
  kboed: number;
}

export interface ForecastPath {
  /** forecast cone of uncertainty: one closed ring */
  cone?: LngLat[] | null;
  /** forecast track of the centre */
  track?: LngLat[] | null;
  /** current position, used when there is no track */
  lon?: number | null;
  lat?: number | null;
}

/**
 * Hubs "in the path" of a forecast: inside the cone, or within `radiusKm` of the forecast
 * track (or of the current position when no track was published). Each hub's production is
 * counted once, however many of its installations are in the path.
 */
export function productionInPath(hubs: Hub[], path: ForecastPath, radiusKm: number): { kboed: number; hubs: Hub[] } {
  const line: LngLat[] | null = path.track && path.track.length ? path.track : path.lon != null && path.lat != null ? [[path.lon, path.lat]] : null;
  const cone = path.cone && path.cone.length >= 3 ? path.cone : null;
  const hit = hubs.filter((h) => h.sites.some((s) => (cone !== null && pointInRing(s, cone)) || (line !== null && distanceToLineKm(s, line) <= radiusKm)));
  hit.sort((a, b) => b.kboed - a.kboed);
  return { kboed: hit.reduce((a, h) => a + h.kboed, 0), hubs: hit };
}
