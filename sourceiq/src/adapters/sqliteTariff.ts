// src/adapters/sqliteTariff.ts — implements ITariffStore
// ONLY file that imports better-sqlite3. All DB access injected via constructor.
import type Database from 'better-sqlite3';
import type { ITariffStore } from './interfaces';
import type { TariffRate, InventoryItem } from '../types/index';
import { estimateAltUnitCost } from '../lib/costIndex';
import { cache, TTL, SWR } from '../lib/cache';

// Tariff data is stable during a demo — cache DB reads for the session
const TARIFF_TTL = { ttlMs: TTL.LONG, swrMs: SWR.LONG, tags: ['tariff'] } as const;

export class SqliteTariffStore implements ITariffStore {
  constructor(private readonly db: Database.Database) {}

  getRate(country: string, hsCode: string): Promise<TariffRate | null> {
    return cache.getOrCompute(
      `tariff:rate:${country}:${hsCode}`,
      () => {
        const row = this.db
          .prepare('SELECT * FROM tariffs WHERE country = ? AND hsCode = ?')
          .get(country, hsCode) as TariffRate | undefined;
        return Promise.resolve(row ?? null);
      },
      { ttlMs: TARIFF_TTL.ttlMs, swrMs: TARIFF_TTL.swrMs, tags: [...TARIFF_TTL.tags] },
    );
  }

  compareCountries(hsCode: string): Promise<TariffRate[]> {
    return cache.getOrCompute(
      `tariff:compare:${hsCode}`,
      () => {
        const rows = this.db
          .prepare('SELECT * FROM tariffs WHERE hsCode = ? ORDER BY rate ASC')
          .all(hsCode) as TariffRate[];
        return Promise.resolve(rows);
      },
      { ttlMs: TARIFF_TTL.ttlMs, swrMs: TARIFF_TTL.swrMs, tags: [...TARIFF_TTL.tags] },
    );
  }

  async calculateSavings(item: InventoryItem, targetCountry: string): Promise<number> {
    const [currentRate, targetRate] = await Promise.all([
      this.getRate(item.currentSourceCountry, item.hsCode),
      this.getRate(targetCountry, item.hsCode),
    ]);

    if (!currentRate || !targetRate) return 0;

    const currentCost = item.unitCostUSD * (1 + currentRate.rate / 100);
    const altUnitCost = estimateAltUnitCost(item.unitCostUSD, item.currentSourceCountry, targetCountry, item.category);
    const targetCost  = altUnitCost * (1 + targetRate.rate / 100);
    return (currentCost - targetCost) * item.annualVolume;
  }

  getAllRates(): Promise<TariffRate[]> {
    return cache.getOrCompute(
      'tariff:all',
      () => {
        const rows = this.db
          .prepare('SELECT * FROM tariffs ORDER BY country, hsCode')
          .all() as TariffRate[];
        return Promise.resolve(rows);
      },
      { ttlMs: TARIFF_TTL.ttlMs, swrMs: TARIFF_TTL.swrMs, tags: [...TARIFF_TTL.tags] },
    );
  }
}
