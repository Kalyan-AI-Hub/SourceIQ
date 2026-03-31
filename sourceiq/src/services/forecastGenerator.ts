// src/services/forecastGenerator.ts — deterministic supply chain forecast scoring
// Probabilities derived from SRI signal breakdown + trend history.
// No LLM per forecast (too slow) — LLM only for World Brief summary.

import type { SourcingRiskIndex, Forecast, ForecastCategory } from '../types/index';

const COUNTRY_REGION: Record<string, string> = {
  China: 'East Asia', Vietnam: 'Southeast Asia', India: 'South Asia',
  Mexico: 'North America', Bangladesh: 'South Asia', Cambodia: 'Southeast Asia',
  Indonesia: 'Southeast Asia', Turkey: 'Middle East', Morocco: 'North Africa',
  Brazil: 'South America', Yemen: 'Middle East', Sudan: 'Africa',
  Myanmar: 'Southeast Asia', Iraq: 'Middle East', Iran: 'Middle East',
  Russia: 'Europe', Libya: 'North Africa', Somalia: 'Africa',
  Ukraine: 'Europe', Taiwan: 'East Asia',
};

function clamp(v: number): number {
  return Math.min(0.99, Math.max(0.05, v));
}

function trendMultiplier(trend: SourcingRiskIndex['trend'], horizon: '24h' | '7d' | '30d'): number {
  if (trend === 'escalating')    return horizon === '24h' ? 0.95 : horizon === '7d' ? 1.05 : 1.18;
  if (trend === 'de-escalating') return horizon === '24h' ? 1.00 : horizon === '7d' ? 0.92 : 0.82;
  return 1.0;
}

function buildForecasts(sri: SourcingRiskIndex): Forecast[] {
  const forecasts: Forecast[] = [];
  const base = sri.score / 100;
  const now = new Date().toISOString();
  const region = COUNTRY_REGION[sri.country] ?? 'Global';

  // ── Conflict / geopolitical risk ─────────────────────────────────────
  if (sri.score >= 50) {
    const p = clamp(base * 0.9);
    forecasts.push({
      id:          `${sri.country}-conflict`,
      category:    'conflict',
      country:     sri.country,
      region,
      title:       `${sri.country} geopolitical escalation risk`,
      probability: p,
      projections: {
        h24: clamp(p * trendMultiplier(sri.trend, '24h')),
        d7:  clamp(p * trendMultiplier(sri.trend, '7d')),
        d30: clamp(p * trendMultiplier(sri.trend, '30d')),
      },
      trend:     sri.trend,
      updatedAt: now,
    });
  }

  // ── Tariff risk ───────────────────────────────────────────────────────
  if (sri.signals.tariffRisk >= 20) {
    const p = clamp(sri.signals.tariffRisk / 100);
    forecasts.push({
      id:          `${sri.country}-tariff`,
      category:    'tariff',
      country:     sri.country,
      region,
      title:       `${sri.country} tariff increase probability`,
      probability: p,
      projections: {
        h24: clamp(p * 0.85),
        d7:  clamp(p),
        d30: clamp(p * trendMultiplier(sri.trend, '30d')),
      },
      trend:     sri.trend,
      updatedAt: now,
    });
  }

  // ── Supply chain disruption ───────────────────────────────────────────
  if (sri.signals.tradeDisruption >= 20 || (sri.signals.newsRisk >= 30 && sri.score >= 55)) {
    const p = clamp((sri.signals.tradeDisruption + sri.signals.newsRisk) / 200);
    forecasts.push({
      id:          `${sri.country}-supply-chain`,
      category:    'supply-chain',
      country:     sri.country,
      region,
      title:       `${sri.country} supply chain disruption`,
      probability: p,
      projections: {
        h24: clamp(p * trendMultiplier(sri.trend, '24h')),
        d7:  clamp(p * trendMultiplier(sri.trend, '7d')),
        d30: clamp(p * trendMultiplier(sri.trend, '30d')),
      },
      trend:     sri.trend,
      updatedAt: now,
    });
  }

  // ── Port / logistics risk (high-trade countries with elevated scores) ──
  const PORT_COUNTRIES = new Set(['China', 'Vietnam', 'Bangladesh', 'Indonesia', 'Turkey', 'Yemen', 'Somalia']);
  if (PORT_COUNTRIES.has(sri.country) && sri.score >= 45) {
    const p = clamp(base * 0.75);
    forecasts.push({
      id:          `${sri.country}-port`,
      category:    'port',
      country:     sri.country,
      region,
      title:       `${sri.country} port/logistics disruption`,
      probability: p,
      projections: {
        h24: clamp(p * 0.88),
        d7:  clamp(p),
        d30: clamp(p * trendMultiplier(sri.trend, '30d')),
      },
      trend:     sri.trend,
      updatedAt: now,
    });
  }

  return forecasts;
}

/** Generate forecasts for all countries, sorted by probability DESC */
export function generateForecasts(
  allSri: SourcingRiskIndex[],
  category?: ForecastCategory,
): Forecast[] {
  const all = allSri.flatMap(buildForecasts);
  const filtered = category ? all.filter(f => f.category === category) : all;
  return filtered
    .filter(f => f.probability >= 0.15)           // hide trivial forecasts
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 20);
}
