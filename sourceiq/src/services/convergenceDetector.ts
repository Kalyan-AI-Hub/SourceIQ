// src/services/convergenceDetector.ts — multi-domain signal convergence detection
// Inspired by WorldMonitor's correlation engine.
// A convergence is when 2+ risk dimensions spike simultaneously for a country,
// signalling a compound threat greater than any single signal alone.

import type { SourcingRiskIndex, ConvergenceCard } from '../types/index';

// Thresholds: what counts as "elevated" per signal dimension
const THRESHOLDS = {
  newsRisk:        35,
  tariffRisk:      30,
  tradeDisruption: 25,
  baselineRisk:    55,
};

// Bonus points for 'escalating' trend or critical tier
const ESCALATING_BONUS = 15;
const CRITICAL_TIER_BONUS = 20;
// Each additional elevated dimension beyond the minimum 2 adds 10 points.
// This prevents high-baseline 2-dim countries from outranking 4-dim convergences.
const DIM_COUNT_BONUS = 10;

function elevatedDimensions(signals: SourcingRiskIndex['signals']): string[] {
  const dims: string[] = [];
  if (signals.newsRisk        >= THRESHOLDS.newsRisk)        dims.push(`news:${signals.newsRisk}`);
  if (signals.tariffRisk      >= THRESHOLDS.tariffRisk)      dims.push(`tariff:${signals.tariffRisk}`);
  if (signals.tradeDisruption >= THRESHOLDS.tradeDisruption) dims.push(`disruption:${signals.tradeDisruption}`);
  if (signals.baselineRisk    >= THRESHOLDS.baselineRisk)    dims.push(`baseline:${signals.baselineRisk}`);
  return dims;
}

function convergenceSeverity(dims: number, score: number): ConvergenceCard['severity'] {
  if (dims >= 4 || score >= 75) return 'critical';  // 4-domain always critical
  if (dims >= 3 || score >= 65) return 'critical';  // 3-domain or high score = critical
  if (dims === 2 && score >= 55) return 'high';
  return 'medium';
}

export function detectConvergence(
  allSri: SourcingRiskIndex[],
  inventoryCountries: Set<string>,
): ConvergenceCard[] {
  const cards: ConvergenceCard[] = [];

  for (const sri of allSri) {
    const dims = elevatedDimensions(sri.signals);
    if (dims.length < 2) continue; // need 2+ elevated dimensions

    // Convergence score: average of elevated dimension values + dim-count bonus + tier bonuses.
    // DIM_COUNT_BONUS ensures a 4-domain convergence always outranks a 2-domain one
    // even when the 2-domain country has higher individual signal values (e.g. high baseline).
    const avgDimScore =
      dims
        .map(d => parseInt(d.split(':')[1] ?? '0', 10))
        .reduce((a, b) => a + b, 0) / dims.length;

    let score = Math.round(avgDimScore) + (dims.length - 2) * DIM_COUNT_BONUS;
    if (sri.trend === 'escalating') score = Math.min(100, score + ESCALATING_BONUS);
    if (sri.tier === 'critical')    score = Math.min(100, score + CRITICAL_TIER_BONUS);
    score = Math.min(100, score);

    const severity = convergenceSeverity(dims.length, score);

    // Only surface medium convergence for countries we actually source from
    if (severity === 'medium' && !inventoryCountries.has(sri.country)) continue;

    const tariffSignal = sri.signals.tariffRisk >= THRESHOLDS.tariffRisk;
    const newsSignal   = sri.signals.newsRisk   >= THRESHOLDS.newsRisk;
    const distrSignal  = sri.signals.tradeDisruption >= THRESHOLDS.tradeDisruption;

    const reasons: string[] = [];
    if (newsSignal)   reasons.push('live conflict signals');
    if (tariffSignal) reasons.push(`${sri.signals.tariffRisk}% tariff risk`);
    if (distrSignal)  reasons.push('trade disruption events');
    if (sri.trend === 'escalating') reasons.push('escalating trend');

    cards.push({
      country:     sri.country,
      countryCode: sri.countryCode,
      score,
      severity,
      title:   `${sri.country}: ${dims.length}-domain convergence`,
      signals: dims,
      detectedAt: new Date().toISOString(),
    });
  }

  // Sort by score DESC, cap at 5 cards
  return cards.sort((a, b) => b.score - a.score).slice(0, 5);
}
