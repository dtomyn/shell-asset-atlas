// Run with `npm test` (Node's built-in runner; Node 22.18+ strips the types itself).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { headline, jvLine, othersAt, rankAt, seriesOf, standing, valueAt, type PeerBasin, type PeerData } from '../src/peer-rank.ts';

// kboe/d values are round test numbers, not production data.
const BASIN: PeerBasin = {
  id: 'uk',
  label: 'UK',
  place: 'on the UK continental shelf',
  source: 'test',
  through: '2024-03',
  total: [200, 100, 100, null],
  n: [5, 4, 3, null],
  operators: [
    { id: 'big', name: 'Big Oil', entities: ['BIG OIL PLC'], start: 0, v: [90, 40, 50] },
    { id: 'shell', name: 'Shell', focus: 'shell', entities: ['SHELL PLC'], start: 0, v: [60, 40, 0] },
    { id: 'adura', name: 'Adura (Shell/Equinor JV)', focus: 'jv', entities: ['ADURA ENERGY'], start: 2, v: [45] },
    { id: 'late', name: 'Late Starter', entities: ['LATE STARTER LIMITED'], start: 1, v: [15] },
  ],
};

test('values outside an operator’s months are zero', () => {
  const late = BASIN.operators[3];
  assert.deepEqual([0, 1, 2, 3].map((i) => valueAt(late, i)), [0, 15, 0, 0]);
});

test('ranks by value, breaks ties by id, and leaves out non-producers', () => {
  assert.deepEqual(rankAt(BASIN, 0).map((r) => [r.op.id, r.rank, r.share]), [['big', 1, 45], ['shell', 2, 30]]);
  // month 1: Big Oil and Shell tie at 40; 'big' sorts before 'shell'
  assert.deepEqual(rankAt(BASIN, 1).map((r) => r.op.id), ['big', 'shell', 'late']);
  assert.deepEqual(rankAt(BASIN, 2).map((r) => r.op.id), ['big', 'adura']);
  assert.deepEqual(rankAt(BASIN, 3), []);
});

test('others is the basin total less the listed operators', () => {
  assert.equal(othersAt(BASIN, 0), 50);
  assert.equal(othersAt(BASIN, 1), 5);
  assert.equal(othersAt(BASIN, 0, rankAt(BASIN, 0).slice(0, 1)), 110);
});

test('the headline states the true rank, not a flattering one', () => {
  assert.equal(headline(BASIN, 0, 'Jan 2024'), 'Shell ranks #2 of 5 operators on the UK continental shelf, 30.0% of operated production (Jan 2024)');
  const s = standing(BASIN, 0)!;
  assert.equal(s.leader.op.id, 'big');
  assert.equal(s.next, null);
  assert.equal(standing(BASIN, 1)!.next!.op.id, 'late');
  // Shell produces nothing in month 2: no rank is claimed, and the joint venture is not counted as Shell
  assert.equal(standing(BASIN, 2), null);
  assert.equal(headline(BASIN, 2, 'Mar 2024'), 'Shell operated no production on the UK continental shelf in Mar 2024');
  assert.equal(jvLine(BASIN, 2), 'Adura (Shell/Equinor JV) is counted separately: #2, 45.0%.');
  assert.equal(jvLine(BASIN, 0), null);
  assert.equal(headline(BASIN, 3, 'Apr 2024'), 'No UK data for Apr 2024');
});

test('series over time as share or kboe/d', () => {
  const shell = BASIN.operators[1];
  assert.deepEqual(seriesOf(BASIN, shell, 4, 'share'), [30, 40, 0, null]);
  assert.deepEqual(seriesOf(BASIN, shell, 4, 'kboed'), [60, 40, 0, null]);
});

// The committed bundle: Shell's Gulf figure in the benchmark is the same number the timeline shows.
test('peers.json agrees with production.json on Shell in the Gulf', { skip: !existsSync(new URL('../public/data/peers.json', import.meta.url)) }, () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
  const peers: PeerData = read('peers.json');
  const prod = read('production.json');
  assert.deepEqual(peers.months, prod.months);
  const end = prod.months.indexOf((Object.values(prod.latest) as string[]).sort()[0]);
  const gulf = peers.basins.find((b) => b.id === 'gom')!;
  const s = standing(gulf, end)!;
  assert.ok(Math.abs(s.value - prod.totals['gom:operated'].gross[end]) <= 0.2, `${s.value} vs ${prod.totals['gom:operated'].gross[end]}`);
  assert.ok(s.rank >= 1 && s.rank <= s.of && s.share > 0 && s.share <= 100);
  for (const b of peers.basins) {
    for (let i = 0; i <= end; i++) {
      const ranked = rankAt(b, i);
      assert.ok(ranked.reduce((a, r) => a + r.value, 0) <= (b.total[i] ?? 0) + 0.1 * ranked.length + 0.1, `${b.id} month ${i}: listed operators exceed the total`);
      assert.ok(ranked.length <= (b.n[i] ?? 0), `${b.id} month ${i}: more ranked than producing`);
    }
  }
});
