// Run with `npm test` (Node's built-in runner; Node 22.18+ strips the types itself).
// There is rarely a live Atlantic storm to test against, so the forecast here is a replay:
// Hurricane Ida's HURDAT2 best track from 28 Aug 2021 12Z, used as if it were the forecast
// track issued that morning, with hub positions taken from the BOEM platform file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distanceToLineKm, pointInRing, productionInPath, stormClass, trackAt, STORM_CLASSES, type Hub, type LngLat, type TrackPoint } from '../src/storm-risk.ts';

const IDA: TrackPoint[] = [
  [27169200, 24.4, -85.7, 70, 'HU'],
  [27169560, 25.6, -86.6, 80, 'HU'],
  [27169920, 26.7, -87.6, 90, 'HU'],
  [27170280, 27.6, -88.7, 115, 'HU'],
  [27170640, 28.5, -89.6, 130, 'HU'],
  [27170935, 29.1, -90.2, 130, 'HU'],
  [27171360, 29.9, -90.6, 105, 'HU'],
];
const FORECAST: LngLat[] = IDA.map((p) => [p[2], p[1]]);

// kboe/d values are round test numbers, not production data.
const HUBS: Hub[] = [
  { id: 'gom:MC807', name: 'Mars / Olympus (MC807)', sites: [[-89.22288, 28.16952], [-89.23913, 28.15989]], kboed: 200 },
  { id: 'gom:MC392', name: 'Appomattox (MC392)', sites: [[-87.93421, 28.5735]], kboed: 80 },
  { id: 'gom:WR508', name: 'Turritella (WR508)', sites: [[-90.83349, 26.42775]], kboed: 40 },
  { id: 'gom:AC857', name: 'Perdido (AC857)', sites: [[-94.89791, 26.1289]], kboed: 90 },
];

test('Saffir-Simpson classes from wind in knots', () => {
  const short = (kt: number, status?: string) => STORM_CLASSES[stormClass(kt, status)].short;
  assert.deepEqual([20, 33, 34, 63, 64, 82, 83, 95, 96, 112, 113, 136, 137].map((kt) => short(kt)), ['TD', 'TD', 'TS', 'TS', 'Cat 1', 'Cat 1', 'Cat 2', 'Cat 2', 'Cat 3', 'Cat 3', 'Cat 4', 'Cat 4', 'Cat 5']);
  assert.equal(short(60, 'EX'), 'Low');
  assert.equal(short(130, 'HU'), 'Cat 4');
});

test('position along a track is interpolated and clamped', () => {
  const mid = trackAt(IDA, (IDA[3][0] + IDA[4][0]) / 2);
  assert.ok(Math.abs(mid.lat - 28.05) < 1e-9 && Math.abs(mid.lng + 89.15) < 1e-9);
  assert.equal(mid.kt, 123);
  assert.deepEqual(trackAt(IDA, 0), { lng: -85.7, lat: 24.4, kt: 70, status: 'HU', t: IDA[0][0] });
  assert.equal(trackAt(IDA, 9e9).lat, 29.9);
});

test('distance is measured to the track segments, not just its points', () => {
  const mars = HUBS[0].sites[0];
  const toLine = distanceToLineKm(mars, FORECAST);
  const toPoints = Math.min(...FORECAST.map((p) => distanceToLineKm(mars, [p])));
  assert.ok(toLine < 10, `Ida's centre passed within 10 km of Mars, got ${toLine}`);
  assert.ok(toPoints > 40);
  // one degree of latitude is about 111 km
  assert.ok(Math.abs(distanceToLineKm([-90, 27], [[-90, 28]]) - 111.2) < 0.1);
});

test('point in ring', () => {
  const ring: LngLat[] = [[-91, 27], [-88, 27], [-88, 30], [-91, 30], [-91, 27]];
  assert.equal(pointInRing([-89.2, 28.2], ring), true);
  assert.equal(pointInRing([-94.9, 26.1], ring), false);
  assert.equal(pointInRing([-89.2, 30.5], ring), false);
});

test('production in the path: within N km of the forecast track', () => {
  const near = productionInPath(HUBS, { track: FORECAST }, 150);
  assert.deepEqual(near.hubs.map((h) => h.id), ['gom:MC807', 'gom:MC392']);
  assert.equal(near.kboed, 280); // Mars/Olympus counted once although both installations are in the path
  const wide = productionInPath(HUBS, { track: FORECAST }, 260);
  assert.deepEqual(wide.hubs.map((h) => h.id), ['gom:MC807', 'gom:MC392', 'gom:WR508']);
  assert.equal(productionInPath(HUBS, { track: FORECAST }, 5).kboed, 200);
});

test('production in the path: the cone adds hubs the track buffer misses', () => {
  // a cone widening toward the coast, as NHC draws it; it covers Turritella but not Perdido
  const cone: LngLat[] = [[-85.9, 24.2], [-85.4, 24.6], [-87.5, 30.5], [-92.5, 30.5], [-91.5, 26.0], [-85.9, 24.2]];
  const risk = productionInPath(HUBS, { cone, track: FORECAST }, 150);
  assert.deepEqual(risk.hubs.map((h) => h.id), ['gom:MC807', 'gom:MC392', 'gom:WR508']);
  assert.equal(risk.kboed, 320);
  assert.equal(productionInPath(HUBS, { cone }, 150).kboed, 320); // the cone alone covers the same three
});

test('production in the path: no track, no cone, or nothing nearby', () => {
  assert.deepEqual(productionInPath(HUBS, {}, 150), { kboed: 0, hubs: [] });
  assert.deepEqual(productionInPath(HUBS, { cone: null, track: null, lon: null, lat: null }, 150), { kboed: 0, hubs: [] });
  // a system with only a current position (Atlantic, far from the Gulf)
  assert.equal(productionInPath(HUBS, { lon: -45, lat: 15 }, 150).kboed, 0);
  assert.equal(productionInPath(HUBS, { lon: -89.3, lat: 28.1 }, 150).hubs[0].id, 'gom:MC807');
  assert.equal(productionInPath([], { track: FORECAST }, 150).kboed, 0);
});
