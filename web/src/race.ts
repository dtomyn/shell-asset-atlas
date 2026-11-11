// "Bar chart race" leaderboard of the top producing hubs and fields, synced to the timeline.
import { fmtNum } from './chart';
import { seriesAt, type Atlas, type Stake } from './data';
import { escapeHtml } from './map';

const ROW_H = 30;
const REGION_COLORS: Record<string, string> = { gom: '#ffb703', uk: '#ff8c42', no: '#4cc9f0', global: '#c8b6ff' };

export class Race {
  private rows = new Map<string, HTMLButtonElement>();

  constructor(
    private el: HTMLElement,
    private atlas: Atlas,
    private ownerOf: Map<string, string>,
    private top: number,
    onPick: (assetId: string) => void,
  ) {
    el.style.height = `${top * ROW_H}px`;
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
    const max = ranked[0]?.v ?? 1;
    const seen = new Set<string>();
    ranked.forEach((r, i) => {
      seen.add(r.id);
      let row = this.rows.get(r.id);
      if (!row) {
        row = document.createElement('button');
        row.className = 'race-row';
        row.dataset.owner = this.ownerOf.get(r.id)!;
        row.title = 'Fly to this hub';
        row.innerHTML = `<i class="bar" style="background:${REGION_COLORS[r.s.region] ?? '#9aa7b8'}"></i><span class="rank"></span><span class="name">${escapeHtml(r.s.name)}${r.s.stake === 'partner' ? '<em>partner</em>' : r.s.stake === 'jv' ? '<em>JV</em>' : ''}</span><b></b>`;
        row.style.transform = `translateY(${this.top * ROW_H}px)`;
        row.style.opacity = '0';
        this.el.append(row);
        this.rows.set(r.id, row);
        void row.offsetWidth; // start the enter transition from below
      }
      row.style.transform = `translateY(${i * ROW_H}px)`;
      row.style.opacity = '1';
      row.style.pointerEvents = '';
      row.querySelector<HTMLElement>('.bar')!.style.width = `${Math.max(2, (r.v / max) * 100)}%`;
      row.querySelector('.rank')!.textContent = String(i + 1);
      row.querySelector('b')!.textContent = fmtNum(r.v, r.v < 10 ? 1 : 0);
    });
    for (const [id, row] of this.rows) {
      if (seen.has(id)) continue;
      row.style.transform = `translateY(${this.top * ROW_H}px)`;
      row.style.opacity = '0';
      row.style.pointerEvents = 'none';
    }
  }
}
