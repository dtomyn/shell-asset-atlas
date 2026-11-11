// Dependency-free responsive SVG area chart with hover read-out and a scrubbable cursor.
export interface Stack {
  label: string;
  color: string;
  values: (number | null)[]; // aligned to `months`
}

export interface ChartOptions {
  months: string[];
  stacks: Stack[];
  lines?: (Stack & { dash?: string })[];
  cursor?: number;
  unit: string;
  height?: number;
  compact?: boolean;
  onScrub?: (idx: number) => void;
}

const NS = 'http://www.w3.org/2000/svg';

export function fmtMonth(m: string, long = false): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-GB', { month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtNum(v: number, digits = 0): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export class AreaChart {
  private el: HTMLElement;
  private opts: ChartOptions;
  private svg: SVGSVGElement;
  private ro: ResizeObserver;
  private tip: HTMLDivElement;
  private dragging = false;

  constructor(el: HTMLElement, opts: ChartOptions) {
    this.el = el;
    this.opts = opts;
    el.classList.add('chart');
    this.svg = document.createElementNS(NS, 'svg');
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    el.replaceChildren(this.svg, this.tip);
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(el);
    this.bind();
  }

  update(partial: Partial<ChartOptions>) {
    Object.assign(this.opts, partial);
    this.render();
  }

  setCursor(idx: number) {
    this.opts.cursor = idx;
    const c = this.svg.querySelector<SVGGElement>('.cursor');
    if (c) c.setAttribute('transform', `translate(${this.x(idx)},0)`);
  }

  destroy() {
    this.ro.disconnect();
  }

  private w = 0;
  private h = 0;
  private pad = { l: 34, r: 8, t: 8, b: 18 };
  private x = (i: number) => this.pad.l + (i / Math.max(1, this.opts.months.length - 1)) * (this.w - this.pad.l - this.pad.r);
  private yMax = 1;
  private y = (v: number) => this.h - this.pad.b - (v / this.yMax) * (this.h - this.pad.t - this.pad.b);

  private idxAt(clientX: number) {
    const r = this.svg.getBoundingClientRect();
    const t = (clientX - r.left - this.pad.l) / (r.width - this.pad.l - this.pad.r);
    return Math.max(0, Math.min(this.opts.months.length - 1, Math.round(t * (this.opts.months.length - 1))));
  }

  private bind() {
    const move = (e: PointerEvent) => {
      const i = this.idxAt(e.clientX);
      this.showTip(i, e.clientX);
      if (this.dragging) this.opts.onScrub?.(i);
    };
    this.svg.addEventListener('pointermove', move);
    this.svg.addEventListener('pointerdown', (e) => {
      if (!this.opts.onScrub) return;
      this.dragging = true;
      this.svg.setPointerCapture(e.pointerId);
      this.opts.onScrub(this.idxAt(e.clientX));
    });
    const end = () => (this.dragging = false);
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
    this.svg.addEventListener('pointerleave', () => (this.tip.hidden = true));
  }

  private showTip(i: number, clientX: number) {
    const { months, stacks, lines = [], unit } = this.opts;
    if (!months.length) return;
    const rows = [...stacks, ...lines]
      .map((s) => ({ s, v: s.values[i] }))
      .filter((r) => r.v != null)
      .map((r) => `<div><i style="background:${r.s.color}"></i>${r.s.label}<b>${fmtNum(r.v as number, (r.v as number) < 10 ? 1 : 0)}</b></div>`)
      .join('');
    const total = stacks.reduce((a, s) => a + (s.values[i] ?? 0), 0);
    this.tip.innerHTML = `<div class="tip-h">${fmtMonth(months[i])}${stacks.length > 1 ? ` · <b>${fmtNum(total, 0)}</b> ${unit}` : ` · ${unit}`}</div>${rows}`;
    this.tip.hidden = false;
    const r = this.el.getBoundingClientRect();
    const left = Math.min(Math.max(clientX - r.left + 12, 0), r.width - this.tip.offsetWidth - 4);
    this.tip.style.left = `${left}px`;
  }

  render() {
    const { months, stacks, lines = [], cursor } = this.opts;
    this.w = this.el.clientWidth;
    this.h = this.opts.height ?? this.el.clientHeight ?? 120;
    if (this.opts.compact) this.pad = { l: 34, r: 6, t: 6, b: 16 };
    const svg = this.svg;
    svg.setAttribute('viewBox', `0 0 ${this.w} ${this.h}`);
    svg.setAttribute('width', String(this.w));
    svg.setAttribute('height', String(this.h));
    svg.replaceChildren();
    if (!months.length || this.w < 40) return;

    const n = months.length;
    const cum: number[][] = [];
    const base = new Array(n).fill(0);
    for (const s of stacks) {
      const top = base.map((b, i) => b + (s.values[i] ?? 0));
      cum.push(top);
      for (let i = 0; i < n; i++) base[i] = top[i];
    }
    const maxStack = Math.max(0, ...base);
    const maxLine = Math.max(0, ...lines.flatMap((l) => l.values.filter((v): v is number => v != null)));
    this.yMax = niceMax(Math.max(maxStack, maxLine, 1));

    // grid + y labels
    const g = el('g', { class: 'grid' });
    for (const f of [0, 0.5, 1]) {
      const v = this.yMax * f;
      const yy = this.y(v);
      g.append(el('line', { x1: this.pad.l, x2: this.w - this.pad.r, y1: yy, y2: yy }));
      const t = el('text', { x: this.pad.l - 6, y: yy + 3, 'text-anchor': 'end' });
      t.textContent = fmtNum(v, v < 10 && v > 0 ? 1 : 0);
      g.append(t);
    }
    // x labels (years)
    let lastYear = '';
    const step = Math.ceil(n / Math.max(2, Math.floor(this.w / 70)));
    months.forEach((m, i) => {
      const yr = m.slice(0, 4);
      if (m.endsWith('-01') && yr !== lastYear && (i % step < 12 || n < 40)) {
        lastYear = yr;
        const t = el('text', { x: this.x(i), y: this.h - 4, 'text-anchor': 'middle' });
        t.textContent = yr;
        g.append(t);
      }
    });
    svg.append(g);

    // stacked areas
    const defs = el('defs', {});
    svg.append(defs);
    stacks.forEach((s, k) => {
      const gid = `g${Math.random().toString(36).slice(2, 8)}`;
      const grad = el('linearGradient', { id: gid, x1: 0, x2: 0, y1: 0, y2: 1 });
      grad.append(el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.85 }));
      grad.append(el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0.25 }));
      defs.append(grad);
      const top = cum[k];
      const bottom = k ? cum[k - 1] : new Array(n).fill(0);
      let d = `M${this.x(0)},${this.y(top[0])}`;
      for (let i = 1; i < n; i++) d += `L${this.x(i)},${this.y(top[i])}`;
      for (let i = n - 1; i >= 0; i--) d += `L${this.x(i)},${this.y(bottom[i])}`;
      svg.append(el('path', { d: d + 'Z', fill: `url(#${gid})` }));
      let line = `M${this.x(0)},${this.y(top[0])}`;
      for (let i = 1; i < n; i++) line += `L${this.x(i)},${this.y(top[i])}`;
      svg.append(el('path', { d: line, fill: 'none', stroke: s.color, 'stroke-width': 1.2 }));
    });
    for (const l of lines) {
      let d = '';
      l.values.forEach((v, i) => {
        if (v == null) return;
        d += `${d ? 'L' : 'M'}${this.x(i)},${this.y(v)}`;
      });
      svg.append(el('path', { d, fill: 'none', stroke: l.color, 'stroke-width': 1.6, 'stroke-dasharray': l.dash ?? '' }));
    }

    // cursor
    const c = el('g', { class: 'cursor', transform: `translate(${this.x(cursor ?? n - 1)},0)` });
    c.append(el('line', { x1: 0, x2: 0, y1: this.pad.t - 4, y2: this.h - this.pad.b }));
    c.append(el('circle', { cx: 0, cy: this.pad.t - 4, r: 3 }));
    svg.append(c);
  }
}

function niceMax(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
