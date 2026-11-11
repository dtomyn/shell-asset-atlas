// Guided, data-driven tour. Every number in the narrative is computed from the bundle at
// runtime, so the story stays true after each weekly data refresh.
import type { LngLatLike } from 'maplibre-gl';
import { fmtMonth, fmtNum } from './chart';
import { GAS_PER_BOE, lastReported, type AssetProps, type Atlas } from './data';

function article(noun: string): string {
  const acronym = /^[A-Z]{2,}/.test(noun);
  const vowelSound = acronym ? /^[AEFHILMNORSX]/.test(noun) : /^[aeiou]/i.test(noun);
  return `${vowelSound ? 'an' : 'a'} ${acronym ? noun : noun.toLowerCase()}`;
}

export interface TourStop {
  kicker: string;
  title: string;
  body: string;
  camera: { center: LngLatLike; zoom: number; pitch?: number; bearing?: number };
  select?: string;
  layers?: Partial<Record<'fuel' | 'ev' | 'fields' | 'pipelines' | 'assets', boolean>>;
}

export function buildTour(atlas: Atlas, timelineEnd: number): TourStop[] {
  const k = atlas.manifest.kpis;
  const P = atlas.production;
  const all = [...atlas.assets.features, ...atlas.fields.features].map((f) => f.properties as AssetProps);
  const byId = (id: string) => all.find((a) => a.id === id);
  const latestBoe = (seriesId?: string) => {
    const s = seriesId ? P.series[seriesId] : undefined;
    if (!s) return null;
    const li = lastReported(s);
    const i = li - s.start;
    return { boe: s.oil[i] + s.gas[i] / GAS_PER_BOE, gas: s.gas[i], month: fmtMonth(P.months[li], true), share: s.share };
  };
  const regionTotal = (r: string) => {
    const t = (st: string) => P.totals[`${r}:${st}`]?.gross[timelineEnd] ?? 0;
    return t('operated') + t('jv');
  };
  const endMonth = fmtMonth(P.months[timelineEnd], true);
  const n = (v: number | null | undefined, d = 0) => (v == null ? '—' : fmtNum(v, d));

  const gomHubs = atlas.assets.features.map((f) => f.properties).filter((p) => p.region === 'gom' && p.featured);
  const deepest = [...gomHubs].sort((a, b) => (b.water_depth_m ?? 0) - (a.water_depth_m ?? 0))[0];
  const newest = [...gomHubs].sort((a, b) => (b.installed ?? 0) - (a.installed ?? 0))[0];
  const mars = byId('gom-24199');
  const marsProd = latestBoe(mars?.series);
  const newestProd = latestBoe(newest?.series);
  const gomCount = atlas.assets.features.filter((f) => f.properties.region === 'gom').length;

  const ukFields = atlas.fields.features.map((f) => f.properties).filter((p) => p.region === 'uk');
  const adura = ukFields.filter((p) => p.stake === 'jv').length;
  const shellUk = ukFields.filter((p) => p.stake === 'operated').length;

  const ol = byId('no-field-ormen-lange');
  const olProd = latestBoe(ol?.series);
  const troll = byId('no-field-troll');
  const trollProd = latestBoe(troll?.series);

  const stops: TourStop[] = [
    {
      kicker: 'Overview',
      title: 'One company, mapped from public records',
      body: `This atlas brings together ${n(k.assets)} installations and sites, ${n(k.fields)} oil and gas fields and ${n(k.pipeline_km)} km of Shell-operated pipelines across ${n(k.countries)} countries. It also shows ${n(k.fuel_stations)} Shell-branded stations mapped by OpenStreetMap volunteers. A scheduled pipeline rebuilds it from regulator data every week.`,
      camera: { center: [-25, 32], zoom: 1.5, pitch: 0, bearing: 0 },
    },
    {
      kicker: 'US Gulf of America',
      title: 'The deepwater engine',
      body: `BOEM records ${n(gomCount)} Shell-operated structures still standing in federal waters. In ${endMonth}, Shell-operated completions reported <b>${n(regionTotal('gom'))} kboe/d</b> gross. The Mars–Olympus hub alone produced ${n(marsProd?.boe)} kboe/d. Scrub the timeline below to watch it change.`,
      camera: { center: [-89.6, 27.6], zoom: 6.2, pitch: 50, bearing: -15 },
      select: mars?.id,
    },
    deepest && {
      kicker: 'Record depth',
      title: `${deepest.name}: ${n(deepest.water_depth_m)} m of water`,
      body: `${deepest.name} is the deepest Shell-operated host in the BOEM data. It is ${article(deepest.subtype ?? 'floating platform')} installed in ${deepest.installed ?? '—'} in ${deepest.block}, nearly ${n((deepest.water_depth_m ?? 0) / 1000, 1)} km above the seabed. For comparison, Mars sits in ${n(mars?.water_depth_m)} m.`,
      camera: { center: (atlas.assets.features.find((f) => f.properties.id === deepest.id)?.geometry.coordinates ?? [-94.9, 26.1]) as [number, number], zoom: 8.5, pitch: 60, bearing: 20 },
      select: deepest.id,
    },
    newest &&
      newest.id !== deepest?.id && {
        kicker: 'Newest hub',
        title: `${newest.name}, installed ${newest.installed}`,
        body: `${newest.name} is the newest Shell-operated host in the dataset${newestProd ? `. In ${newestProd.month} its field reported ${n(newestProd.boe)} kboe/d gross` : ''}. Its water depth is ${n(newest.water_depth_m)} m.`,
        camera: { center: (atlas.assets.features.find((f) => f.properties.id === newest.id)?.geometry.coordinates ?? [-94.7, 26.2]) as [number, number], zoom: 8.2, pitch: 55, bearing: -30 },
        select: newest.id,
      },
    {
      kicker: 'UK North Sea',
      title: 'Adura: a new shape for the UK business',
      body: `The UK regulator now lists ${adura} fields under <b>Adura Energy</b>, the 50/50 Shell–Equinor joint venture, and ${shellUk} under Shell plc, mostly mature Southern North Sea gas. Together they reported ${n(regionTotal('uk'))} kboe/d gross in ${endMonth}.`,
      camera: { center: [0.8, 56.4], zoom: 5.4, pitch: 45, bearing: 10 },
      select: 'uk-field-shearwater',
    },
    {
      kicker: 'Norway',
      title: 'Ormen Lange: gas from 900 m down',
      body: `Shell operates the all-subsea Ormen Lange field (${n((olProd?.share ?? 0) * 100, 1)}% Shell equity). It produced ${n(olProd?.gas)} MMscf/d of gas in ${olProd?.month ?? '—'}, piped to the Nyhamna plant and on to the UK. Shell also holds ${n((trollProd?.share ?? 0) * 100, 1)}% of Troll, which reported ${n(trollProd?.boe)} kboe/d gross.`,
      camera: { center: [5.6, 63.3], zoom: 6.6, pitch: 55, bearing: -25 },
      select: ol?.id,
    },
    {
      kicker: 'Energy transition',
      title: 'Rotterdam: refinery, wind and hydrogen in one view',
      body: 'Pernis, Shell’s largest European refinery, sits near Holland Hydrogen 1, a 200 MW electrolyser on Maasvlakte 2. Offshore, Hollandse Kust Noord is designed to supply it with wind power. This is the integrated low-carbon value chain in a single frame.',
      camera: { center: [4.25, 52.1], zoom: 7.6, pitch: 50, bearing: 15 },
      select: 'site-holland-hydrogen-1',
    },
    {
      kicker: 'Integrated Gas',
      title: 'Pearl GTL, Qatar',
      body: 'At Ras Laffan, Pearl turns natural gas into liquid fuels, base oils and waxes. It is the world’s largest gas-to-liquids plant.',
      camera: { center: [51.5, 25.9], zoom: 8, pitch: 45, bearing: 0 },
      select: 'site-pearl-gtl',
    },
    {
      kicker: 'Integrated Gas',
      title: 'Prelude FLNG, offshore Australia',
      body: 'Prelude is a floating facility longer than four football pitches. It liquefies gas at sea in the Browse Basin, about 475 km from the nearest town.',
      camera: { center: [123.3, -13.8], zoom: 6.5, pitch: 40, bearing: 0 },
      select: 'site-prelude',
    },
    {
      kicker: 'Integrated Gas',
      title: 'LNG Canada, Kitimat',
      body: 'Canada’s first large-scale LNG export terminal ships Canadian gas to Asian markets across the Pacific. Shell is the largest shareholder.',
      camera: { center: [-128.7, 54.0], zoom: 7.5, pitch: 50, bearing: -20 },
      select: 'site-lng-canada',
    },
    {
      kicker: 'Marketing',
      title: `${n(k.fuel_stations)} stations, one heatmap`,
      body: `OpenStreetMap volunteers have tagged ${n(k.fuel_stations)} Shell-branded fuel stations and ${n(k.ev_sites)} Shell Recharge / ubitricity charge points. Zoom in to see individual sites. Green dots are stations that advertise EV charging.`,
      camera: { center: [8, 50], zoom: 4.2, pitch: 0, bearing: 0 },
      layers: { fuel: true, ev: true },
    },
    {
      kicker: 'Your turn',
      title: 'Explore the atlas',
      body: 'Press play on the timeline to replay a decade of production. Click any installation for its history, search with <kbd>/</kbd>, and open <b>Data &amp; method</b> to see how each number was derived.',
      camera: { center: [-30, 35], zoom: 1.7, pitch: 0, bearing: 0 },
    },
  ].filter(Boolean) as TourStop[];
  return stops;
}
