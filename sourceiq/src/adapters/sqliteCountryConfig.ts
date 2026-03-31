// src/adapters/sqliteCountryConfig.ts — loads country_config table at startup
// All methods are synchronous — data is loaded once in the constructor and cached.
// To add a country to the system, insert a row in the DB; no code changes needed.

import type Database from 'better-sqlite3';
import type { ICountryConfigStore, CountryConfigRow } from './interfaces';

interface RawRow {
  name: string;
  iso2: string | null;
  currency: string | null;
  is_sanctioned: number;
  is_high_risk: number;
  is_active_conflict: number;
  is_chronic_instability: number;
  risk_score_override: number | null;
  sanctions_detail: string | null;
}

export class SqliteCountryConfigStore implements ICountryConfigStore {
  private readonly rows: CountryConfigRow[];
  private readonly byName: Map<string, CountryConfigRow>;

  constructor(db: Database.Database) {
    const raw = db.prepare('SELECT * FROM country_config').all() as RawRow[];
    this.rows = raw.map(r => ({
      name:                r.name,
      iso2:                r.iso2,
      currency:            r.currency,
      isSanctioned:        r.is_sanctioned === 1,
      isHighRisk:          r.is_high_risk === 1,
      isActiveConflict:    r.is_active_conflict === 1,
      isChronicInstability: r.is_chronic_instability === 1,
      riskScoreOverride:   r.risk_score_override,
      sanctionsDetail:     r.sanctions_detail,
    }));
    this.byName = new Map(this.rows.map(r => [r.name, r]));
  }

  getAll(): CountryConfigRow[] { return this.rows; }

  getHighRiskCountries(): string[] {
    return this.rows.filter(r => r.isHighRisk).map(r => r.name);
  }

  getAllCountryNames(): string[] { return this.rows.map(r => r.name); }

  isSanctioned(name: string): boolean { return this.byName.get(name)?.isSanctioned ?? false; }
  isActiveConflict(name: string): boolean { return this.byName.get(name)?.isActiveConflict ?? false; }
  isChronicInstability(name: string): boolean { return this.byName.get(name)?.isChronicInstability ?? false; }

  getCurrency(country: string): string | null { return this.byName.get(country)?.currency ?? null; }
  getIso2(country: string): string | null { return this.byName.get(country)?.iso2 ?? null; }
  getSanctionsDetail(country: string): string | null { return this.byName.get(country)?.sanctionsDetail ?? null; }
  getRiskOverride(country: string): number | null { return this.byName.get(country)?.riskScoreOverride ?? null; }

  getCurrencyMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const r of this.rows) {
      if (r.currency) map[r.name] = r.currency;
    }
    return map;
  }

  getIso2Map(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const r of this.rows) {
      if (r.iso2) map[r.name] = r.iso2;
    }
    return map;
  }
}
