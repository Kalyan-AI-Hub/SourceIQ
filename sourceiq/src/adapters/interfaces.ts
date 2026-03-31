// SourceIQ — Storage & AI adapter contracts (Layer 1 boundary)
// Agents and MCP servers depend on these interfaces ONLY — never on concrete implementations.
// To swap a backend (e.g. LanceDB → Postgres), change only the adapter file.

import type {
  InventoryItem,
  TariffRate,
  SourcingRiskIndex,
  RiskAlert,
  ConvergenceCard,
} from '../types/index';

export interface IInventoryStore {
  search(query: string, limit?: number): Promise<InventoryItem[]>;
  getBySku(sku: string): Promise<InventoryItem | null>;
  getAll(): Promise<InventoryItem[]>;
  getByCountry(country: string): Promise<InventoryItem[]>;
}

export interface ITariffStore {
  getRate(country: string, hsCode: string): Promise<TariffRate | null>;
  compareCountries(hsCode: string): Promise<TariffRate[]>;
  calculateSavings(item: InventoryItem, targetCountry: string): Promise<number>;
  getAllRates(): Promise<TariffRate[]>;
}

export interface IRiskStore {
  getSriForCountry(country: string): Promise<SourcingRiskIndex | null>;
  getHeatmapData(): Promise<SourcingRiskIndex[]>;
  getConflictAlerts(country?: string): Promise<RiskAlert[]>;
  updateSri(data: SourcingRiskIndex): Promise<void>;
  getConvergenceCards(): Promise<ConvergenceCard[]>;
  setConvergenceCards(cards: ConvergenceCard[]): Promise<void>;
}

export interface IFoundryClient {
  generateEmbedding(text: string): Promise<number[]>;
  chat(messages: { role: string; content: string }[], systemPrompt?: string, maxTokens?: number): Promise<string>;
  classifyText(text: string, labels: string[]): Promise<{ label: string; confidence: number }>;
}

/** One row from the country_config table. */
export interface CountryConfigRow {
  name: string;
  iso2: string | null;
  currency: string | null;
  isSanctioned: boolean;
  isHighRisk: boolean;
  isActiveConflict: boolean;
  isChronicInstability: boolean;
  riskScoreOverride: number | null;
  sanctionsDetail: string | null;
}

/**
 * Read-only view of country configuration loaded from the DB at startup.
 * All methods are synchronous — data is eagerly loaded once and cached.
 * To add a new country, insert a row into the country_config table.
 */
export interface ICountryConfigStore {
  /** All rows in the country_config table. */
  getAll(): CountryConfigRow[];
  /** Countries flagged is_high_risk=1 (monitored but not typically sourced from). */
  getHighRiskCountries(): string[];
  /** All country names in the table (sourcing + high-risk + sanctioned-only). */
  getAllCountryNames(): string[];
  isSanctioned(name: string): boolean;
  isActiveConflict(name: string): boolean;
  isChronicInstability(name: string): boolean;
  /** ISO 4217 currency code, or null if unknown. */
  getCurrency(country: string): string | null;
  /** ISO 3166-1 alpha-2 code for World Bank API, or null if unknown. */
  getIso2(country: string): string | null;
  /** Detailed sanctions description for the compliance tool, or null. */
  getSanctionsDetail(country: string): string | null;
  /** World Bank baseline override (for countries WB doesn't cover). */
  getRiskOverride(country: string): number | null;
  /** Map of country → currency for all rows that have a currency set. */
  getCurrencyMap(): Record<string, string>;
  /** Map of country → ISO2 for all rows that have an ISO2 code. */
  getIso2Map(): Record<string, string>;
}
