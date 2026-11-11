// Right-hand details drawer for an asset, field or pipeline.
import { AreaChart, fmtMonth, fmtNum } from './chart';
import { GAS_PER_BOE, KIND_LABEL, SEGMENTS, STAKE_LABEL, lastReported, segmentOf, type AssetProps, type Atlas, type SeriesData } from './data';
import { escapeHtml, safeUrl } from './map';

const SOURCE_LABEL: Record<string, string> = {
  boem: 'BOEM / BSEE Data Center',
  nsta: 'North Sea Transition Authority',
  sodir: 'Norwegian Offshore Directorate',
  curated: 'Curated (approximate location)',
  osm: 'OpenStreetMap',
};

export class Drawer {
  private root = document.getElementById('drawer')!;
  private body = document.getElementById('drawer-body')!;
  private chart: AreaChart | null = null;
  current: string | null = null;

  constructor(
    private atlas: Atlas,
    private onClose: () => void,
    private onSelect: (id: string) => void,
    private onScrub: (idx: number) => void,
    private onDive?: (id: string) => void,
  ) {
    document.getElementById('drawer-close')!.addEventListener('click', () => this.close());
  }

  close() {
    this.root.hidden = true;
    this.current = null;
    this.chart?.destroy();
    this.chart = null;
    this.onClose();
  }

  setCursor(idx: number) {
    this.chart?.setCursor(idx);
  }
  showPipeline(p: Record<string, unknown>) {
    this.current = String(p.id);
    this.chart?.destroy();
    this.chart = null;
    const product = String(p.product ?? 'Pipeline');
    this.body.innerHTML = `
      <p class="kicker"><span class="dot" style="background:${/gas/i.test(product) ? '#4cc9f0' : /oil|blko/i.test(product) ? '#ffb703' : '#9aa7b8'}"></span>Pipeline · ${escapeHtml(STAKE_LABEL[p.stake as keyof typeof STAKE_LABEL] ?? '')}</p>
      <h2>${escapeHtml(String(p.name ?? p.route ?? 'Pipeline'))}</h2>
      <dl class="facts">
        ${fact('Route', p.route)}${fact('Product', product)}${fact('Length', `${fmtNum(Number(p.length_km), 1)} km`)}
        ${fact('Diameter', p.size_in ? `${p.size_in}″` : null)}${fact('Status', p.status)}
      </dl>
      <p class="source">Source: ${escapeHtml(SOURCE_LABEL[String(p.source)] ?? String(p.source))}</p>`;
    this.root.hidden = false;
  }

  show(p: AssetProps, monthIdx: number) {
    this.current = p.id;
    const seg = SEGMENTS[segmentOf(p.kind)];
    const s: SeriesData | undefined = p.series ? this.atlas.production.series[p.series] : undefined;
    const months = this.atlas.production.months;
    const kind = p.subtype ?? KIND_LABEL[p.kind] ?? p.kind;

    let prodHtml = '';
    if (s) {
      const li = lastReported(s);
      const i = li - s.start;
      const boe = s.oil[i] + s.gas[i] / GAS_PER_BOE;
      const net = s.share != null ? boe * s.share : null;
      prodHtml = `
        <div class="stat-row">
          <div class="stat"><span>${fmtNum(boe, boe < 10 ? 1 : 0)}</span><small>kboe/d gross · ${fmtMonth(months[li])}</small></div>
          ${net != null ? `<div class="stat"><span>${fmtNum(net, net < 10 ? 1 : 0)}</span><small>kboe/d Shell net (${fmtNum(s.share! * 100, 1)}%)</small></div>` : ''}
          <div class="stat"><span>${fmtNum(s.oil[i], 1)}</span><small>kbbl/d liquids</small></div>
          <div class="stat"><span>${fmtNum(s.gas[i], 0)}</span><small>MMscf/d gas</small></div>
        </div>
        <h3>Monthly production <small>${escapeHtml(s.name)}</small></h3>
        <div class="drawer-chart" id="drawer-chart"></div>`;
    }

    const facts = [
      fact('Operator', p.operator),
      fact('Status', p.status),
      fact('Water depth', p.water_depth_m ? `${fmtNum(p.water_depth_m)} m` : null),
      fact('Installed', p.installed),
      fact('Discovered', p.discovered),
      fact('First production', p.first_production),
      fact('Hydrocarbon', p.hydrocarbon),
      fact('Location', p.block),
      fact('Field', p.field),
      fact('Export system', p.system),
      fact('Shell equity', p.shell_equity ? `${fmtNum(p.shell_equity, 2)}%` : null),
      fact('Adura equity', p.adura_equity ? `${fmtNum(p.adura_equity, 2)}% (50% Shell)` : null),
    ].join('');

    const lic = p.licensees?.length
      ? `<h3>Licensees</h3><ul class="bars">${p.licensees
          .filter((l) => l.equity)
          .sort((a, b) => (b.equity ?? 0) - (a.equity ?? 0))
          .map(
            (l) =>
              `<li class="${/shell|adura/i.test(l.name) ? 'hl' : ''}"><span>${escapeHtml(l.name)}</span><b>${fmtNum(l.equity ?? 0, 1)}%</b><i style="width:${Math.min(100, l.equity ?? 0)}%"></i></li>`,
          )
          .join('')}</ul>`
      : '';

    const related = s
      ? this.atlas.assets.features
          .filter((f) => f.properties.series === p.series && f.properties.id !== p.id && f.properties.kind !== 'subsea')
          .slice(0, 8)
          .map((f) => `<button class="chip small" data-goto="${escapeHtml(f.properties.id)}">${escapeHtml(f.properties.name)}</button>`)
          .join('')
      : '';

    // Gulf hubs with wells in the bundle can be seen from below (subsea.ts, loaded on demand).
    const sub = this.onDive ? this.atlas.manifest.subsea?.[p.id] : undefined;
    const diveHtml = sub
      ? `<button class="btn dive-btn" data-dive><span><svg viewBox="0 0 24 24"><path d="M12 4v14M6 12l6 6 6-6" /></svg>Dive below</span><small>${fmtNum(sub.wells)} wellbores · deepest ${fmtNum(sub.deepest_tvd_m)} m below sea level</small></button>`
      : '';

    const url = safeUrl(p.url);
    const link = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(SOURCE_LABEL[p.source] ?? p.source)} ↗</a>`
      : escapeHtml(SOURCE_LABEL[p.source] ?? p.source);

    this.body.innerHTML = `
      <p class="kicker"><span class="dot" style="background:${seg.color}"></span>${seg.label} · <span class="stake stake-${escapeHtml(p.stake)}">${escapeHtml(STAKE_LABEL[p.stake] ?? p.stake)}</span></p>
      <h2>${escapeHtml(p.name)}</h2>
      <p class="subtitle">${escapeHtml(kind)}${p.country ? ` · ${escapeHtml(p.country)}` : ''}</p>
      ${p.summary ? `<p class="summary">${escapeHtml(p.summary)}</p>` : ''}
      ${prodHtml}
      ${diveHtml}
      <dl class="facts">${facts}</dl>
      ${lic}
      ${related ? `<h3>Same production hub</h3><div class="chips">${related}</div>` : ''}
      <p class="source">Source: ${link}${p.curated ? '<br><em>Hand-curated entry. Location is approximate; check the ownership date.</em>' : ''}</p>`;

    this.body.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) => b.addEventListener('click', () => this.onSelect(b.dataset.goto!)));

    this.body.querySelector('[data-dive]')?.addEventListener('click', () => this.onDive?.(p.id));

    this.chart?.destroy();
    this.chart = null;
    if (s) {
      const el = document.getElementById('drawer-chart')!;
      // Clip the x-axis at this series' last month so the area doesn't fall to zero where
      // the regulator simply hasn't published yet. Index 0 is still months[0], so the shared
      // timeline cursor stays aligned.
      const months = this.atlas.production.months.slice(0, s.start + s.oil.length);
      const oil: (number | null)[] = months.map((_, k) => (k >= s.start && k - s.start < s.oil.length ? s.oil[k - s.start] : null));
      const gas: (number | null)[] = months.map((_, k) => (k >= s.start && k - s.start < s.gas.length ? s.gas[k - s.start] / GAS_PER_BOE : null));
      const lines =
        s.share != null
          ? [{ label: 'Shell net', color: '#ffffff', dash: '3 3', values: oil.map((o, k) => (o == null ? null : (o + (gas[k] ?? 0)) * s.share!)) }]
          : [];
      this.chart = new AreaChart(el, {
        months,
        stacks: [
          { label: 'Liquids', color: '#ffb703', values: oil },
          { label: 'Gas (as boe)', color: '#4cc9f0', values: gas },
        ],
        lines,
        unit: 'kboe/d',
        height: 150,
        cursor: Math.min(monthIdx, months.length - 1),
        onScrub: this.onScrub,
      });
    }
    this.root.hidden = false;
    this.root.scrollTop = 0;
  }
}

function fact(label: string, v: unknown): string {
  if (v == null || v === '') return '';
  return `<div><dt>${label}</dt><dd>${escapeHtml(String(v))}</dd></div>`;
}
