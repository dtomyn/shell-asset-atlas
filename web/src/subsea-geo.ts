// Pure geometry and data helpers for the subsea view. No DOM and no three.js in here, so the
// unit tests (web/tests/subsea-geo.test.ts) can run them under plain Node.
//
// Frames. The pipeline writes well paths as [east, north, depth] triples in metres, relative
// to the hub, with depth positive downward from sea level. The scene uses x = east,
// y = up (so y = -depth) and z = south, which `toScene` converts to.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface WellRecord {
  api: string;
  name: string;
  /** BOEM borehole status code, e.g. COM, PA, ST */
  status: string;
  type: string;
  spud: string | null;
  /** water depth at the well, m */
  wd: number;
  /** total measured depth along the hole, from the rig floor, m */
  md: number;
  /** deepest point, m below sea level */
  tvd: number;
  /** new hole made by this borehole, m; null when unknown */
  drilled: number | null;
  /** 1 = path from a directional survey, 0 = schematic (surface to bottom-hole) */
  sv: 0 | 1;
  /** host = BOEM lists the hub as the well's complex; field = same field code, no complex on file */
  tie: 'host' | 'field';
  /** flat [east, north, depth, ...] in metres relative to the hub */
  path: number[];
}

export interface SeabedGrid {
  n: number;
  /** n*n depths in metres, row by row from the south-west corner */
  depth: number[];
  control_points: number;
}

export interface HubWells {
  name: string;
  lon: number;
  lat: number;
  water_depth_m: number;
  radius_m: number;
  seabed: SeabedGrid;
  stats: {
    wells: number;
    surveyed: number;
    schematic: number;
    by_field_code: number;
    beyond_window: number;
    deepest_tvd_m: number;
    deepest_well: string;
    drilled_m: number;
    drilled_unknown: number;
  };
  wells: WellRecord[];
}

export interface WellsData {
  method: { simplify_m: number; max_radius_m: number; seabed: string; check: { surveys: number; tvd_max_diff_m: number | null } | null };
  status: Record<string, string>;
  types: Record<string, string>;
  hubs: Record<string, HubWells>;
}

export const FT_PER_M = 1 / 0.3048;

/** Metres per degree of (longitude, latitude) at a latitude, WGS84. Same series as the pipeline's geo.py. */
export function metresPerDegree(lat: number): Vec2 {
  const p = (lat * Math.PI) / 180;
  return [
    111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
    111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
  ];
}

/** [east, north] in metres from the hub. */
export function toLocal(lon: number, lat: number, hubLon: number, hubLat: number): Vec2 {
  const [mx, my] = metresPerDegree(hubLat);
  return [(lon - hubLon) * mx, (lat - hubLat) * my];
}

/** Flat [e, n, d, e, n, d, ...] to points. */
export function triples(flat: number[]): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}

/** [east, north, depth] to scene [x, y, z] with y up and z south. */
export const toScene = (p: Vec3, exaggeration = 1): Vec3 => [p[0], -p[2] * exaggeration, -p[1]];

export function pathLength(path: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
  return total;
}

/**
 * Cut a path where it first goes deeper than `depth`: the part in the water column (drilling
 * or production riser) and the part below the seabed. Both get the crossing point.
 */
export function splitAtDepth(path: Vec3[], depth: number): { above: Vec3[]; below: Vec3[] } {
  const i = path.findIndex((p) => p[2] > depth);
  if (i < 0) return { above: path.slice(), below: [] };
  if (i === 0) return { above: [], below: path.slice() };
  const a = path[i - 1];
  const b = path[i];
  const t = (depth - a[2]) / (b[2] - a[2]);
  const cut: Vec3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), depth];
  const above = path.slice(0, i);
  if (t > 0) above.push(cut);
  return { above, below: [cut, ...path.slice(i)] };
}

/** Seabed depth (m) at [east, north], bilinear on the grid, clamped at the edges. */
export function seabedAt(grid: SeabedGrid, radius: number, east: number, north: number): number {
  const n = grid.n;
  const f = (v: number) => Math.max(0, Math.min(n - 1, ((v + radius) / (2 * radius)) * (n - 1)));
  const fx = f(east);
  const fy = f(north);
  const i = Math.min(n - 2, Math.floor(fx));
  const j = Math.min(n - 2, Math.floor(fy));
  const u = fx - i;
  const v = fy - j;
  const d = (ii: number, jj: number) => grid.depth[jj * n + ii];
  return d(i, j) * (1 - u) * (1 - v) + d(i + 1, j) * u * (1 - v) + d(i, j + 1) * (1 - u) * v + d(i + 1, j + 1) * u * v;
}

/** Liang–Barsky: the part of segment a→b inside the square |x|,|y| <= r, or null. */
export function clipSegment(a: Vec2, b: Vec2, r: number): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const edges: Vec2[] = [
    [-dx, a[0] + r],
    [dx, r - a[0]],
    [-dy, a[1] + r],
    [dy, r - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return null;
      t1 = Math.min(t1, t);
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** Clip a polyline to the square |x|,|y| <= r. A line that leaves and comes back gives several pieces. */
export function clipLine(line: Vec2[], r: number): Vec2[][] {
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (let i = 1; i < line.length; i++) {
    const seg = clipSegment(line[i - 1], line[i], r);
    if (!seg) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const [p, q] = seg;
    const last = cur[cur.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) {
      if (cur.length > 1) out.push(cur);
      cur = [p];
    }
    cur.push(q);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** Lay a line on the seabed: add points every `step` metres and give each the seabed depth there. */
export function drape(line: Vec2[], grid: SeabedGrid, radius: number, step: number): Vec3[] {
  const out: Vec3[] = [];
  const put = (x: number, y: number) => out.push([x, y, seabedAt(grid, radius, x, y)]);
  for (let i = 0; i < line.length; i++) {
    if (i > 0) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const parts = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
      for (let k = 1; k < parts; k++) put(ax + ((bx - ax) * k) / parts, ay + ((by - ay) * k) / parts);
    }
    put(line[i][0], line[i][1]);
  }
  return out;
}

/** A round step (1, 2, 2.5 or 5 times a power of ten) that gives at most `maxTicks` marks over `range`. */
export function niceStep(range: number, maxTicks: number): number {
  const raw = range / Math.max(1, maxTicks);
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw - 1e-9) return m * pow;
  return 10 * pow;
}

/** Depth marks for the ruler: 0, step, 2*step ... up to and including `maxDepth` (if it is a multiple). */
export function depthTicks(maxDepth: number, maxTicks = 8): number[] {
  const step = niceStep(maxDepth, maxTicks);
  const out: number[] = [];
  for (let d = 0; d <= maxDepth + 1e-6; d += step) out.push(d);
  return out;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Which screen-space polyline is nearest the pointer, if any is within `tolerance` pixels.
 * A null point (behind the camera) breaks the line.
 */
export function pickPath(paths: (Vec2 | null)[][], x: number, y: number, tolerance: number): number {
  let best = -1;
  let bestD = tolerance;
  paths.forEach((path, idx) => {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (!a || !b) continue;
      const d = distToSegment(x, y, a[0], a[1], b[0], b[1]);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
  });
  return best;
}

// --- colours ---------------------------------------------------------------------------
export const STATUS_COLORS: Record<string, string> = {
  COM: '#80ed99',
  TA: '#ff8c42',
  PA: '#ff5d8f',
  ST: '#8a97a8',
  DRL: '#ffb703',
  DSI: '#ffb703',
  AST: '#ffb703',
};
export const STATUS_OTHER = '#c8b6ff';
export const statusColor = (code: string) => STATUS_COLORS[code] ?? STATUS_OTHER;

export const YEAR_RAMP = ['#5b6ee1', '#4cc9f0', '#ffe08a'];

export function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('');
}

export function rampColor(stops: string[], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mixHex(stops[i], stops[i + 1], x - i);
}

export const spudYear = (w: Pick<WellRecord, 'spud'>): number | null => (w.spud ? Number(w.spud.slice(0, 4)) : null);

export function yearRange(wells: Pick<WellRecord, 'spud'>[]): [number, number] | null {
  const years = wells.map(spudYear).filter((y): y is number => y != null);
  return years.length ? [Math.min(...years), Math.max(...years)] : null;
}

export function yearColor(year: number | null, range: [number, number] | null): string {
  if (year == null || !range) return STATUS_OTHER;
  return rampColor(YEAR_RAMP, range[1] === range[0] ? 1 : (year - range[0]) / (range[1] - range[0]));
}

// --- human scale -----------------------------------------------------------------------
/** The reference drawn to scale on the seabed. Height is the architectural height, to the tip of the spire. */
export const LANDMARK = { name: 'Burj Khalifa', height_m: 828 };

/** How many of the landmark, stacked, reach from the seabed to the surface. */
export function landmarkStack(depth_m: number): { name: string; height_m: number; times: number } {
  return { ...LANDMARK, times: depth_m / LANDMARK.height_m };
}

// --- the dive --------------------------------------------------------------------------
export interface Pose {
  pos: Vec3;
  target: Vec3;
}
export interface DiveSetup {
  /** water depth at the hub, m */
  water: number;
  /** deepest well, m below sea level */
  deepest: number;
  /** [east, north] the wells cluster around below the seabed */
  focus: Vec2;
  /** where the dive ends: the free-orbit view, in scene coordinates at true scale */
  overview: Pose;
}

/**
 * Key poses of the dive in scene coordinates at true scale (x east, y up, z south): above the
 * platform, just under the surface, down the water column to the seabed, on into the well
 * section, then out to the overview.
 */
export function diveKeys(s: DiveSetup): { t: number; pose: Pose }[] {
  const W = s.water;
  const rock = Math.max(200, s.deepest - W);
  const [fx, fn] = s.focus;
  const side = Math.max(600, 0.45 * rock);
  return [
    { t: 0, pose: { pos: [520, 150, 520], target: [0, 20, 0] } },
    { t: 0.13, pose: { pos: [460, -70, 560], target: [0, -0.2 * W, 0] } },
    { t: 0.5, pose: { pos: [0.24 * W, -0.9 * W, 0.2 * W], target: [0, -W, 0] } },
    { t: 0.78, pose: { pos: [fx + side, -(W + 0.5 * rock), -fn + 0.6 * side], target: [fx, -(W + 0.72 * rock), -fn] } },
    { t: 1, pose: s.overview },
  ];
}

/** Monotone cubic (Fritsch–Carlson) through (ts[i], vs[i]) at x: smooth, and it never overshoots a key. */
function monotone(ts: number[], vs: number[], x: number): number {
  const n = ts.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((vs[i + 1] - vs[i]) / (ts[i + 1] - ts[i]));
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m.push(0);
    else {
      const h0 = ts[i] - ts[i - 1];
      const h1 = ts[i + 1] - ts[i];
      m.push((3 * (h0 + h1)) / ((2 * h1 + h0) / d[i - 1] + (h1 + 2 * h0) / d[i]));
    }
  }
  m.push(d[n - 2]);
  let i = 0;
  while (i < n - 2 && x > ts[i + 1]) i++;
  const h = ts[i + 1] - ts[i];
  const u = Math.max(0, Math.min(1, (x - ts[i]) / h));
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * vs[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * vs[i + 1] + (u3 - u2) * h * m[i + 1];
}

/** Camera pose at dive progress t (0..1): a smooth curve through the key poses, eased at both ends. */
export function divePose(keys: { t: number; pose: Pose }[], t: number): Pose {
  const c = Math.max(0, Math.min(1, t));
  const e = c * c * (3 - 2 * c);
  const ts = keys.map((k) => k.t);
  const along = (pick: (p: Pose) => Vec3): Vec3 => [0, 1, 2].map((a) => monotone(ts, keys.map((k) => pick(k.pose)[a]), e)) as Vec3;
  return { pos: along((p) => p.pos), target: along((p) => p.target) };
}

/** Where the below-seabed parts of the wells cluster, and how far out three quarters of them reach. */
export function wellFocus(paths: Vec3[][], water: number): { focus: Vec2; reach: number } {
  const pts = paths.flat().filter((p) => p[2] > water);
  if (!pts.length) return { focus: [0, 0], reach: 0 };
  const median = (v: number[]) => v.sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const focus: Vec2 = [median(pts.map((p) => p[0])), median(pts.map((p) => p[1]))];
  const d = pts.map((p) => Math.hypot(p[0] - focus[0], p[1] - focus[1])).sort((a, b) => a - b);
  return { focus, reach: d[Math.floor(d.length * 0.75)] ?? 0 };
}
