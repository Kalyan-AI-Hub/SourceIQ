// src/services/riskScorer.ts — SourcingRiskIndex (SRI) calculation per country
// Score = newsRisk(30%) + tariffRisk(25%) + tradeDisruption(20%) + baselineRisk(25%)
// Note: baseline raised from original 10% to 25% because newsRisk-heavy weighting
// produced near-zero SRI for conflict countries (e.g. Iraq=9, Ukraine=8) when
// live news signals were absent. Floor rules still enforce hard minimums per country tier.
// Floor rules are data-driven — loaded from country_config table, not hardcoded.

import type { ConflictSignal, SourcingRiskIndex, RiskAlert } from '../types/index';
import type { ICountryConfigStore } from '../adapters/interfaces';
import { getCountryConfig } from '../lib/countryConfig';

function severityToScore(severity: ConflictSignal['severity']): number {
  const map = { low: 20, medium: 50, high: 75, critical: 95 };
  return map[severity];
}

function scoreToTier(score: number): SourcingRiskIndex['tier'] {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'elevated';
  return 'safe';
}

export interface RiskScorerInput {
  country: string;
  signals: ConflictSignal[];
  baselineRisk: number;          // 0-100 — from World Bank WGI or fallback JSON
  baselineSource?: 'worldbank' | 'fallback';
  tariffRate: number;            // current US tariff rate (0-100)
  doNotTravel: boolean;          // from State Dept advisory
  previousScores: number[];      // last 24h for trend calculation
  oilPriceAdj?: number;          // 0/5/10/15 — from live WTI price via Stooq
  /** Optional override — defaults to getCountryConfig() singleton if not provided. */
  config?: ICountryConfigStore;
}

export function calculateSri(input: RiskScorerInput): SourcingRiskIndex {
  const {
    country, signals, baselineRisk, baselineSource,
    tariffRate, doNotTravel, previousScores, oilPriceAdj = 0,
  } = input;

  const config = input.config ?? getCountryConfig();

  // ── newsRisk (30%): average severity of last 24h signals ──────────────
  const newsRisk = signals.length === 0
    ? 0
    : signals.reduce((sum, s) => sum + severityToScore(s.severity) * s.confidence, 0) / signals.length;

  // ── tariffRisk (25%): normalize tariff rate 0-100 ─────────────────────
  const tariffRisk = Math.min(tariffRate * 2, 100);

  // ── tradeDisruption (20%): critical/high signals count + live oil price ─
  const disruptiveCount = signals.filter(s => s.severity === 'high' || s.severity === 'critical').length;
  const tradeDisruption = Math.min(disruptiveCount * 25 + oilPriceAdj, 100);

  // ── Weighted score ─────────────────────────────────────────────────────
  let score =
    newsRisk        * 0.30 +
    tariffRisk      * 0.25 +
    tradeDisruption * 0.20 +
    baselineRisk    * 0.25;

  // ── Floor rules — data-driven from country_config table ───────────────
  let floorApplied: string | undefined;

  if (config.isActiveConflict(country) && score < 85) {
    score = 85;
    floorApplied = 'active conflict → minimum 85';
  } else if (config.isSanctioned(country) && score < 75) {
    score = 75;
    floorApplied = 'US sanctions → minimum 75';
  } else if (config.isChronicInstability(country) && score < 55) {
    score = 55;
    floorApplied = 'chronic instability → minimum 55';
  } else if (doNotTravel && score < 65) {
    score = 65;
    floorApplied = 'do-not-travel advisory → minimum 65';
  }

  score = Math.round(Math.min(100, Math.max(0, score)));

  // ── Trend ──────────────────────────────────────────────────────────────
  let trend: SourcingRiskIndex['trend'] = 'stable';
  if (previousScores.length >= 2) {
    const avg = previousScores.slice(-6).reduce((a, b) => a + b, 0) / Math.min(previousScores.length, 6);
    if (score > avg + 5) trend = 'escalating';
    else if (score < avg - 5) trend = 'de-escalating';
  }

  // ── Active alerts ──────────────────────────────────────────────────────
  const activeAlerts: RiskAlert[] = signals
    .filter(s => s.severity === 'high' || s.severity === 'critical')
    .slice(0, 5)
    .map(s => ({
      severity: s.severity,
      country: s.country,
      message: s.headline,
      source: s.url ?? s.source,
      timestamp: s.timestamp,
    }));

  return {
    country,
    countryCode: config.getIso2(country) ?? 'XX',
    score,
    tier: scoreToTier(score),
    signals: {
      newsRisk:        Math.round(newsRisk),
      tariffRisk:      Math.round(tariffRisk),
      tradeDisruption: Math.round(tradeDisruption),
      baselineRisk:    Math.round(baselineRisk),
    },
    trend,
    trendHistory: [...previousScores.slice(-23), score],
    activeAlerts,
    floorApplied,
    baselineSource: baselineSource ?? 'fallback',
    updatedAt: new Date().toISOString(),
  };
}
