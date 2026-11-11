// Types + loaders for the bundle written by the Python pipeline (web/public/data).
import type { FeatureCollection, Point, Polygon, MultiPolygon, LineString } from 'geojson';

export type Stake = 'operated' | 'jv' | 'partner';
export type Region = 'gom' | 'uk' | 'no' | 'global';

export interface AssetProps {
  id: string;
  name: string;
  kind: string;
  subtype?: string;
  region: Region;
  country?: string;
  operator?: string;
  stake: Stake;
  status?: string;
  water_depth_m?: number;
  installed?: number;
  block?: string;
  field?: string;
  series?: string;
  featured?: boolean;
  curated?: boolean;
  summary?: string;
  hydrocarbon?: string;
  discovered?: string | number;
  first_production?: string;
  shell_equity?: number;
  adura_equity?: number;
  licensees?: { name: string; equity: number | null }[];
  center?: [number, number];
  source: string;
  url?: string;
  system?: string;
}

export interface LineProps {
  id: string;
  name?: string;
  region: Region;
  stake: Stake;
  product?: string;
  status?: string;
  size_in?: number | string;
  route?: string;
  length_km: number;
  source: string;
}

export interface SeriesData {
  name: string;
  region: Region;
  stake: Stake;
  share: number | null;
  start: number;
  oil: number[];
  gas: number[];
}

export interface Production {
  months: string[];
  units: Record<string, string>;
  latest: Partial<Record<Region, string>>;
  series: Record<string, SeriesData>;
  totals: Record<string, { gross: number[]; net: number[] }>;
}

export interface SourceMeta {
  key: string;
  title: string;
  publisher: string;
  url: string;
  license: string;
  counts: Record<string, number>;
  notes: string[];
  state: 'fresh' | 'snapshot' | 'stale' | 'missing';
  fetched_at?: string;
  error?: string;
}

/** A Gulf hub with wells below it. The paths themselves are in wells.json, loaded when a dive opens. */
export interface SubseaSummary {
  wells: number;
  surveyed: number;
  deepest_tvd_m: number;
  drilled_m: number;
}

export interface Manifest {
  generated_at: string;
  regions: Record<Region, string>;
  kpis: {
    assets: number;
    fields: number;
    countries: number;
    pipeline_km: number;
    fuel_stations: number;
    ev_sites: number;
    production: Partial<Record<Region, { month: string; operated_gross: number; partner_gross: number | null; net: number | null }>>;
  };
  /** hub asset id → summary; absent in bundles built before the subsea view */
  subsea?: Record<string, SubseaSummary>;
  sources: SourceMeta[];
}

export interface Retail {
  fuel: [number, number, number][];
  ev: [number, number, number][];
}

export interface Atlas {
  manifest: Manifest;
  assets: FeatureCollection<Point, AssetProps>;
  fields: FeatureCollection<Polygon | MultiPolygon, AssetProps>;
  pipelines: FeatureCollection<LineString, LineProps>;
  production: Production;
  retail: Retail;
}

const BASE = `${import.meta.env.BASE_URL}data/`;

async function get<T>(name: string): Promise<T> {
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`Failed to load ${name}: ${r.status}`);
  return r.json() as Promise<T>;
}

export async function loadAtlas(): Promise<Atlas> {
  const [manifest, assets, fields, pipelines, production, retail] = await Promise.all([
    get<Manifest>('manifest.json'),
    get<Atlas['assets']>('assets.geojson'),
    get<Atlas['fields']>('fields.geojson'),
    get<Atlas['pipelines']>('pipelines.geojson'),
    get<Production>('production.json'),
    get<Retail>('retail.json'),
  ]);
  return { manifest, assets, fields, pipelines, production, retail };
}

// --- production helpers ------------------------------------------------------------
export const GAS_PER_BOE = 5.8; // MMscf/d per kboe/d

export function seriesAt(s: SeriesData | undefined, monthIdx: number): { oil: number; gas: number; boe: number } | null {
  if (!s) return null;
  const i = monthIdx - s.start;
  if (i < 0 || i >= s.oil.length) return null;
  const oil = s.oil[i];
  const gas = s.gas[i];
  return { oil, gas, boe: oil + gas / GAS_PER_BOE };
}

/** Index of the last month with any non-zero value, so "latest" means latest reported. */
export function lastReported(s: SeriesData): number {
  for (let i = s.oil.length - 1; i >= 0; i--) if (s.oil[i] || s.gas[i]) return s.start + i;
  return s.start;
}

// --- taxonomy ----------------------------------------------------------------------
export const SEGMENTS = {
  upstream: { label: 'Upstream', color: '#ffb703' },
  gas: { label: 'Integrated Gas', color: '#4cc9f0' },
  downstream: { label: 'Downstream & Chemicals', color: '#ff5d8f' },
  lowcarbon: { label: 'Low-carbon', color: '#80ed99' },
  corporate: { label: 'Corporate & R&D', color: '#c8b6ff' },
} as const;
export type Segment = keyof typeof SEGMENTS;

export function segmentOf(kind: string): Segment {
  if (['lng', 'gtl', 'gas-plant'].includes(kind)) return 'gas';
  if (['refinery', 'chemicals'].includes(kind)) return 'downstream';
  if (['wind', 'hydrogen', 'ccs'].includes(kind)) return 'lowcarbon';
  if (['office', 'research'].includes(kind)) return 'corporate';
  return 'upstream';
}

export const KIND_LABEL: Record<string, string> = {
  platform: 'Offshore installation',
  subsea: 'Subsea installation',
  field: 'Oil & gas field',
  fpso: 'FPSO',
  lng: 'LNG plant',
  gtl: 'Gas-to-liquids plant',
  'gas-plant': 'Gas processing plant',
  refinery: 'Refinery / energy & chemicals park',
  chemicals: 'Chemicals plant',
  wind: 'Offshore wind farm',
  hydrogen: 'Hydrogen',
  ccs: 'Carbon capture & storage',
  office: 'Headquarters',
  research: 'Technology centre',
};

export const STAKE_LABEL: Record<Stake, string> = {
  operated: 'Shell-operated',
  jv: 'Joint venture',
  partner: 'Shell partner',
};
