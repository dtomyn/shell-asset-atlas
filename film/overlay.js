// Injected into the page by film/render.py before the app loads. It adds what a screen recording
// would have and a headless browser doesn't (a cursor, click ripples), the film's own title,
// chapter and end cards, and a frame clock for CSS animations.
(() => {
  const CSS = `
    #film-cursor { position: fixed; inset: auto; left: 0; top: 0; width: 26px; height: 26px; margin: 0; padding: 0; border: 0; background: none; overflow: visible;
      z-index: 2147483647; pointer-events: none; will-change: transform; filter: drop-shadow(0 2px 5px rgba(0,0,0,.7)); }
    #film-cursor.down { scale: .86; }
    .film-ripple { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 2px solid #ffb703; z-index: 2147483646;
      pointer-events: none; animation: film-ripple .55s ease-out forwards; }
    @keyframes film-ripple { from { transform: scale(.25); opacity: .95; } to { transform: scale(1.25); opacity: 0; } }
    #film-card { position: fixed; inset: 0; z-index: 2147483640; pointer-events: none; display: grid; place-items: center; text-align: center; opacity: 0;
      transition: opacity .9s ease; font-family: Inter, system-ui, sans-serif; color: #f2f5f9; }
    #film-card.on { opacity: 1; }
    #film-card.scrim { background: radial-gradient(ellipse at center, rgba(7,10,15,.55) 0%, rgba(7,10,15,.86) 70%); }
    #film-card.solid { background: rgba(7,10,15,.93); }
    #film-card h1 { font-size: 76px; font-weight: 700; letter-spacing: -0.03em; margin: 0 0 14px; text-shadow: 0 4px 40px rgba(0,0,0,.8); }
    #film-card h1 span { color: #ffb703; }
    #film-card p { font-size: 25px; margin: 0 0 10px; color: #cfd8e3; text-shadow: 0 2px 16px rgba(0,0,0,.9); }
    #film-card small { display: block; max-width: 1000px; margin: 26px auto 0; font-size: 16.5px; line-height: 1.6; color: #9aa7b8; }
    #film-card .url { margin-top: 22px; font: 500 22px "JetBrains Mono", monospace; color: #ffb703; }
    #film-chapter { position: fixed; top: 74px; left: 50%; z-index: 2147483641; pointer-events: none; padding: 9px 18px; border-radius: 999px; opacity: 0;
      transform: translateX(-50%); background: rgba(7,10,15,.82); border: 1px solid rgba(255,183,3,.5); color: #f2f5f9;
      font: 600 17px Inter, system-ui, sans-serif; letter-spacing: .01em; white-space: nowrap; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
    #film-chapter b { color: #ffb703; font: 500 14px "JetBrains Mono", monospace; margin-right: 10px; }
    #film-chapter.show { animation: film-chapter 4.2s ease forwards; }
    @keyframes film-chapter { 0% { opacity: 0; translate: 0 -8px; } 9% { opacity: 1; translate: 0 0; } 86% { opacity: 1; } 100% { opacity: 0; } }
    #film-key { position: fixed; left: 50%; bottom: 150px; z-index: 2147483641; pointer-events: none; transform: translateX(-50%); opacity: 0;
      padding: 8px 16px; border-radius: 10px; background: rgba(7,10,15,.85); border: 1px solid rgba(255,255,255,.25); color: #f2f5f9;
      font: 500 15px Inter, system-ui, sans-serif; }
    #film-key kbd { display: inline-block; min-width: 26px; margin-right: 10px; padding: 3px 8px; border-radius: 6px; background: #f2f5f9; color: #070a0f;
      font: 600 15px "JetBrains Mono", monospace; text-align: center; }
    #film-key.show { animation: film-key 1.9s ease forwards; }
    @keyframes film-key { 0% { opacity: 0; } 10% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
  `;
  const el = (tag, id) => {
    const node = document.createElement(tag);
    node.id = id;
    document.body.append(node);
    return node;
  };
  let cursor, card, chapter, key;
  const mount = () => {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    cursor = el('div', 'film-cursor');
    cursor.innerHTML = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M4 2 L4 21 L9.2 16.4 L12.6 24 L15.8 22.6 L12.5 15.2 L19.5 15.2 Z" fill="#fff" stroke="#070a0f" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    cursor.style.transform = 'translate(-100px,-100px)';
    // A popover sits in the top layer, so the cursor can be raised above the app's modal dialog.
    cursor.popover = 'manual';
    cursor.showPopover();
    card = el('div', 'film-card');
    chapter = el('div', 'film-chapter');
    key = el('div', 'film-key');
    // The cursor follows the real pointer events that Playwright sends, so it can't drift from them.
    window.addEventListener('mousemove', (e) => (cursor.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`), true);
    window.addEventListener('mousedown', (e) => {
      cursor.classList.add('down');
      const ripple = document.createElement('div');
      ripple.className = 'film-ripple';
      ripple.style.left = `${e.clientX}px`;
      ripple.style.top = `${e.clientY}px`;
      ripple.addEventListener('animationend', () => ripple.remove());
      document.body.append(ripple);
    }, true);
    window.addEventListener('mouseup', () => cursor.classList.remove('down'), true);
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  const restart = (node, html) => {
    node.innerHTML = html;
    node.classList.remove('show');
    void node.offsetWidth;
    node.classList.add('show');
  };
  const started = new WeakMap();
  let wasModal = false;

  window.__film = {
    /** Moves every CSS transition and animation to the film's clock, so they run at film speed however long a frame takes to capture. */
    tick(now) {
      const modal = !!document.querySelector('dialog[open]');
      if (modal !== wasModal) {
        wasModal = modal;
        cursor.hidePopover();
        cursor.showPopover();
      }
      for (const a of document.getAnimations()) {
        let t0 = started.get(a);
        if (t0 === undefined) {
          started.set(a, (t0 = now));
          a.pause();
        }
        const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
        if (Number.isFinite(end) && now - t0 >= end) a.finish();
        else a.currentTime = now - t0;
      }
      return this.ready();
    },
    /**
     * True when the basemap and imagery tiles for this view have arrived. The app's own GeoJSON layers are
     * left out: they are in memory, and they reload on every month of playback, which is not worth a wait.
     */
    ready() {
      if (!window.__atlas) return true;
      const map = window.__atlas.map;
      const sources = map.getStyle().sources;
      return Object.keys(sources).every((id) => sources[id].type === 'geojson' || map.isSourceLoaded(id));
    },
    redraw: () => window.__atlas && window.__atlas.map.redraw(),
    project: ([lng, lat]) => {
      const p = window.__atlas.map.project([lng, lat]);
      return [p.x, p.y];
    },
    /**
     * A pixel on or just above an asset where the app's own picking returns that asset: the same
     * rule as its click handler (topmost installation or tower), and clear of pipelines if possible,
     * because the hover card shows a pipeline when one is under the pointer.
     */
    pick(id, lngLat) {
      const map = window.__atlas.map;
      const c = map.project(lngLat);
      // 0: not this asset. 1: this asset, but a pipeline is under the pointer too. 2: this asset alone.
      const grade = (x, y) => {
        const hits = map.queryRenderedFeatures([x, y], { layers: ['assets', 'towers', 'pipelines'] });
        const top = hits.find((h) => h.layer.id !== 'pipelines');
        if (!top || String(top.properties.id) !== id) return 0;
        return hits.some((h) => h.layer.id === 'pipelines') ? 1 : 2;
      };
      let best = null;
      for (let dy = -90; dy <= 16; dy += 3) {
        for (let dx = -30; dx <= 30; dx += 3) {
          const x = c.x + dx;
          const y = c.y + dy;
          const here = grade(x, y);
          if (!here) continue;
          // Prefer a spot whose surroundings give the same answer, so a pixel of pointer travel doesn't change what is hovered.
          const steady = here === 2 && [[4, 0], [-4, 0], [0, 4], [0, -4]].every(([ax, ay]) => grade(x + ax, y + ay) === 2);
          const score = (steady ? 0 : here === 2 ? 500 : 1000) + Math.hypot(dx, dy);
          if (!best || score < best.score) best = { score, x, y };
        }
      }
      return best && [best.x, best.y];
    },
    /** How far the nearest scrolling ancestor must move to show the element, and where to put the cursor to wheel it. */
    scrollNeed(selector) {
      const target = document.querySelector(selector);
      let box = target && target.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (!box || box === document.documentElement || box === document.body) return null;
      const r = target.getBoundingClientRect();
      const c = box.getBoundingClientRect();
      const margin = 28;
      const dy = r.bottom > c.bottom - margin ? r.bottom - (c.bottom - margin) : r.top < c.top + margin ? r.top - (c.top + margin) : 0;
      return Math.abs(dy) > 2 ? { dy: Math.round(dy), x: c.left + c.width / 2, y: c.top + c.height * 0.62 } : null;
    },
    card(html, kind) {
      if (html) {
        card.innerHTML = html;
        card.className = `on ${kind || 'scrim'}`;
      } else card.classList.remove('on');
    },
    chapter: (number, title) => restart(chapter, `<b>${number}</b>${title}`),
    key: (cap, label) => restart(key, `<kbd>${cap}</kbd>${label}`),
    cursorVisible: (on) => (cursor.style.display = on ? '' : 'none'),
  };
})();
