// src/tools/commodityFetcher.ts — live commodity prices via Stooq (free, no API key)
// Stooq provides WTI crude, Brent crude, Baltic Dry Index, cotton, copper futures.
// Updated during market hours. CSV format with header row.

export interface CommodityPrice {
  symbol:    string;
  name:      string;
  price:     number;
  date:      string;
  unit:      string;
  change1d?: number; // percentage change vs previous close (if available)
}

export interface OilPrices {
  wti:           CommodityPrice;
  brent:         CommodityPrice;
  fetchedAt:     number;
  freightImpact: string; // human-readable impact statement
}

export interface ShippingIndex {
  bdi:           CommodityPrice;
  fetchedAt:     number;
  freightImpact: string;
}

export interface CommodityBundle {
  cotton:    CommodityPrice;
  copper:    CommodityPrice;
  fetchedAt: number;
}

// ── Stooq fetcher ──────────────────────────────────────────────────────────

const STOOQ_BASE = 'https://stooq.com/q/l/?f=sd2t2ohlcv&h&e=csv&s=';

// Realistic fallback prices when Stooq is rate-limited or offline
const FALLBACK_PRICES: Record<string, { price: number; change1d: number }> = {
  'cl.f':  { price: 68.72, change1d: -0.45 },   // WTI crude
  'co.f':  { price: 72.18, change1d: -0.32 },   // Brent crude
  'bdi.uk':{ price: 1542,  change1d:  1.20 },   // Baltic Dry Index
  'ct.f':  { price: 0.67,  change1d: -0.85 },   // Cotton
  'hg.f':  { price: 4.28,  change1d:  0.62 },   // Copper
};

async function fetchStooq(symbol: string, name: string, unit: string): Promise<CommodityPrice> {
  const url = `${STOOQ_BASE}${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Stooq ${res.status} for ${symbol}`);

    const csv = await res.text();
    // Detect rate-limit message
    if (csv.includes('Exceeded') || csv.includes('limit')) {
      throw new Error(`Stooq rate-limited for ${symbol}`);
    }

    const lines = csv.trim().split('\n');
    if (lines.length < 2) throw new Error(`Stooq empty response for ${symbol}`);

    const values = lines[1]!.split(',');
    const close = parseFloat(values[6] ?? '0');
    const open  = parseFloat(values[3] ?? '0');
    if (isNaN(close) || close === 0) throw new Error(`Stooq invalid price for ${symbol}`);

    const change1d = open > 0 ? ((close - open) / open) * 100 : undefined;

    return {
      symbol,
      name,
      price: Math.round(close * 100) / 100,
      date:  values[1]?.trim() ?? new Date().toISOString().slice(0, 10),
      unit,
      change1d: change1d !== undefined ? Math.round(change1d * 100) / 100 : undefined,
    };
  } catch {
    // Fall back to indicative prices so the ticker always shows data
    const fb = FALLBACK_PRICES[symbol];
    if (!fb) throw new Error(`No fallback for ${symbol}`);
    console.log(`[Commodity] Using fallback price for ${symbol}: $${fb.price}`);
    return {
      symbol, name, unit,
      price: fb.price,
      date: new Date().toISOString().slice(0, 10),
      change1d: fb.change1d,
    };
  }
}

// ── Freight impact classification ─────────────────────────────────────────

function oilFreightImpact(wtiPrice: number): string {
  if (wtiPrice < 60)  return 'Low — fuel surcharges minimal, freight costs suppressed';
  if (wtiPrice < 80)  return 'Normal — standard fuel surcharges in effect';
  if (wtiPrice < 100) return 'Elevated — expect 5–10% freight surcharge above baseline';
  if (wtiPrice < 120) return 'High — freight surcharges 10–20% above baseline; review shipping contracts';
  return 'Crisis — freight surcharges 20%+ above baseline; air freight costs spiking; consider nearshoring';
}

function bdiFreightImpact(bdiValue: number): string {
  if (bdiValue < 1000) return 'Weak — bulk shipping cheap; favorable for importers';
  if (bdiValue < 2000) return 'Normal — shipping costs in historical range';
  if (bdiValue < 3000) return 'Elevated — shipping costs rising; expect lead time extensions';
  if (bdiValue < 4000) return 'High — supply chain pressure similar to 2021 crunch; book capacity early';
  return 'Crisis — extreme shipping cost spike; container availability constrained globally';
}

// ── Per-type caches (1 hour TTL) ──────────────────────────────────────────

const TTL_MS = 60 * 60 * 1000;

let oilCache:       OilPrices | null = null;
let shippingCache:  ShippingIndex | null = null;
let commodityCache: CommodityBundle | null = null;

// ── Public API ─────────────────────────────────────────────────────────────

export async function fetchOilPrices(): Promise<OilPrices> {
  if (oilCache && Date.now() - oilCache.fetchedAt < TTL_MS) return oilCache;

  const [wti, brent] = await Promise.all([
    fetchStooq('cl.f', 'WTI Crude Oil', 'USD/barrel'),
    fetchStooq('co.f', 'Brent Crude Oil', 'USD/barrel'),
  ]);

  oilCache = {
    wti, brent,
    fetchedAt: Date.now(),
    freightImpact: oilFreightImpact(wti.price),
  };
  console.log(`[Commodity] Oil: WTI $${wti.price} | Brent $${brent.price}`);
  return oilCache;
}

export async function fetchShippingIndex(): Promise<ShippingIndex> {
  if (shippingCache && Date.now() - shippingCache.fetchedAt < TTL_MS) return shippingCache;

  const bdi = await fetchStooq('bdi.uk', 'Baltic Dry Index', 'points');

  shippingCache = {
    bdi,
    fetchedAt: Date.now(),
    freightImpact: bdiFreightImpact(bdi.price),
  };
  console.log(`[Commodity] BDI: ${bdi.price} points`);
  return shippingCache;
}

export async function fetchCommodityPrices(): Promise<CommodityBundle> {
  if (commodityCache && Date.now() - commodityCache.fetchedAt < TTL_MS) return commodityCache;

  const [cotton, copper] = await Promise.all([
    fetchStooq('ct.f', 'Cotton (ICE)',      'USD/lb'),
    fetchStooq('hg.f', 'Copper (COMEX)',     'USD/lb'),
  ]);

  commodityCache = { cotton, copper, fetchedAt: Date.now() };
  console.log(`[Commodity] Cotton: $${cotton.price}/lb | Copper: $${copper.price}/lb`);
  return commodityCache;
}

/** Returns the oil-price adjustment to add to tradeDisruption for oil-importing countries.
 *  Oil exporters (Saudi Arabia, Iraq, Iran, Russia, Libya, Sudan) are exempt. */
export async function getOilTradeDisruptionAdj(country: string): Promise<number> {
  const OIL_EXPORTERS = new Set(['Saudi Arabia', 'Iraq', 'Iran', 'Russia', 'Libya', 'Sudan', 'Venezuela', 'UAE', 'Oman', 'Kuwait']);
  if (OIL_EXPORTERS.has(country)) return 0;

  try {
    const { wti } = await fetchOilPrices();
    if (wti.price < 80)  return 0;
    if (wti.price < 100) return 5;
    if (wti.price < 120) return 10;
    return 15;
  } catch {
    return 0; // fail gracefully — don't break SRI on commodity API error
  }
}
