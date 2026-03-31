// app/api/commodities/route.ts — live commodity prices + forex rates for the UI ticker
// Fetches WTI, Brent, BDI, cotton, copper from Stooq (1h cache in commodityFetcher)
// Fetches USD/CNY, USD/EUR, USD/INR, USD/VND, USD/MXN from frankfurter.app (1h cache)

import { NextResponse } from 'next/server';
import { fetchOilPrices, fetchShippingIndex, fetchCommodityPrices } from '../../../src/tools/commodityFetcher';
import { cache, TTL, SWR } from '../../../src/lib/cache';

export const runtime = 'nodejs';
export const revalidate = 0;

const FX_CURRENCIES = ['CNY', 'EUR', 'INR', 'VND', 'MXN', 'BDT', 'IDR'];
const FX_CACHE_KEY = 'commodities:fx';

const FALLBACK_FX: Record<string, number> = {
  CNY: 7.24, EUR: 0.92, INR: 83.45, VND: 25435, MXN: 17.15, BDT: 110.50, IDR: 15875,
};

async function fetchKeyFxRates(): Promise<Record<string, number>> {
  return cache.getOrCompute(
    FX_CACHE_KEY,
    async () => {
      const res = await fetch(
        `https://api.frankfurter.app/latest?from=USD&to=${FX_CURRENCIES.join(',')}`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { rates: Record<string, number> };
      return json.rates;
    },
    { ttlMs: TTL.LONG, swrMs: SWR.LONG, tags: ['market'] },
  ).catch(() => {
    console.log('[Commodities] FX API down, using fallback rates');
    return FALLBACK_FX;
  });
}

export async function GET() {
  try {
    const [oil, shipping, commodities, fxResult] = await Promise.allSettled([
      fetchOilPrices(),
      fetchShippingIndex(),
      fetchCommodityPrices(),
      fetchKeyFxRates(),
    ]);

    return NextResponse.json({
      oil:         oil.status         === 'fulfilled' ? oil.value         : null,
      shipping:    shipping.status    === 'fulfilled' ? shipping.value    : null,
      commodities: commodities.status === 'fulfilled' ? commodities.value : null,
      forex:       fxResult.status    === 'fulfilled' ? fxResult.value    : null,
      fetchedAt:   Date.now(),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
