// src/tools/whatIfSimulator.ts — Innovation 1: What-If Tariff Simulator
// Simulates the cost impact of a hypothetical tariff rate change for a given country.

import { effectiveCost } from './costCalculator';
import { estimateAltUnitCost } from '../lib/costIndex';
import type { IInventoryStore, ITariffStore } from '../adapters/interfaces';
import type { WhatIfScenario, SourcingRecommendation } from '../types/index';

export async function simulateTariff(
  country: string,
  hypotheticalRate: number,
  inventory: IInventoryStore,
  tariff: ITariffStore,
): Promise<WhatIfScenario> {
  const items = await inventory.getByCountry(country);

  const results = await Promise.all(
    items.map(async item => {
      const currentRateRow = await tariff.getRate(country, item.hsCode);
      const currentRate = currentRateRow?.rate ?? 0;
      const currentCost = effectiveCost(item.unitCostUSD, currentRate);
      const newCost = effectiveCost(item.unitCostUSD, hypotheticalRate);
      const impact = (newCost - currentCost) * item.annualVolume;

      // Find alternatives — compare realistic landed costs (manufacturing + tariff)
      const altRates = await tariff.compareCountries(item.hsCode);
      const alternatives = altRates
        .filter(r => r.country !== country)
        .map(r => {
          const altUnitCost = estimateAltUnitCost(item.unitCostUSD, country, r.country, item.category);
          const altLandedCost = effectiveCost(altUnitCost, r.rate);
          return { ...r, altUnitCost, altLandedCost };
        })
        .sort((a, b) => a.altLandedCost - b.altLandedCost);
      const best = alternatives[0];

      // Tipping point: the hypothetical rate at which switching to `best` becomes cheaper.
      // Solve: item.unitCostUSD * (1 + tp/100) = best.altLandedCost
      // => tp = (best.altLandedCost / item.unitCostUSD - 1) * 100
      const tippingPointRate = best
        ? Math.round((best.altLandedCost / item.unitCostUSD - 1) * 100)
        : null;

      return { item, currentRate, currentCost, newCost, impact, best, tippingPointRate };
    }),
  );

  const totalImpact = results.reduce((sum, r) => sum + r.impact, 0);
  const affectedSkus = results.filter(r => Math.abs(r.impact) > 0).map(r => r.item.sku);

  const recommendations: SourcingRecommendation[] = results
    .filter(r => r.best && r.impact > 0)  // only suggest switch if new rate increases cost
    .map(r => {
      const rec = r.best!;
      return {
        sku: r.item.sku,
        currentCountry: country,
        recommendedCountry: rec.country,
        tippingPointRate: r.tippingPointRate ?? undefined,
        currentCostUSD: r.newCost,                    // cost under hypothetical rate
        recommendedCostUSD: rec.altLandedCost,        // realistic alternative landed cost
        annualSavingsUSD: Math.round((r.newCost - rec.altLandedCost) * r.item.annualVolume),
        tariffRate: rec.rate,
        riskScore: 0,                       // enriched by caller if needed
        riskAlerts: [],
      };
    })
    .filter(r => r.annualSavingsUSD > 0)
    .sort((a, b) => b.annualSavingsUSD - a.annualSavingsUSD);

  return {
    country,
    hypotheticalTariffRate: hypotheticalRate,
    affectedSkus,
    totalPortfolioImpactUSD: Math.round(totalImpact),
    recommendations,
  };
}
