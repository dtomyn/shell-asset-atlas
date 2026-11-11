// "Bar chart race" leaderboards synced to the timeline: the top producing hubs and fields
// (Race), on a generic re-ranking bar list (BarRace) that the peer benchmark also uses.
import { fmtNum } from './chart';
import { seriesAt, type Atlas, type Stake } from './data';
import { escapeHtml } from './map';

const ROW_H = 30;
const REGION_COLORS: Record<string, string> = { gom: '#ffb703', uk: '#ff8c42', no: '#4cc9f0', global: '#c8b6ff' };

export interface BarRow {
  id: string;
  /** shown once, when the row is created */
  name: string;
  tag?: string;
  color: string;
  cls?: string;
  title?: string;
  data?: Record<string, string>;
  /** bar length, against the largest value in the list (or `max`) */
  value: number;
  rank: string;
  text: string;
}

/** Rows keep their element between renders, so a change of order animates as a move. */
export class BarRace {
  private rows = new Map<string, HTMLButtonElement>();

  constructor(
    private el: HTMLElement,
    private slots: number,
    private fit = false,
  ) {
    el.style.height = `${slots * ROW_H}px`;
  }

  clear() {
    this.el.replaceChildren();
    this.rows.clear();
  }

  render(list: BarRow[], max = Math.max(1e-9, ...list.map((r) => r.value))) {
    if (this.fit) this.el.style.height = `${list.length * ROW_H}px`;
    const below = Math.max(this.slots, list.length) * ROW_H;
    const seen = new Set<string>();
    list.forEach((r, i) => {
      seen.add(r.id);
      let row = this.rows.get(r.id);
      if (!row) {
        row = document.createElement('button');
        row.className = `race-row${r.cls ? ` ${r.cls}` : ''}`;
        for (const [k, v] of Object.entries(r.data ?? {})) row.dataset[k] = v;
        if (r.title) row.title = r.title;
        row.innerHTML = `<i class="bar" style="background:${r.color}"></i><span class="rank"></span><span class="name">${escapeHtml(r.name)}${r.tag ? `<em>${escapeHtml(r.tag)}</em>` : ''}</span><b></b>`;
        row.style.transform = `translateY(${below}px)`;
        row.style.opacity = '0';
        this.el.append(row);
        this.rows.set(r.id, row);
        void row.offsetWidth; // start the enter transition from below
      }
      row.style.transform = `translateY(${i * ROW_H}px)`;
      row.style.opacity = '1';
      row.style.pointerEvents = '';
      row.querySelector<HTMLElement>('.bar')!.style.width = `${Math.max(2, Math.min(100, (r.value / max) * 100))}%`;
      row.querySelector('.rank')!.textContent = r.rank;
      row.querySelector('b')!.textContent = r.text;
    });
    for (const [id, row] of this.rows) {
      if (seen.has(id)) continue;
      row.style.transform = `translateY(${below}px)`;
      row.style.opacity = '0';
      row.style.pointerEvents = 'none';
    }
  }
}

export class Race {
  private bars: BarRace;

  constructor(
    el: HTMLElement,
    private atlas: Atlas,
    private ownerOf: Map<string, string>,
    private top: number,
    onPick: (assetId: string) => void,
  ) {
    this.bars = new BarRace(el, top);
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-owner]');
      if (b) onPick(b.dataset.owner!);
    });
  }

  update(monthIdx: number, stakes: Set<Stake>) {
    const ranked = Object.entries(this.atlas.production.series)
      .filter(([id, s]) => stakes.has(s.stake) && this.ownerOf.has(id))
      .map(([id, s]) => ({ id, s, v: seriesAt(s, monthIdx)?.boe ?? 0 }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, this.top);
    this.bars.render(
      ranked.map((r, i) => ({
        id: r.id,
        name: r.s.name,
        tag: r.s.stake === 'partner' ? 'partner' : r.s.stake === 'jv' ? 'JV' : undefined,
        color: REGION_COLORS[r.s.region] ?? '#9aa7b8',
        title: 'Fly to this hub',
        data: { owner: this.ownerOf.get(r.id)! },
        value: r.v,
        rank: String(i + 1),
        text: fmtNum(r.v, r.v < 10 ? 1 : 0),
      })),
    );
  }
}
