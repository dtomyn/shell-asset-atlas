// Run with `npm test`. Geometry helpers of the subsea view (src/subsea-geo.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clipLine,
  clipSegment,
  depthTicks,
  distToSegment,
  diveKeys,
  divePose,
  drape,
  landmarkStack,
  metresPerDegree,
  mixHex,
  niceStep,
  pathLength,
  pickPath,
  rampColor,
  seabedAt,
  splitAtDepth,
  statusColor,
  toLocal,
  toScene,
  triples,
  wellFocus,
  yearColor,
  yearRange,
  type SeabedGrid,
  type Vec2,
  type Vec3,
} from '../src/subsea-geo.ts';

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

// A 3 x 3 seabed over a 2 km square that deepens by 100 m per km to the east and 50 m per km to the north.
const GRID: SeabedGrid = { n: 3, control_points: 9, depth: [900, 1000, 1100, 950, 1050, 1150, 1000, 1100, 1200] };

test('degrees to local metres', () => {
  const [mx, my] = metresPerDegree(26.1289); // Perdido
  near(mx, 99_986, 60);
  near(my, 110_790, 60);
  assert.deepEqual(toLocal(-94.9, 26.13, -94.9, 26.13), [0, 0]);
  const [e, n] = toLocal(-94.89, 26.14, -94.9, 26.13);
  near(e, metresPerDegree(26.13)[0] * 0.01, 1e-6);
  near(n, metresPerDegree(26.13)[1] * 0.01, 1e-6);
});

test('paths: triples, scene frame, length', () => {
  const path = triples([0, 0, 0, 0, 0, 2400, 300, 400, 2400, 9]);
  assert.deepEqual(path, [[0, 0, 0], [0, 0, 2400], [300, 400, 2400]]);
  assert.equal(pathLength(path), 2900);
  // East stays x, depth becomes -y (times the vertical exaggeration), north becomes -z.
  assert.deepEqual(toScene([300, 400, 2400]), [300, -2400, -400]);
  assert.deepEqual(toScene([300, 400, 2400], 3), [300, -7200, -400]);
});

test('a well is cut at the seabed into riser and hole', () => {
  const path: Vec3[] = [[0, 0, 0], [0, 0, 2000], [100, 0, 3000], [500, 0, 3500]];
  const { above, below } = splitAtDepth(path, 2400);
  assert.deepEqual(above, [[0, 0, 0], [0, 0, 2000], [40, 0, 2400]]);
  assert.deepEqual(below, [[40, 0, 2400], [100, 0, 3000], [500, 0, 3500]]);
  near(pathLength(above) + pathLength(below), pathLength(path), 1e-9);
  // A station exactly at the seabed is not duplicated; a path that never gets there has no hole.
  assert.deepEqual(splitAtDepth(path, 2000).above, [[0, 0, 0], [0, 0, 2000]]);
  assert.deepEqual(splitAtDepth(path, 2000).below[0], [0, 0, 2000]);
  assert.deepEqual(splitAtDepth(path, 9000), { above: path, below: [] });
});

test('seabed depth is bilinear on the grid and clamped outside it', () => {
  assert.equal(seabedAt(GRID, 1000, 0, 0), 1050);
  assert.equal(seabedAt(GRID, 1000, -1000, -1000), 900); // south-west corner is the first value
  assert.equal(seabedAt(GRID, 1000, 1000, 1000), 1200);
  near(seabedAt(GRID, 1000, 500, 0), 1100);
  near(seabedAt(GRID, 1000, 250, -500), 1050);
  assert.equal(seabedAt(GRID, 1000, 5000, 5000), 1200);
});

test('lines are clipped to the scene window', () => {
  assert.deepEqual(clipSegment([-2000, 0], [2000, 0], 1000), [[-1000, 0], [1000, 0]]);
  assert.deepEqual(clipSegment([0, 0], [500, 500], 1000), [[0, 0], [500, 500]]);
  assert.equal(clipSegment([1500, -2000], [1500, 2000], 1000), null);
  assert.equal(clipSegment([2000, 0], [0, 2500], 1000), null); // passes the corner outside
  // A pipeline that crosses the window, leaves, and comes back gives two pieces.
  const line: Vec2[] = [[-3000, 0], [0, 0], [0, 3000], [500, 3000], [500, 500]];
  assert.deepEqual(clipLine(line, 1000), [
    [[-1000, 0], [0, 0], [0, 1000]],
    [[500, 1000], [500, 500]],
  ]);
  assert.deepEqual(clipLine([[5000, 5000], [6000, 5000]], 1000), []);
});

test('a pipeline is draped on the seabed', () => {
  const out = drape([[-1000, 0], [1000, 0]], GRID, 1000, 500);
  assert.deepEqual(out.map((p) => p[0]), [-1000, -500, 0, 500, 1000]);
  assert.deepEqual(out.map((p) => p[2]), [950, 1000, 1050, 1100, 1150]);
});

test('ruler marks are round numbers', () => {
  assert.equal(niceStep(2388, 8), 500);
  assert.equal(niceStep(6500, 8), 1000);
  assert.equal(niceStep(900, 8), 200);
  assert.deepEqual(depthTicks(6500), [0, 1000, 2000, 3000, 4000, 5000, 6000]);
  assert.deepEqual(depthTicks(10000, 5), [0, 2000, 4000, 6000, 8000, 10000]);
});

test('hover picks the nearest well within reach', () => {
  near(distToSegment(5, 5, 0, 0, 10, 0), 5);
  near(distToSegment(-3, 4, 0, 0, 10, 0), 5);
  near(distToSegment(3, 4, 0, 0, 0, 0), 5);
  const paths: (Vec2 | null)[][] = [
    [[0, 0], [100, 0]],
    [[0, 20], [100, 20]],
    [[0, 9], null, [100, 9]], // behind the camera in the middle: no segment to hit
  ];
  assert.equal(pickPath(paths, 50, 4, 8), 0);
  assert.equal(pickPath(paths, 50, 14, 8), 1);
  assert.equal(pickPath(paths, 50, 60, 8), -1);
  assert.equal(pickPath(paths, 50, 9, 3), -1);
});

test('colours', () => {
  assert.equal(statusColor('COM'), '#80ed99');
  assert.equal(statusColor('???'), '#c8b6ff');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(rampColor(['#000000', '#ffffff', '#ff0000'], 0.5), '#ffffff');
  const range = yearRange([{ spud: '2002-03-06' }, { spud: null }, { spud: '2025-07-20' }]);
  assert.deepEqual(range, [2002, 2025]);
  assert.equal(yearColor(2002, range), '#5b6ee1');
  assert.equal(yearColor(2025, range), '#ffe08a');
  assert.equal(yearColor(null, range), '#c8b6ff');
  assert.equal(yearRange([{ spud: null }]), null);
});

test('the height comparison is plain arithmetic on the depth', () => {
  const s = landmarkStack(2388);
  assert.equal(s.height_m, 828);
  near(s.times, 2388 / 828);
});

test('the dive starts above the sea, goes down past the seabed and ends at the overview', () => {
  const overview = { pos: [9000, 400, 9000] as Vec3, target: [0, -3000, 0] as Vec3 };
  const keys = diveKeys({ water: 2388, deepest: 6337, focus: [800, -600], overview });
  assert.ok(keys[0].pose.pos[1] > 0, 'starts above sea level');
  assert.deepEqual(divePose(keys, 0), keys[0].pose);
  const end = divePose(keys, 1);
  end.pos.forEach((v, i) => near(v, overview.pos[i], 1e-6));
  end.target.forEach((v, i) => near(v, overview.target[i], 1e-6));
  // Deepest point of the camera is below the seabed but above the deepest well.
  const depths = Array.from({ length: 101 }, (_, i) => -divePose(keys, i / 100).pos[1]);
  const max = Math.max(...depths);
  assert.ok(max > 2388 && max < 6337, `camera bottoms out at ${max}`);
  // It only goes down until then: no bobbing on the way.
  const turn = depths.indexOf(max);
  for (let i = 1; i <= turn; i++) assert.ok(depths[i] >= depths[i - 1] - 1, `rises at step ${i}`);
  // No jumps: each 1% step moves the camera less than 6% of the whole path's span.
  for (let i = 1; i <= 100; i++) {
    const a = divePose(keys, (i - 1) / 100).pos;
    const b = divePose(keys, i / 100).pos;
    assert.ok(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) < 0.06 * 20000);
  }
});

test('the wells focus is where the holes are, not where the risers are', () => {
  const paths: Vec3[][] = [
    [[0, 0, 0], [0, 0, 1000], [2000, 0, 3000], [2200, 0, 3200]],
    [[0, 0, 0], [0, 0, 1000], [1800, 100, 3000], [2000, 0, 3100]],
  ];
  const { focus, reach } = wellFocus(paths, 1000);
  assert.ok(focus[0] >= 1800 && focus[0] <= 2200 && Math.abs(focus[1]) <= 100);
  assert.ok(reach > 0 && reach < 500);
  assert.deepEqual(wellFocus([], 1000), { focus: [0, 0], reach: 0 });
});
