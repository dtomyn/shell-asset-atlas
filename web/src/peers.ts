// Peer benchmark panel: Shell against every other operator the regulators publish, per
// basin, following the timeline. A re-ranking bar list for the current month, a line chart
// of each operator's share (or kboe/d) over time, and a headline sentence. Everything shown
// is computed from peers.json (pipeline/atlas/peers.py); nothing here is hard-coded.
import { AreaChart, fmtMonth, fmtNum } from './chart';
import { escapeHtml } from './map';
import { headline, jvLine, othersAt, rankAt, seriesOf, type PeerBasin, type PeerData, type PeerOperator, type Ranked } from './peer-rank';
import { BarRace, type BarRow } from './race';

export type PeerMetric = 'share' | 'kboed';

/** The benchmark is optional: a missing or broken file must never stop the app. */
export async function loadPeers(): Promise<PeerData | null> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}data/peers.json`);
    if (!r.ok) return null;
    const d = (await r.json()) as PeerData;
    return Array.isArray(d?.months) && Array.isArray(d?.basins) && d.basins.length ? d : null;
  } catch {
    return null;
  }
}

// Shell and the joint venture carry the app's stake colours; every peer is a neutral grey.
const COLOR = { shell: '#ffb703', jv: '#ff8c42', peer: '#9aa7b8', picked: '#e9eef5', others: '#5b6778' };
const colorOf = (op: PeerOperator) => (op.focus ? COLOR[op.focus] : COLOR.peer);

export interface BenchHooks {
  /** last month of the timeline */
  endIdx: number;
  setMonth(idx: number): void;
  stopPlay(): void;
  /** the panel was opened, closed or switched: update the URL hash and the button */
  onChange(): void;
}

export class Benchmark {
  private el: HTMLElement;
  private data: PeerData;
  private hooks: BenchHooks;
  private basinId: string;
  private metricId: PeerMetric = 'share';
  private month: number;
  private picked: string | null = null;
  private bars: BarRace;
  private chart: AreaChart | null = null;
  private q = <T extends HTMLElement = HTMLElement>(sel: string) => this.el.querySelector(sel) as T;

  constructor(el: HTMLElement, data: PeerData, hooks: BenchHooks) {
    this.el = el;
    this.data = data;
    this.hooks = hooks;
    this.basinId = data.basins[0].id;
    this.month = hooks.endIdx;
    el.innerHTML = `
      <button class="icon-btn close" data-close aria-label="Close benchmark"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <p class="kicker">Peer benchmark · unofficial</p>
      <h2 class="bench-headline"></h2>
      <p class="bench-sub"></p>
      <div class="seg bench-basins" role="group" aria-label="Basin">${data.basins.map((b) => `<button data-basin="${escapeHtml(b.id)}">${escapeHtml(b.label)}</button>`).join('')}</div>
      <h3>Operators ranked <small class="bench-month"></small></h3>
      <div class="race-rows bench-rows"></div>
      <h3>Over time
        <span class="seg bench-metric" role="group" aria-label="Chart shows"><button data-metric="share">Share</button><button data-metric="kboed">kboe/d</button></span>
      </h3>
      <div class="bench-chart"></div>
      <div class="bench-legend"></div>
      <p class="bench-note"></p>`;
    this.bars = new BarRace(this.q('.bench-rows'), data.top + 2, true);
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const basin = t.closest<HTMLElement>('[data-basin]');
      const metric = t.closest<HTMLElement>('[data-metric]');
      const row = t.closest<HTMLElement>('[data-op]');
      if (t.closest('[data-close]')) this.close();
      else if (basin) this.setBasin(basin.dataset.basin!);
      else if (metric) this.setMetric(metric.dataset.metric as PeerMetric);
      else if (row) this.pick(row.dataset.op!);
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }
  get basin() {
    return this.basinId;
  }
  get metric() {
    return this.metricId;
  }
  has(basin: string) {
    return this.data.basins.some((b) => b.id === basin);
  }

  open(basin?: string, metric?: PeerMetric) {
    if (basin && this.has(basin)) this.basinId = basin;
    if (metric) this.metricId = metric;
    this.el.hidden = false;
    document.body.classList.add('bench-open');
    this.renderBasin();
    this.hooks.onChange();
  }

  close() {
    if (!this.isOpen) return;
    this.el.hidden = true;
    document.body.classList.remove('bench-open');
    this.hooks.onChange();
  }

  setBasin(id: string) {
    if (!this.has(id) || id === this.basinId) return;
    this.basinId = id;
    this.picked = null;
    this.renderBasin();
    this.hooks.onChange();
  }

  setMetric(metric: PeerMetric) {
    if (metric === this.metricId) return;
    this.metricId = metric;
    this.renderChart();
    this.hooks.onChange();
  }

  setMonth(idx: number) {
    this.month = idx;
    if (!this.isOpen) return;
    this.renderMonth();
    this.chart?.setCursor(idx);
  }

  /** Click a bar to bring that operator's line forward in the chart; click again to let go. */
  private pick(id: string) {
    this.picked = this.picked === id ? null : id;
    this.renderMonth();
    this.renderChart();
  }

  private current(): PeerBasin {
    return this.data.basins.find((b) => b.id === this.basinId) ?? this.data.basins[0];
  }

  private renderBasin() {
    const b = this.current();
    this.el.querySelectorAll<HTMLElement>('[data-basin]').forEach((x) => x.classList.toggle('on', x.dataset.basin === b.id));
    this.bars.clear();
    const deep = b.id === 'gom_deep' ? ` Deepwater here means leases wholly in ${fmtNum(this.data.deepwater_ft)} ft (${fmtNum(this.data.deepwater_ft * 0.3048)} m) of water or more.` : '';
    const lag = b.through < this.data.months[this.hooks.endIdx] ? ` This regulator has published to ${fmtMonth(b.through)}.` : '';
    this.q('.bench-note').innerHTML =
      `Gross (100%) production by <b>operator of record</b>, in kboe/d. It is not equity or net production: an operator is credited with the whole field or lease, whatever its working interest.${escapeHtml(deep + lag)} ` +
      `Source: ${escapeHtml(b.source)}${b.stale ? ' (last good snapshot)' : ''}. Company names are the regulator's, grouped only where the method notes say so. Click a bar to trace that operator.`;
    this.renderMonth();
    this.renderChart();
  }

  private renderMonth() {
    const b = this.current();
    const label = fmtMonth(this.data.months[this.month]);
    this.q('.bench-headline').textContent = headline(b, this.month, label);
    const jv = jvLine(b, this.month);
    this.q('.bench-sub').textContent = jv ?? '';
    this.q('.bench-sub').hidden = !jv;
    this.q('.bench-month').textContent = `${label} · kboe/d · share`;

    const ranked = rankAt(b, this.month);
    // the top N, then Shell and the joint venture wherever they stand
    const shown = ranked.filter((r) => r.rank <= this.data.top || r.op.focus);
    const row = (r: Ranked): BarRow => ({
      id: r.op.id,
      name: r.op.name,
      color: colorOf(r.op),
      cls: `bench-row${r.op.focus ? ` focus-${r.op.focus}` : ''}`,
      title: `${r.op.entities.join(' + ')}. Click to trace in the chart.`,
      data: { op: r.op.id },
      value: r.value,
      rank: String(r.rank),
      text: `${fmtNum(r.value, r.value < 10 ? 1 : 0)} · ${fmtNum(r.share, 1)}%`,
    });
    const rows = shown.map(row);
    const others = othersAt(b, this.month, shown);
    const total = b.total[this.month] ?? 0;
    const rest = (b.n[this.month] ?? shown.length) - shown.length;
    if (others >= 0.05 && total > 0) {
      rows.push({
        id: '·others',
        name: rest > 0 ? `${rest} other operator${rest === 1 ? '' : 's'}` : 'Other production',
        color: COLOR.others,
        cls: 'bench-row others',
        title: 'Everyone not listed above, together',
        value: others,
        rank: '',
        text: `${fmtNum(others, others < 10 ? 1 : 0)} · ${fmtNum((others / total) * 100, 1)}%`,
      });
    }
    this.bars.render(rows, ranked[0]?.value);
    this.el.querySelectorAll<HTMLElement>('[data-op]').forEach((x) => x.classList.toggle('picked', x.dataset.op === this.picked));
  }

  private renderChart() {
    const b = this.current();
    const n = this.hooks.endIdx + 1;
    this.el.querySelectorAll<HTMLElement>('[data-metric]').forEach((x) => x.classList.toggle('on', x.dataset.metric === this.metricId));
    const line = (op: PeerOperator) => ({ label: op.name, color: colorOf(op), values: seriesOf(b, op, n, this.metricId) });
    const peers = b.operators.filter((op) => !op.focus && op.id !== this.picked);
    const picked = b.operators.find((op) => op.id === this.picked && !op.focus);
    const lines = [
      ...peers.map((op) => ({ ...line(op), width: 1, opacity: 0.38 })),
      ...(picked ? [{ ...line(picked), color: COLOR.picked, width: 1.8, pin: true }] : []),
      ...b.operators.filter((op) => op.focus === 'jv').map((op) => ({ ...line(op), width: 2, pin: true })),
      ...b.operators.filter((op) => op.focus === 'shell').map((op) => ({ ...line(op), width: 2.6, pin: true })),
    ];
    const opts = { months: this.data.months.slice(0, n), stacks: [], lines, unit: this.metricId === 'share' ? '% of basin production' : 'kboe/d', cursor: this.month, tipTop: 5 };
    if (this.chart) this.chart.update(opts);
    else {
      this.chart = new AreaChart(this.q('.bench-chart'), {
        ...opts,
        onScrub: (i) => {
          this.hooks.stopPlay();
          this.hooks.setMonth(i);
        },
      });
    }
    const swatch = (color: string, label: string) => `<span><i style="background:${color}"></i>${escapeHtml(label)}</span>`;
    this.q('.bench-legend').innerHTML =
      b.operators.filter((op) => op.focus === 'shell').map((op) => swatch(COLOR.shell, op.name)).join('') +
      b.operators.filter((op) => op.focus === 'jv').map((op) => swatch(COLOR.jv, op.name)).join('') +
      (picked ? swatch(COLOR.picked, picked.name) : '') +
      swatch(COLOR.peer, `${peers.length} other operators`);
  }
}
