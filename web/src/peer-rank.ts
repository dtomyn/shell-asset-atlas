// Peer benchmark maths with no DOM dependency, so it can be unit-tested with `npm test`:
// who ranks where in a month, Shell's standing, and the headline sentence. Every figure
// comes from peers.json (pipeline/atlas/peers.py). Values are gross (100%) kboe/d by
// operator of record, not equity or net production.

export interface PeerOperator {
  id: string;
  name: string;
  /** 'shell' for Shell, 'jv' for a joint venture Shell co-owns (shown on its own) */
  focus?: 'shell' | 'jv';
  /** the regulator's entities summed into this operator */
  entities: string[];
  /** timeline index of v[0] */
  start: number;
  v: number[];
}

export interface PeerBasin {
  id: string;
  label: string;
  /** for sentences: "in the US Gulf", "on the UK continental shelf" */
  place: string;
  source: string;
  /** last month the regulator has published */
  through: string;
  stale?: boolean;
  depth_coverage?: number;
  /** all operators, including those not listed; null where the regulator has no data */
  total: (number | null)[];
  /** operators producing in the month */
  n: (number | null)[];
  operators: PeerOperator[];
}

export interface PeerData {
  months: string[];
  unit: string;
  /** the pipeline keeps the top `top` operators of every month, so ranks down to it are exact */
  top: number;
  deepwater_ft: number;
  basins: PeerBasin[];
}

export interface Ranked {
  op: PeerOperator;
  rank: number;
  value: number;
  /** percent of the basin total */
  share: number;
}

export function valueAt(op: PeerOperator, month: number): number {
  const k = month - op.start;
  return k >= 0 && k < op.v.length ? op.v[k] : 0;
}

/** Producing operators in a month, largest first. Ties go by id, as in the pipeline. */
export function rankAt(basin: PeerBasin, month: number): Ranked[] {
  const total = basin.total[month] ?? 0;
  return basin.operators
    .map((op) => ({ op, value: valueAt(op, month) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || (a.op.id < b.op.id ? -1 : 1))
    .map((r, i) => ({ ...r, rank: i + 1, share: total > 0 ? (r.value / total) * 100 : 0 }));
}

/** Production of everyone not listed: the basin total less the listed operators. */
export function othersAt(basin: PeerBasin, month: number, ranked = rankAt(basin, month)): number {
  return Math.max(0, (basin.total[month] ?? 0) - ranked.reduce((a, r) => a + r.value, 0));
}

export interface Standing extends Ranked {
  /** operators producing in the basin that month */
  of: number;
  total: number;
  leader: Ranked;
  /** the operator one place behind */
  next: Ranked | null;
}

/** Where an operator stands in a month, or null if it produced nothing there. */
export function standing(basin: PeerBasin, month: number, focus: 'shell' | 'jv' = 'shell'): Standing | null {
  const ranked = rankAt(basin, month);
  const me = ranked.find((r) => r.op.focus === focus);
  if (!me) return null;
  return { ...me, of: Math.max(basin.n[month] ?? 0, ranked.length), total: basin.total[month] ?? 0, leader: ranked[0], next: ranked[me.rank] ?? null };
}

/** One operator over time, as kboe/d or as a percent of the basin; null outside the data. */
export function seriesOf(basin: PeerBasin, op: PeerOperator, months: number, metric: 'share' | 'kboed'): (number | null)[] {
  return Array.from({ length: months }, (_, i) => {
    const total = basin.total[i];
    if (total == null) return null;
    const v = valueAt(op, i);
    return metric === 'kboed' ? v : total > 0 ? (v / total) * 100 : null;
  });
}

const pct = (v: number) => `${v.toFixed(1)}%`;

/** "Shell ranks #1 of 30 operators in the US Gulf, 28.4% of operated production (Dec 2025)" */
export function headline(basin: PeerBasin, month: number, monthLabel: string): string {
  const s = standing(basin, month);
  if (basin.total[month] == null) return `No ${basin.label} data for ${monthLabel}`;
  if (!s) return `Shell operated no production ${basin.place} in ${monthLabel}`;
  return `Shell ranks #${s.rank} of ${s.of} operators ${basin.place}, ${pct(s.share)} of operated production (${monthLabel})`;
}

/** The joint venture's own line, where the basin has one producing that month. */
export function jvLine(basin: PeerBasin, month: number): string | null {
  const s = standing(basin, month, 'jv');
  return s ? `${s.op.name} is counted separately: #${s.rank}, ${pct(s.share)}.` : null;
}
