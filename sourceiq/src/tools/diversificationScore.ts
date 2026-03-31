// src/tools/diversificationScore.ts — Innovation 2: Diversification Health Score
// Measures supply-chain concentration risk across countries.

import { effectiveCost } from './costCalculator';
import type { IInventoryStore, ITariffStore, IRiskStore } from '../adapters/interfaces';
import type { DiversificationHealth } from '../types/index';

export async function calculateDiversification(
  inventory: IInventoryStore,
  tariff: ITariffStore,
  risk: IRiskStore,
): Promise<DiversificationHealth> {
  const items = await inventory.getAll();
  const allRates = await tariff.getAllRates();

  // Build a rate lookup map for O(1) access
  const rateMap = new Map<string, number>();
  for (const r of allRates) rateMap.set(`${r.country}|${r.hsCode}`, r.rate);

  // Calculate annual spend per country
  const spendByCountry = new Map<string, number>();
  let totalSpend = 0;

  for (const item of items) {
    const rate = rateMap.get(`${item.currentSourceCountry}|${item.hsCode}`) ?? 0;
    const cost = effectiveCost(item.unitCostUSD, rate) * item.annualVolume;
    spendByCountry.set(
      item.currentSourceCountry,
      (spendByCountry.get(item.currentSourceCountry) ?? 0) + cost,
    );
    totalSpend += cost;
  }

  if (totalSpend === 0) {
    return {
      overallScore: 100,
      concentrationWarnings: [],
      countryBreakdown: [],
      recommendedActions: ['Add inventory items to calculate diversification score.'],
    };
  }

  // Fetch SRI scores for risk-adjusted penalties
  const countries = Array.from(spendByCountry.keys());
  const sriResults = await Promise.all(countries.map(c => risk.getSriForCountry(c)));
  const sriMap = new Map(countries.map((c, i) => [c, sriResults[i]]));

  // Concentration warnings
  const warnings: DiversificationHealth['concentrationWarnings'] = [];
  let maxRiskAdjustedConcentration = 0;

  for (const [country, spend] of Array.from(spendByCountry.entries())) {
    const pct = (spend / totalSpend) * 100;
    const sri = sriMap.get(country);
    const riskPenalty = sri ? (sri.score / 100) : 0.1;
    const riskAdjusted = pct * (1 + riskPenalty);

    if (riskAdjusted > maxRiskAdjustedConcentration) {
      maxRiskAdjustedConcentration = riskAdjusted;
    }

    let severity: 'low' | 'medium' | 'high' | 'critical';
    if (pct > 50) severity = 'critical';
    else if (pct > 30) severity = 'high';
    else if (pct > 20) severity = 'medium';
    else severity = 'low';

    if (pct > 20) {
      warnings.push({ country, percentage: Math.round(pct * 10) / 10, severity });
    }
  }

  warnings.sort((a, b) => b.percentage - a.percentage);

  const overallScore = Math.max(0, Math.min(100, Math.round(100 - maxRiskAdjustedConcentration)));

  const recommendedActions: string[] = [];
  if (overallScore < 40) {
    recommendedActions.push('CRITICAL: Immediately diversify away from high-concentration countries.');
  }
  if (overallScore < 70) {
    recommendedActions.push('Identify alternative suppliers in lower-risk regions.');
    recommendedActions.push('Evaluate USMCA/CPTPP partner countries for tariff-free sourcing.');
  }
  for (const w of warnings) {
    if (w.severity === 'critical' || w.severity === 'high') {
      recommendedActions.push(`Reduce ${w.country} concentration (currently ${w.percentage}% of spend).`);
    }
  }
  if (recommendedActions.length === 0) {
    recommendedActions.push('Supply chain diversification is healthy. Continue monitoring.');
  }

  const countryBreakdown = Array.from(spendByCountry.entries())
    .map(([country, spend]) => ({
      country,
      percentage: Math.round((spend / totalSpend) * 1000) / 10,
      annualSpendUSD: Math.round(spend),
    }))
    .sort((a, b) => b.percentage - a.percentage);

  return { overallScore, concentrationWarnings: warnings, countryBreakdown, recommendedActions };
}
