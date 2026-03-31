// src/tools/exchangeRateFetcher.ts — live USD FX rates via frankfurter.app
// Currency list is derived from country_config DB table — no hardcoded maps.
// Free, no API key, updated daily by ECB. Graceful fallback on network failure.

import { getCountryConfig } from '../lib/countryConfig';

// Currencies not published by ECB (API technical constraint — returns 422 if included).
// This is an API quirk, not business data — intentionally kept here rather than in the DB.
const ECB_UNAVAILABLE = new Set(['IRR']); // Iranian Rial — not published by ECB

// Cache rates for 1 hour — avoid hammering the API on every what-if request
let cached: { rates: Record<string, number>; fetchedAt: number } | null = null;
const TTL_MS = 60 * 60 * 1000;

// Realistic indicative FX rates when frankfurter.app is down
const FALLBACK_FX: Record<string, number> = {
  CNY: 7.24, EUR: 0.92, INR: 83.45, VND: 25435, MXN: 17.15,
  BDT: 110.50, IDR: 15875, TRY: 32.85, MAD: 10.05, BRL: 5.12,
  JOD: 0.71, OMR: 0.385, QAR: 3.64, SAR: 3.75, AED: 3.67,
  EGP: 48.50, KHR: 4095,
};

export async function fetchFxRates(): Promise<Record<string, number>> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.rates;
  }

  // Build currency list from DB — excludes ECB-unavailable codes to prevent 422 errors
  const currencyMap = getCountryConfig().getCurrencyMap();
  const currencies = Array.from(new Set(Object.values(currencyMap)))
    .filter(c => !ECB_UNAVAILABLE.has(c))
    .join(',');

  if (!currencies) return FALLBACK_FX;

  const endpoint = `https://api.frankfurter.app/latest?from=USD&to=${currencies}`;

  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json() as { rates: Record<string, number> };
    cached = { rates: json.rates, fetchedAt: Date.now() };
    return json.rates;
  } catch (err) {
    console.warn('[FxRates] Live rates unavailable, using fallback:', (err as Error).message);
    return FALLBACK_FX;
  }
}
