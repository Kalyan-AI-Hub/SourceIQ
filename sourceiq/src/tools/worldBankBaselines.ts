// src/tools/worldBankBaselines.ts — live country risk baselines from World Bank Governance Indicators
// ISO2 codes and WB-override values come from country_config DB table — no hardcoded maps.
// Source: World Bank Worldwide Governance Indicators (WGI) — free, no API key, updated annually
//
// Indicators used:
//   PV.EST — Political Stability & Absence of Violence/Terrorism  (-2.5 → +2.5)
//   RL.EST — Rule of Law                                          (-2.5 → +2.5)
//   CC.EST — Control of Corruption                               (-2.5 → +2.5)
//
// Conversion: riskScore = clamp(round((2.5 - avg) / 5 * 100), 5, 95)

import { getCountryConfig } from '../lib/countryConfig';

const WB_BASE = 'https://api.worldbank.org/v2/country';
const INDICATORS = ['PV.EST', 'RL.EST', 'CC.EST'];
const TTL_MS = 24 * 60 * 60 * 1000; // 24h — WB data is annual

let cache: { baselines: Record<string, number>; fetchedAt: number } | null = null;

async function fetchIndicator(iso2: string, indicator: string): Promise<number | null> {
  try {
    const url = `${WB_BASE}/${iso2}/indicator/${indicator}?format=json&mrv=1&per_page=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = await res.json() as [unknown, Array<{ value: number | null }>];
    return json[1]?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function fetchCountryBaseline(country: string, iso2: string): Promise<number | null> {
  const values = await Promise.all(INDICATORS.map(ind => fetchIndicator(iso2, ind)));
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;

  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const risk = Math.round((2.5 - avg) / 5 * 100);
  return Math.min(95, Math.max(5, risk));
}

/** Fetch live baselines for all monitored countries from World Bank.
 *  Returns cached result if less than 24h old. */
export async function fetchWorldBankBaselines(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return cache.baselines;
  }

  const config = getCountryConfig();
  const iso2Map = config.getIso2Map();
  const countries = Object.keys(iso2Map);

  console.log(`[WorldBankBaselines] Fetching live governance data for ${countries.length} countries...`);

  // Seed with DB-configured overrides (countries WB doesn't cover: Taiwan, Gaza)
  const baselines: Record<string, number> = {};
  for (const row of config.getAll()) {
    if (row.riskScoreOverride !== null) {
      baselines[row.name] = row.riskScoreOverride;
    }
  }

  for (const country of countries) {
    const score = await fetchCountryBaseline(country, iso2Map[country]!);
    if (score !== null) {
      baselines[country] = score;
      console.log(`[WorldBankBaselines] ${country}: ${score}/100 (from WB governance indicators)`);
    } else {
      console.warn(`[WorldBankBaselines] ${country}: no WB data — will fall back to conflict-baseline.json`);
    }
  }

  cache = { baselines, fetchedAt: Date.now() };
  console.log(`[WorldBankBaselines] Done — ${Object.keys(baselines).length} countries scored from live data`);
  return baselines;
}

/** Returns a single country's baseline, from cache if available. */
export async function getBaselineForCountry(country: string): Promise<number | null> {
  const all = await fetchWorldBankBaselines();
  return all[country] ?? null;
}
