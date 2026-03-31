// src/agents/dashboardAgent.ts — merges inventory + tariff + risk into unified AgentResponse
// RULE 1: depends on ITariffStore, IInventoryStore, IRiskStore interfaces only.

import type { ITariffStore, IInventoryStore, IRiskStore } from '../adapters/interfaces';
import type { AgentResponse, SourcingRecommendation, ChartData, InventoryItem } from '../types/index';
import { effectiveCost } from '../tools/costCalculator';
import { estimateAltUnitCost } from '../lib/costIndex';
import { getCountryConfig } from '../lib/countryConfig';

export class DashboardAgent {
  constructor(
    private readonly tariff: ITariffStore,
    private readonly inventory: IInventoryStore,
    private readonly risk: IRiskStore,
  ) {}

  async buildResponse(inventoryAnswer: AgentResponse, tariffAnswer: AgentResponse, userQuery?: string): Promise<AgentResponse> {
    const allItems = await this.inventory.getAll();
    const heatmapData = await this.risk.getHeatmapData();
    const allRates = await this.tariff.getAllRates();

    // Filter items to those relevant to the user's query (country or category mentions)
    const items = this.filterRelevantItems(allItems, userQuery);

    // Build cost comparison: for each item, find cheapest alternative country
    const recommendations: SourcingRecommendation[] = [];
    const chartRows: Record<string, unknown>[] = [];

    for (const item of items.slice(0, 10)) {   // top 10 for display
      const altRates = await this.tariff.compareCountries(item.hsCode);
      if (!altRates.length) continue;

      const currentRateRow = allRates.find(
        r => r.country === item.currentSourceCountry && r.hsCode === item.hsCode,
      );
      const currentRate = currentRateRow?.rate ?? 0;
      const currentCost = effectiveCost(item.unitCostUSD, currentRate);

      // Best alternative: compute realistic landed cost (manufacturing + tariff)
      const alts = altRates
        .filter(r => r.country !== item.currentSourceCountry)
        .map(r => {
          const altUnit = estimateAltUnitCost(item.unitCostUSD, item.currentSourceCountry, r.country, item.category);
          const altLanded = effectiveCost(altUnit, r.rate);
          return { ...r, altLanded };
        })
        .sort((a, b) => a.altLanded - b.altLanded);
      const best = alts[0];
      if (!best) continue;

      const savings = (currentCost - best.altLanded) * item.annualVolume;
      if (savings <= 0) continue;

      const sri = await this.risk.getSriForCountry(best.country);

      recommendations.push({
        sku: item.sku,
        currentCountry: item.currentSourceCountry,
        recommendedCountry: best.country,
        currentCostUSD: currentCost,
        recommendedCostUSD: best.altLanded,
        annualSavingsUSD: Math.round(savings),
        tariffRate: best.rate,
        riskScore: sri?.score ?? 0,
        riskAlerts: sri?.activeAlerts ?? [],
      });

      chartRows.push({
        name: item.sku,
        currentCost: Math.round(currentCost * 100) / 100,
        recommendedCost: Math.round(best.altLanded * 100) / 100,
        savings: Math.round(savings),
        currentCountry: item.currentSourceCountry,
        recommendedCountry: best.country,
      });
    }

    recommendations.sort((a, b) => b.annualSavingsUSD - a.annualSavingsUSD);

    const chartData: ChartData = {
      type: 'bar',
      title: 'Cost Comparison: Current vs Recommended Sourcing',
      data: chartRows.slice(0, 5),
    };

    const topSavings = recommendations.slice(0, 3);
    const totalSavings = recommendations.slice(0, 5).reduce((s, r) => s + r.annualSavingsUSD, 0);

    const combinedAnswer =
      (inventoryAnswer.answer || tariffAnswer.answer || '') +
      (topSavings.length
        ? `\n\nTop savings opportunities: ${topSavings.map(r => `${r.sku} → ${r.recommendedCountry} saves $${r.annualSavingsUSD.toLocaleString()}/yr`).join(', ')}.` +
          ` Total potential savings across ${Math.min(recommendations.length, 5)} items: $${totalSavings.toLocaleString()}/yr.`
        : '');

    return {
      answer: combinedAnswer,
      recommendations: recommendations.slice(0, 5),
      riskAlerts: inventoryAnswer.riskAlerts ?? tariffAnswer.riskAlerts,
      chartData,
      heatmapData,
      source: 'local',
    };
  }

  /** Filter items to those relevant to the user query (country/category mentions). Falls back to all items. */
  private filterRelevantItems(allItems: InventoryItem[], userQuery?: string): InventoryItem[] {
    if (!userQuery) return allItems;
    const lower = userQuery.toLowerCase();

    // Check for country mentions
    const config = getCountryConfig();
    const mentionedCountries = config.getAllCountryNames().filter(c => lower.includes(c.toLowerCase()));

    // Check for category mentions
    const CATEGORIES: InventoryItem['category'][] = ['Electronics', 'Apparel', 'Home', 'Toys', 'Food'];
    const mentionedCategories = CATEGORIES.filter(c => lower.includes(c.toLowerCase()));

    let filtered = allItems;
    if (mentionedCountries.length) {
      filtered = filtered.filter(i => mentionedCountries.includes(i.currentSourceCountry));
    }
    if (mentionedCategories.length) {
      filtered = filtered.filter(i => mentionedCategories.includes(i.category));
    }

    // Fall back to all items if filter is too aggressive
    return filtered.length > 0 ? filtered : allItems;
  }
}
