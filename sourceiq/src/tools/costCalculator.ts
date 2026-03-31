// src/tools/costCalculator.ts — pure functions, no DB imports
// effectiveCost = unitCost * (1 + tariffRate/100)

export function effectiveCost(unitCostUSD: number, tariffRate: number): number {
  return unitCostUSD * (1 + tariffRate / 100);
}

export function annualSavings(
  unitCostUSD: number,
  currentRate: number,
  targetRate: number,
  annualVolume: number,
  altUnitCostUSD?: number,
): number {
  const current = effectiveCost(unitCostUSD, currentRate);
  const target  = effectiveCost(altUnitCostUSD ?? unitCostUSD, targetRate);
  return (current - target) * annualVolume;
}
