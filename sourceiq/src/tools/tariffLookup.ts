// src/tools/tariffLookup.ts — LangChain DynamicTool wrappers over ITariffStore
// RULE 1: Only depends on ITariffStore interface — never on SqliteTariffStore directly.

import { DynamicTool } from '@langchain/core/tools';
import type { ITariffStore } from '../adapters/interfaces';
import type { InventoryItem } from '../types/index';

export function createTariffTools(store: ITariffStore): DynamicTool[] {
  return [
    new DynamicTool({
      name: 'get_tariff_rate',
      description:
        'Look up the US import tariff rate for a country and HS code. ' +
        'Input JSON: {"country": "China", "hsCode": "8471.30"}',
      func: async (input: string) => {
        const { country, hsCode } = JSON.parse(input) as { country: string; hsCode: string };
        const rate = await store.getRate(country, hsCode);
        if (!rate) return `No tariff data found for ${country} / ${hsCode}`;
        return JSON.stringify(rate);
      },
    }),

    new DynamicTool({
      name: 'compare_countries',
      description:
        'Compare US import tariff rates across all countries for a given HS code, sorted cheapest first. ' +
        'Input JSON: {"hsCode": "8471.30"}',
      func: async (input: string) => {
        const { hsCode } = JSON.parse(input) as { hsCode: string };
        const rates = await store.compareCountries(hsCode);
        if (!rates.length) return `No tariff data for HS code ${hsCode}`;
        return rates
          .map(r => `${r.country}: ${r.rate}%${r.tradeAgreement ? ` (${r.tradeAgreement})` : ''}`)
          .join('\n');
      },
    }),

    new DynamicTool({
      name: 'calculate_savings',
      description:
        'Calculate annual savings if sourcing moves from current country to target country. ' +
        'Input JSON: {"sku": "SKU-001", "currentCountry": "China", "targetCountry": "Vietnam", ' +
        '"unitCostUSD": 18.50, "hsCode": "8471.30", "annualVolume": 25000}',
      func: async (input: string) => {
        const parsed = JSON.parse(input) as {
          sku: string;
          currentCountry: string;
          targetCountry: string;
          unitCostUSD: number;
          hsCode: string;
          annualVolume: number;
        };
        const item: InventoryItem = {
          sku: parsed.sku,
          name: parsed.sku,
          category: 'Electronics',
          quantity: 0,
          currentSourceCountry: parsed.currentCountry,
          unitCostUSD: parsed.unitCostUSD,
          hsCode: parsed.hsCode,
          annualVolume: parsed.annualVolume,
        };
        const savings = await store.calculateSavings(item, parsed.targetCountry);
        if (savings <= 0) return `No savings — ${parsed.targetCountry} is not cheaper than ${parsed.currentCountry} for ${parsed.sku}`;
        return `Switching ${parsed.sku} from ${parsed.currentCountry} to ${parsed.targetCountry} saves $${savings.toLocaleString()} per year`;
      },
    }),
  ];
}
