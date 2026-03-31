// src/lib/costIndex.ts — shared manufacturing cost index per country × category
// Represents relative factory-gate cost to produce goods in each category.
// China Electronics = 1.0 baseline. Higher = more expensive to manufacture.
// Based on typical sourcing cost differentials in retail trade.

export const COST_INDEX: Record<string, Record<string, number>> = {
  Electronics: {
    China: 1.0, Vietnam: 1.08, India: 1.15, Mexico: 1.30, Bangladesh: 1.25,
    Cambodia: 1.20, Indonesia: 1.12, Turkey: 1.28, Morocco: 1.35, UAE: 1.18,
    Egypt: 1.30, Jordan: 1.40, Oman: 1.45, Qatar: 1.50, 'Saudi Arabia': 1.42, Brazil: 1.25,
  },
  Apparel: {
    Bangladesh: 1.0, Cambodia: 1.05, Egypt: 1.02, India: 1.08, Vietnam: 1.12,
    China: 1.18, Turkey: 1.25, Mexico: 1.35, Indonesia: 1.10, Morocco: 1.20,
    UAE: 1.50, Jordan: 1.15, Oman: 1.55, Qatar: 1.58, 'Saudi Arabia': 1.52, Brazil: 1.22,
  },
  Home: {
    India: 1.0, Indonesia: 1.05, Egypt: 1.03, China: 1.08, Morocco: 1.10,
    Vietnam: 1.12, Turkey: 1.15, Mexico: 1.25, Bangladesh: 1.12, Cambodia: 1.18,
    UAE: 1.22, Oman: 1.28, Qatar: 1.30, Jordan: 1.18, 'Saudi Arabia': 1.32, Brazil: 1.18,
  },
  Toys: {
    China: 1.0, Vietnam: 1.10, Mexico: 1.18, India: 1.15, Indonesia: 1.12,
    Turkey: 1.22, Bangladesh: 1.25, Cambodia: 1.20, Morocco: 1.28, Egypt: 1.25,
    UAE: 1.38, Jordan: 1.35, Oman: 1.42, Qatar: 1.45, 'Saudi Arabia': 1.40, Brazil: 1.22,
  },
  Food: {
    Mexico: 1.0, Turkey: 1.05, Brazil: 1.02, India: 1.08, Morocco: 1.06,
    Jordan: 1.10, Indonesia: 1.12, China: 1.18, Vietnam: 1.15, Bangladesh: 1.22,
    Cambodia: 1.20, Egypt: 1.08, Oman: 1.15, 'Saudi Arabia': 1.20, UAE: 1.28, Qatar: 1.30,
    Iran: 0.85,
  },
};

/** Get the cost index for a given country + category (defaults to 1.2 if unknown). */
export function getCostIndex(country: string, category: string): number {
  return COST_INDEX[category]?.[country] ?? 1.20;
}

/** Estimate what a product would cost if manufactured in altCountry instead of currentCountry. */
export function estimateAltUnitCost(
  currentUnitCost: number,
  currentCountry: string,
  altCountry: string,
  category: string,
): number {
  const currentIdx = getCostIndex(currentCountry, category);
  const altIdx = getCostIndex(altCountry, category);
  return Math.round((currentUnitCost * altIdx / currentIdx) * 100) / 100;
}
