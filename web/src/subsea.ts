// "Below the waterline": a 3D view of one Gulf hub from the sea surface down to its deepest well.
//
// This module and three.js are loaded on demand (dynamic import from main.ts), together with
// wells.json, the first time a dive is opened. Everything drawn comes from the bundle:
//   - well paths: BOEM directional surveys (solid) or a schematic from the seabed to the
//     reported bottom-hole location where no survey is on file (dashed, labelled as such)
//   - seabed: interpolated by the pipeline from water depths at borehole sites
//   - pipelines: the Shell-operated segments already in pipelines.geojson, laid on that seabed
// Nothing below the seabed is drawn except the wells: there is no public data here for
// reservoirs, salt or formations, so the view does not invent any.
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { fmtNum } from './chart';
import type { Atlas } from './data';
import { escapeHtml } from './map';
import {
  FT_PER_M,
  STATUS_OTHER,
  YEAR_RAMP,
  clipLine,
  depthTicks,
  diveKeys,
  divePose,
  drape,
  landmarkStack,
  pickPath,
  seabedAt,
  splitAtDepth,
  spudYear,
  statusColor,
  toLocal,
  toScene,
  triples,
  wellFocus,
  yearColor,
  yearRange,
  type Pose,
  type Vec2,
  type Vec3,
  type WellRecord,
  type WellsData,
} from './subsea-geo';

export interface SubseaOptions {
  hubId: string;
  atlas: Atlas;
  /** called once, however the view is closed */
  onClose: () => void;
}
export interface SubseaHandle {
  close(): void;
}

type ColorMode = 'status' | 'year';

const EXAGGERATION = 3;
const DIVE_MS = 12000;
const PRODUCT_COLORS = { gas: '#4cc9f0', oil: '#ffb703', other: '#9aa7b8' } as const;
const SKY = new Color('#0a1522');
const SHALLOW = new Color('#0f4a70');
const ABYSS = new Color('#03101c');
const ROCK = new Color('#0e0c0a');

let wellsCache: Promise<WellsData | null> | null = null;
export function loadWells(): Promise<WellsData | null> {
  wellsCache ??= fetch(`${import.meta.env.BASE_URL}data/wells.json`)
    .then((r) => (r.ok ? (r.json() as Promise<WellsData>) : null))
    .then((d) => (d && d.hubs ? d : null))
    .catch(() => null);
  return wellsCache;
}

const m = (v: number) => `${fmtNum(v)} m`;
const ft = (v: number) => `${fmtNum(v * FT_PER_M)} ft`;
const apiNumber = (a: string) => (a.length === 12 ? `${a.slice(0, 2)}-${a.slice(2, 5)}-${a.slice(5, 10)}-${a.slice(10)}` : a);
const fmtDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'not recorded');

export async function openSubsea(o: SubseaOptions): Promise<SubseaHandle> {
  const asset = o.atlas.assets.features.find((f) => f.properties.id === o.hubId)?.properties;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const returnFocus = document.activeElement as HTMLElement | null;

  // --- shell of the overlay: shown at once, filled when wells.json arrives -----------------
  const root = document.createElement('div');
  root.className = 'subsea';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', `Below the waterline: ${asset?.name ?? 'hub'}`);
  root.innerHTML = `
    <canvas class="subsea-canvas"></canvas>
    <div class="subsea-labels" aria-hidden="true"></div>
    <header class="subsea-head glass">
      <p class="kicker"><span class="dot"></span>Below the waterline · unofficial · BOEM public data</p>
      <h2>${escapeHtml(asset?.name ?? '')}</h2>
      <p class="subtitle">${escapeHtml([asset?.subtype, asset?.block].filter(Boolean).join(' · '))}</p>
      <div class="stat-row" data-stats></div>
      <p class="subsea-scale" data-scale></p>
    </header>
    <div class="subsea-tools glass">
      <div class="seg" role="group" aria-label="Vertical scale" data-ve>
        <button data-v="1" class="on" title="Depth and distance at the same scale">True scale</button>
        <button data-v="${EXAGGERATION}" title="Depths stretched ${EXAGGERATION} times">Depth ×${EXAGGERATION}</button>
      </div>
      <div class="seg" role="group" aria-label="Colour wells by" data-color>
        <button data-c="status" class="on">Status</button>
        <button data-c="year">Spud year</button>
      </div>
      <button class="tool" data-orbit aria-pressed="false" title="Slowly orbit the camera"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M20.5 9a9 9 0 1 0 .5 3M21 4v5h-5" /></svg>Orbit</button>
      <button class="tool" data-dive title="Replay the descent from the surface"><svg viewBox="0 0 24 24"><path d="M12 4v14M6 12l6 6 6-6" /></svg>Dive</button>
      <button class="icon-btn" data-close aria-label="Close the subsea view" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
    </div>
    <aside class="subsea-legend glass" data-legend hidden></aside>
    <div class="subsea-depth" data-depth hidden></div>
    <div class="subsea-tip" data-tip hidden></div>
    <p class="subsea-msg" data-msg>Loading well paths…</p>`;
  document.body.appendChild(root);
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const canvas = q<HTMLCanvasElement>('.subsea-canvas');
  const msg = q('[data-msg]');

  let closed = false;
  const cleanup: (() => void)[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    cleanup.forEach((fn) => fn());
    root.remove();
    returnFocus?.focus?.();
    o.onClose();
  };
  q('[data-close]').addEventListener('click', close);
  q<HTMLButtonElement>('[data-close]').focus();
  const handle: SubseaHandle = { close };

  // Anything that throws while the scene is being built must not orphan the overlay.
  const build = async (): Promise<SubseaHandle> => {
  const data = await loadWells();
  if (closed) return handle;
  const hub = data && Object.hasOwn(data.hubs, o.hubId) ? data.hubs[o.hubId] : undefined;
  if (!data || !hub || !hub.wells.length) {
    msg.textContent = 'No well data is available for this hub in the current build.';
    return handle;
  }

  // --- numbers: all from the bundle --------------------------------------------------------
  const st = hub.stats;
  const water = hub.water_depth_m;
  const stack = landmarkStack(water);
  const stat = (v: string, label: string) => `<div class="stat"><span>${v}</span><small>${label}</small></div>`;
  q('[data-stats]').innerHTML =
    stat(m(water), `water depth at the hub · ${ft(water)}`) +
    stat(fmtNum(st.wells), `wellbores, sidetracks counted separately · ${fmtNum(st.surveyed)} with a survey`) +
    stat(m(st.deepest_tvd_m), `deepest well, below sea level · ${ft(st.deepest_tvd_m)}`) +
    stat(`${fmtNum(st.drilled_m / 1000)} km`, `of hole drilled below the seabed${st.drilled_unknown ? ` · ${st.drilled_unknown} sidetracks without a kick-off depth not counted` : ''}`);
  q('[data-scale]').innerHTML = `The water here is as deep as <b>${fmtNum(stack.times, 1)}</b> ${escapeHtml(stack.name)}s (${fmtNum(stack.height_m)} m) stood on end. One is drawn to scale on the seabed beside the hub.`;

  // --- geometry in the hub's frame ---------------------------------------------------------
  const R = hub.radius_m;
  const grid = hub.seabed;
  const paths = hub.wells.map((w) => triples(w.path));
  const bottom = Math.ceil((st.deepest_tvd_m * 1.04) / 500) * 500;
  const { focus, reach } = wellFocus(paths, water);
  const years = yearRange(hub.wells);

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    msg.innerHTML = 'This view needs WebGL, which this browser or device has not made available.<br>The figures above are still read from the data.';
    return handle;
  }
  msg.hidden = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new Scene();
  const background = SKY.clone();
  scene.background = background;
  const camera = new PerspectiveCamera(50, 1, 5, 900_000);
  scene.add(new AmbientLight(0xffffff, 1.5));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(-0.5, 1, 0.7);
  scene.add(sun);

  // Everything with a depth hangs off this group, so the vertical scale is one number.
  const world = new Group();
  scene.add(world);
  let ve = 1;
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // Sea surface.
  const surface = new Mesh(keep(new PlaneGeometry(2 * R, 2 * R)), keep(new MeshBasicMaterial({ color: '#4cc9f0', transparent: true, opacity: 0.1, side: DoubleSide, depthWrite: false })));
  surface.rotation.x = -Math.PI / 2;
  world.add(surface);

  // Draw order for the see-through parts. Walls and surface go first, as the backdrop. Wells
  // and pipelines follow and write depth. The seabed is blended after them without writing
  // depth, so a hole behind the seabed shows through it, dimmed, instead of vanishing.
  const ORDER = { backdrop: 0, lines: 1, seabed: 2, overlay: 3 };

  // Seabed: the pipeline's interpolated grid, shaded by depth.
  const n = grid.n;
  const step = (2 * R) / (n - 1);
  const dMin = Math.min(...grid.depth);
  const dMax = Math.max(...grid.depth);
  const bedPos: number[] = [];
  const bedCol: number[] = [];
  const high = new Color('#5f93ad');
  const low = new Color('#173246');
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const d = grid.depth[j * n + i];
      bedPos.push(-R + i * step, -d, R - j * step);
      const c = high.clone().lerp(low, dMax === dMin ? 0.5 : (d - dMin) / (dMax - dMin));
      bedCol.push(c.r, c.g, c.b);
    }
  const bedIdx: number[] = [];
  const gridLines: number[] = [];
  const at = (i: number, j: number) => j * n + i;
  const vert = (k: number) => [bedPos[k * 3], bedPos[k * 3 + 1] + 3, bedPos[k * 3 + 2]];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      if (i < n - 1 && j < n - 1) bedIdx.push(at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
      if (i < n - 1 && j % 2 === 0) gridLines.push(...vert(at(i, j)), ...vert(at(i + 1, j)));
      if (j < n - 1 && i % 2 === 0) gridLines.push(...vert(at(i, j)), ...vert(at(i, j + 1)));
    }
  const bedGeo = keep(new BufferGeometry());
  bedGeo.setAttribute('position', new Float32BufferAttribute(bedPos, 3));
  bedGeo.setAttribute('color', new Float32BufferAttribute(bedCol, 3));
  bedGeo.setIndex(bedIdx);
  bedGeo.computeVertexNormals();
  const bed = new Mesh(bedGeo, keep(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide, transparent: true, opacity: 0.5, depthWrite: false })));
  bed.renderOrder = ORDER.seabed;
  world.add(bed);
  const gridGeo = keep(new BufferGeometry());
  gridGeo.setAttribute('position', new Float32BufferAttribute(gridLines, 3));
  const bedGrid = new LineSegments(gridGeo, keep(new LineBasicMaterial({ color: '#cfe8f5', transparent: true, opacity: 0.12, depthWrite: false })));
  bedGrid.renderOrder = ORDER.seabed;
  world.add(bedGrid);

  // Side walls: water from the surface to the seabed edge (lighter at the top), then a plain
  // volume from the seabed down to just below the deepest well.
  const edge: [number, number][] = [];
  for (let i = 0; i < n; i++) edge.push([i, 0]);
  for (let j = 1; j < n; j++) edge.push([n - 1, j]);
  for (let i = n - 2; i >= 0; i--) edge.push([i, n - 1]);
  for (let j = n - 2; j >= 0; j--) edge.push([0, j]);
  const wall = (top: (d: number) => number, bot: (d: number) => number, cTop: Color, cBot: Color, ref: number, opacity: number) => {
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    edge.forEach(([i, j], k) => {
      const d = grid.depth[at(i, j)];
      const x = -R + i * step;
      const z = R - j * step;
      for (const y of [top(d), bot(d)]) {
        pos.push(x, -y, z);
        const c = cTop.clone().lerp(cBot, Math.min(1, y / ref));
        col.push(c.r, c.g, c.b);
      }
      if (k > 0) idx.push(2 * k - 2, 2 * k - 1, 2 * k, 2 * k - 1, 2 * k + 1, 2 * k);
    });
    const g = keep(new BufferGeometry());
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    world.add(new Mesh(g, keep(new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, side: DoubleSide, depthWrite: false }))));
  };
  wall(() => 0, (d) => d, new Color('#3aa0d8'), new Color('#062a45'), Math.max(dMax, 1), 0.26);
  wall((d) => d, () => bottom, new Color('#4b4138'), new Color('#15110d'), bottom, 0.3);
  const frame: number[] = [];
  for (const [x, z] of [[-R, R], [R, R], [R, -R], [-R, -R]]) frame.push(x, 0, z, x, -bottom, z);
  for (const y of [0, -bottom]) frame.push(-R, y, R, R, y, R, R, y, R, R, y, -R, R, y, -R, -R, y, -R, -R, y, -R, -R, y, R);
  const frameGeo = keep(new BufferGeometry());
  frameGeo.setAttribute('position', new Float32BufferAttribute(frame, 3));
  const box = new LineSegments(frameGeo, keep(new LineBasicMaterial({ color: '#cfe8f5', transparent: true, opacity: 0.22, depthWrite: false })));
  box.renderOrder = ORDER.overlay;
  world.add(box);

  // Platform marker at the surface. A marker, not a model: its shape says nothing about the real host.
  const marker = new Group();
  const amber = keep(new MeshLambertMaterial({ color: '#ffb703' }));
  const deck = new Mesh(keep(new BoxGeometry(110, 26, 110)), amber);
  deck.position.y = 38;
  const column = new Mesh(keep(new CylinderGeometry(20, 20, 150, 16)), amber);
  column.position.y = -50;
  const mast = new Mesh(keep(new CylinderGeometry(3, 3, 70, 6)), amber);
  mast.position.set(30, 86, 30);
  marker.add(deck, column, mast);
  world.add(marker);

  // Human scale: the landmark at its real height, standing on the seabed beside the hub.
  const lmAt: Vec2 = [-420, -420];
  const lmBase = seabedAt(grid, R, lmAt[0], lmAt[1]);
  const landmark = new Mesh(keep(new ConeGeometry(42, stack.height_m, 4)), keep(new MeshLambertMaterial({ color: '#e9eef5', transparent: true, opacity: 0.9 })));
  landmark.position.set(lmAt[0], -(lmBase - stack.height_m / 2), -lmAt[1]);
  world.add(landmark);

  // Wells: the part in the water (pale, thin) and the hole below the seabed (coloured).
  const lineMats: LineMaterial[] = [];
  const fatLine = (pts: Vec3[], opts: { color: string; width: number; opacity?: number; dashed?: boolean }) => {
    const g = keep(new LineGeometry());
    g.setPositions(pts.flatMap((p) => toScene(p)));
    const solid = (opts.opacity ?? 1) > 0.9;
    const mat = keep(new LineMaterial({ color: opts.color, linewidth: opts.width, transparent: !solid, opacity: opts.opacity ?? 1, dashed: !!opts.dashed, dashSize: 110, gapSize: 80, depthWrite: solid }));
    lineMats.push(mat);
    const line = new Line2(g, mat);
    line.renderOrder = solid ? ORDER.lines : ORDER.overlay;
    if (opts.dashed) line.computeLineDistances();
    world.add(line);
    return mat;
  };
  let colorMode: ColorMode = 'status';
  const wellColor = (w: WellRecord) => (colorMode === 'status' ? statusColor(w.status) : yearColor(spudYear(w), years));
  const holes: (LineMaterial | null)[] = hub.wells.map((w, i) => {
    const { above, below } = splitAtDepth(paths[i], w.wd);
    if (above.length > 1) fatLine(above, { color: '#bfe6ff', width: 1, opacity: 0.3 });
    return below.length > 1 ? fatLine(below, { color: wellColor(w), width: 2.2, dashed: !w.sv }) : null;
  });

  // Pipelines from the main bundle that cross this window, laid on the seabed.
  const pipes = { gas: 0, oil: 0, other: 0 };
  for (const f of o.atlas.pipelines.features) {
    if (f.properties.region !== 'gom') continue;
    const local = f.geometry.coordinates.map(([lon, lat]) => toLocal(lon, lat, hub.lon, hub.lat));
    if (!local.some(([x, y]) => Math.abs(x) < 3 * R && Math.abs(y) < 3 * R)) continue;
    const product = String(f.properties.product ?? '').toLowerCase();
    const kind = product.includes('gas') ? 'gas' : product.includes('oil') || product.includes('blko') ? 'oil' : 'other';
    for (const piece of clipLine(local, R)) {
      fatLine(drape(piece, grid, R, step / 2).map((p) => [p[0], p[1], p[2] - 12] as Vec3), { color: PRODUCT_COLORS[kind], width: 2.6, opacity: 0.95 });
      pipes[kind]++;
    }
  }

  // Depth staff beside the wells, marked in metres and feet.
  const staffOut = Math.min(R * 0.96, Math.max(900, reach * 1.2 + 400));
  const clampR = (v: number) => Math.max(-R * 0.98, Math.min(R * 0.98, v));
  // North-east of the wells, which is the right-hand side of the opening view.
  const staff: Vec2 = [clampR(focus[0] + staffOut * 0.75), clampR(focus[1] + staffOut * 0.75)];
  const tickLen = Math.max(60, staffOut * 0.035);
  const staffPos: number[] = [staff[0], 0, -staff[1], staff[0], -bottom, -staff[1]];
  const labels: { el: HTMLElement; at: Vec3 }[] = [];
  const labelBox = q('.subsea-labels');
  const addLabel = (text: string, at: Vec3, cls = '') => {
    const el = document.createElement('span');
    el.className = `subsea-label ${cls}`;
    el.textContent = text;
    labelBox.appendChild(el);
    labels.push({ el, at });
  };
  const special: [number, string][] = [
    [water, `Seabed at the hub · ${m(water)} · ${ft(water)}`],
    [st.deepest_tvd_m, `Deepest well · ${m(st.deepest_tvd_m)} · ${ft(st.deepest_tvd_m)}`],
  ];
  const ticks = depthTicks(bottom);
  const tickStep = ticks[1] ?? bottom;
  for (const d of ticks) {
    staffPos.push(staff[0] - tickLen, -d, -staff[1], staff[0] + tickLen, -d, -staff[1]);
    if (special.some(([s]) => Math.abs(s - d) < tickStep * 0.3)) continue;
    addLabel(d === 0 ? 'Sea level' : `${m(d)} · ${ft(d)}`, [staff[0] + tickLen * 1.6, -d, -staff[1]], 'tick');
  }
  for (const [d, text] of special) {
    staffPos.push(staff[0] - tickLen * 1.8, -d, -staff[1], staff[0] + tickLen * 1.8, -d, -staff[1]);
    addLabel(text, [staff[0] + tickLen * 2.2, -d, -staff[1]], 'tick mark');
  }
  const staffGeo = keep(new BufferGeometry());
  staffGeo.setAttribute('position', new Float32BufferAttribute(staffPos, 3));
  const staffLine = new LineSegments(staffGeo, keep(new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.75, depthWrite: false })));
  staffLine.renderOrder = ORDER.overlay;
  world.add(staffLine);
  addLabel(hub.name, [0, 150, 0], 'hub');
  addLabel(`${stack.name} · ${fmtNum(stack.height_m)} m, to scale`, [lmAt[0], -(lmBase - stack.height_m), -lmAt[1]], 'ref');

  // --- legend ------------------------------------------------------------------------------
  const legend = q('[data-legend]');
  const renderLegend = () => {
    const key = (color: string, label: string, cls = '') => `<span><i class="${cls}" style="--c:${color}"></i>${label}</span>`;
    let wellsKey: string;
    if (colorMode === 'status') {
      const counts = new Map<string, number>();
      for (const w of hub.wells) counts.set(w.status, (counts.get(w.status) ?? 0) + 1);
      wellsKey = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, c]) => key(statusColor(code), `${escapeHtml(data.status[code] ?? code)} <em>${c}</em>`))
        .join('');
    } else {
      wellsKey = years
        ? `<span class="ramp"><b style="background:linear-gradient(90deg,${YEAR_RAMP.join(',')})"></b><span>${years[0]}</span><span>spud year</span><span>${years[1]}</span></span>`
        : key(STATUS_OTHER, 'Spud date not recorded');
    }
    const pipeKey = [
      pipes.oil ? key(PRODUCT_COLORS.oil, 'Oil pipeline', 'pipe') : '',
      pipes.gas ? key(PRODUCT_COLORS.gas, 'Gas pipeline', 'pipe') : '',
      pipes.other ? key(PRODUCT_COLORS.other, 'Other pipeline', 'pipe') : '',
    ].join('');
    legend.innerHTML = `
      <h3>Wells by ${colorMode === 'status' ? 'BOEM borehole status' : 'spud year'}</h3>
      <div class="subsea-keys">${wellsKey}</div>
      <div class="subsea-keys">
        ${key('#e9eef5', `Surveyed path (BOEM directional survey) <em>${st.surveyed}</em>`, 'solid')}
        ${st.schematic ? key('#e9eef5', `Schematic (surface to bottom-hole), no survey on file <em>${st.schematic}</em>`, 'dash') : ''}
        ${key('#bfe6ff', 'Well path through the water column', 'thin')}
        ${pipeKey}
      </div>
      <p>${pipeKey ? 'Pipelines are the Shell-operated segments in the BOEM pipeline file, laid on the seabed shown here. ' : ''}The seabed is interpolated from water depths at ${fmtNum(grid.control_points)} borehole sites, not a bathymetric survey. No geology is drawn: there is no public data here for reservoirs or formations. The platform marker, the landmark's width and all line widths are not to scale.${st.by_field_code ? ` ${st.by_field_code} wellbores have no host on file and are included by field code.` : ''}</p>`;
    legend.hidden = false;
  };
  renderLegend();

  // --- camera ------------------------------------------------------------------------------
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = !reduced;
  controls.dampingFactor = 0.08;
  controls.minDistance = 60;
  controls.maxDistance = Math.max(8 * R, 6 * bottom);
  controls.autoRotateSpeed = 0.5; // one turn in two minutes
  controls.zoomSpeed = 1.2;
  cleanup.push(() => controls.dispose());

  /** The free-orbit view, at true scale: from in the water, looking slightly down, so the water
   *  column is above the seabed line and the wells are below it in one frame. */
  const overview = (): Pose => {
    const target: Vec3 = [focus[0] * 0.5, -0.5 * st.deepest_tvd_m, -focus[1] * 0.5];
    const dist = Math.min(Math.max(1.6 * reach, 1.75 * st.deepest_tvd_m * ve, 4000), 2.2 * R);
    const az = (38 * Math.PI) / 180;
    return { pos: [target[0] + dist * Math.sin(az), -0.6 * water, target[2] + dist * Math.cos(az)], target };
  };
  const applyPose = (p: Pose) => {
    camera.position.set(p.pos[0], p.pos[1] * ve, p.pos[2]);
    controls.target.set(p.target[0], p.target[1] * ve, p.target[2]);
    camera.lookAt(controls.target);
  };

  let orbit = false;
  const orbitBtn = q('[data-orbit]');
  const setOrbit = (on: boolean) => {
    orbit = on;
    controls.autoRotate = on && !dive;
    orbitBtn.setAttribute('aria-pressed', String(on));
  };
  let dive: { t0: number; keys: ReturnType<typeof diveKeys> } | null = null;
  const depthEl = q('[data-depth]');
  const startDive = () => {
    dive = { t0: performance.now(), keys: diveKeys({ water, deepest: st.deepest_tvd_m, focus, overview: overview() }) };
    controls.enabled = false;
    controls.autoRotate = false;
    root.classList.add('diving');
  };
  const endDive = (settle: boolean) => {
    if (!dive) return;
    dive = null;
    controls.enabled = true;
    root.classList.remove('diving');
    if (settle) setOrbit(true);
    else controls.autoRotate = orbit;
  };
  // Any touch of the scene hands the camera back to the user, mid-dive included.
  const interrupt = () => {
    if (dive) endDive(false);
    else if (orbit) setOrbit(false);
  };
  canvas.addEventListener('pointerdown', interrupt);
  canvas.addEventListener('wheel', interrupt, { passive: true });
  orbitBtn.addEventListener('click', () => {
    if (dive) endDive(false);
    setOrbit(!orbit);
  });
  q('[data-dive]').addEventListener('click', () => (reduced ? applyPose(overview()) : startDive()));

  q('[data-ve]').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-v]');
    if (!b) return;
    const next = Number(b.dataset.v);
    const k = next / ve;
    ve = next;
    world.scale.y = ve;
    marker.scale.y = 1 / ve;
    camera.position.y *= k;
    controls.target.y *= k;
    root.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((x) => x.classList.toggle('on', x === b));
  });
  q('[data-color]').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-c]');
    if (!b) return;
    colorMode = b.dataset.c as ColorMode;
    root.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((x) => x.classList.toggle('on', x === b));
    hub.wells.forEach((w, i) => i !== hovered && holes[i]?.color.set(wellColor(w)));
    renderLegend();
  });

  // --- hover -------------------------------------------------------------------------------
  const tip = q('[data-tip]');
  const v3 = new Vector3();
  let width = 1;
  let height = 1;
  const project = (p: Vec3): Vec2 | null => {
    v3.set(p[0], p[1] * ve, p[2]).project(camera);
    return v3.z > 1 || v3.z < -1 ? null : [(v3.x * 0.5 + 0.5) * width, (-v3.y * 0.5 + 0.5) * height];
  };
  const scenePaths = paths.map((path) => path.map((p) => toScene(p)));
  let hovered = -1;
  let pointer: Vec2 | null = null;
  // The film renderer (film/render.py) opens the page with ?film. To point its cursor at a well it
  // needs to know where the wells are on screen. Nothing else reads this, and it is absent otherwise.
  if (new URLSearchParams(location.search).has('film')) {
    const film = window as unknown as Record<string, unknown>;
    film.__subsea = { wells: () => scenePaths.map((path) => path.map(project)) };
    cleanup.push(() => delete film.__subsea);
  }
  const setHovered = (i: number) => {
    if (i === hovered) return;
    if (hovered >= 0 && holes[hovered]) {
      holes[hovered]!.color.set(wellColor(hub.wells[hovered]));
      holes[hovered]!.linewidth = 2.2;
    }
    hovered = i;
    canvas.style.cursor = i >= 0 ? 'pointer' : '';
    if (i < 0) {
      tip.hidden = true;
      return;
    }
    const w = hub.wells[i];
    if (holes[i]) {
      holes[i]!.color.set('#ffffff');
      holes[i]!.linewidth = 4;
    }
    tip.innerHTML = `
      <strong>${escapeHtml(w.name)}</strong>
      <span>API ${escapeHtml(apiNumber(w.api))}${data.types[w.type] ? ` · ${escapeHtml(data.types[w.type])}` : ''}</span>
      <span>Total depth ${m(w.md)} measured · ${m(w.tvd)} below sea level</span>
      <span>Spud ${fmtDate(w.spud)} · ${escapeHtml(data.status[w.status] ?? w.status)}</span>
      <em>${w.sv ? 'Path from the BOEM directional survey' : 'Schematic (surface to bottom-hole): no survey on file'}${w.tie === 'field' ? ' · no host on file, included by field code' : ''}</em>`;
    tip.hidden = false;
  };
  const pick = () => {
    if (!pointer || dive) return setHovered(-1);
    setHovered(pickPath(scenePaths.map((path) => path.map(project)), pointer[0], pointer[1], 9));
    if (hovered >= 0) {
      tip.style.left = `${Math.min(pointer[0] + 16, width - 300)}px`;
      tip.style.top = `${Math.min(pointer[1] + 16, height - 130)}px`;
    }
  };
  let pickQueued = false;
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer = [e.clientX - r.left, e.clientY - r.top];
    pickQueued = true;
  };
  canvas.addEventListener('pointermove', onPointer);
  canvas.addEventListener('pointerup', onPointer);
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    setHovered(-1);
  });

  // --- frame loop --------------------------------------------------------------------------
  const resize = () => {
    width = root.clientWidth || window.innerWidth;
    height = root.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    for (const mat of lineMats) mat.resolution.set(width, height);
  };
  resize();
  window.addEventListener('resize', resize);
  cleanup.push(() => window.removeEventListener('resize', resize));

  const tint = new Color();
  let raf = 0;
  let last = performance.now();
  const frame_ = (now: number) => {
    raf = requestAnimationFrame(frame_);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (dive) {
      const t = (now - dive.t0) / DIVE_MS;
      applyPose(divePose(dive.keys, t));
      if (t >= 1) endDive(true);
    } else controls.update(dt); // seconds, so the orbit turns at the same rate on any display

    // Where the camera is: above the sea, in the water, or below the seabed.
    const depth = -camera.position.y / ve;
    const inside = Math.abs(camera.position.x) <= R && Math.abs(camera.position.z) <= R;
    const bed = seabedAt(grid, R, camera.position.x, -camera.position.z);
    if (depth <= 0 || !inside) tint.copy(SKY);
    else if (depth < bed) tint.copy(SHALLOW).lerp(ABYSS, Math.min(1, depth / 2500));
    else tint.copy(ROCK);
    background.lerp(tint, reduced ? 1 : 0.08);
    depthEl.hidden = false;
    depthEl.innerHTML =
      depth <= 0
        ? `Camera <b>${m(-depth)}</b> above sea level`
        : `Camera <b>${m(depth)}</b> below sea level · ${ft(depth)}<small>${!inside ? 'outside the mapped window' : depth < bed ? 'in the water column' : 'below the seabed'}</small>`;

    if (pickQueued) {
      pickQueued = false;
      pick();
    }
    renderer.render(scene, camera);
    for (const l of labels) {
      const s = project(l.at);
      const show = !!s && s[0] > -80 && s[0] < width + 80 && s[1] > -20 && s[1] < height + 20;
      l.el.style.display = show ? '' : 'none';
      if (show) l.el.style.transform = `translate(${s![0].toFixed(1)}px, ${s![1].toFixed(1)}px)`;
    }
  };
  const lost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    msg.textContent = 'The graphics context was lost. Close this view and open it again.';
    msg.hidden = false;
  };
  canvas.addEventListener('webglcontextlost', lost);
  cleanup.push(() => {
    cancelAnimationFrame(raf);
    disposables.forEach((d) => d.dispose());
    renderer.dispose();
    renderer.forceContextLoss();
  });

  // Open with the dive, or go straight to the overview if the user prefers less motion.
  applyPose(overview());
  if (!reduced) startDive();
  raf = requestAnimationFrame(frame_);
  return handle;
  };
  try {
    return await build();
  } catch (e) {
    close();
    throw e;
  }
}
