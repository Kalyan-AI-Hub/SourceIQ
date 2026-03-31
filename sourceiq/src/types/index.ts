// SourceIQ — All TypeScript interfaces (single source of truth)
// DO NOT declare interfaces anywhere else — always import from here.

// ── Inventory & Suppliers ─────────────────────────────────────────────

export interface InventoryItem {
  sku: string;
  name: string;
  category: 'Electronics' | 'Apparel' | 'Home' | 'Toys' | 'Food';
  quantity: number;
  currentSourceCountry: string;
  unitCostUSD: number;
  hsCode: string;
  annualVolume: number;
}

export interface SupplierInfo {
  country: string;
  category: string;
  leadTimeDays: number;
  reliabilityScore: number;        // 0-100
  carbonScore: number;             // 0-100, lower = more carbon-intensive
  minimumOrderQuantity: number;
}

// ── Tariffs ───────────────────────────────────────────────────────────

export interface TariffRate {
  country: string;
  hsCode: string;
  rate: number;                    // percentage (e.g., 25 = 25%)
  tradeAgreement?: string;         // e.g., "USMCA", "CPTPP"
  expiryDate?: string;             // ISO date — alert if within 6 months
  effectiveDate: string;
}

// ── Risk & Geopolitical ───────────────────────────────────────────────

export interface RiskAlert {
  severity: 'low' | 'medium' | 'high' | 'critical';
  country: string;
  message: string;
  source: string;                  // URL, "Foundry Local", or "State Dept"
  timestamp: string;               // ISO datetime
}

export interface ConflictSignal {
  country: string;
  countryCode: string;             // ISO 3166-1 alpha-2 (for map GeoJSON matching)
  source: 'bing' | 'gdelt' | 'rss' | 'travel-advisory' | 'baseline';
  severity: 'low' | 'medium' | 'high' | 'critical';
  headline: string;
  url?: string;
  confidence: number;              // 0-1, from classifier
  classifierPath: 'keyword' | 'llm';
  timestamp: string;
}

// SourcingRiskIndex — adapted from WorldMonitor's Country Instability Index
export interface SourcingRiskIndex {
  country: string;
  countryCode: string;             // ISO 3166-1 alpha-2
  score: number;                   // 0-100
  tier: 'safe' | 'elevated' | 'high' | 'critical';
  // Color mapping: safe=#22c55e, elevated=#eab308, high=#f97316, critical=#ef4444
  signals: {
    newsRisk: number;              // 40% weight
    tariffRisk: number;            // 30% weight
    tradeDisruption: number;       // 20% weight
    baselineRisk: number;          // 10% weight
  };
  trend: 'escalating' | 'stable' | 'de-escalating';
  trendHistory: number[];          // last 24h scores for trend line
  activeAlerts: RiskAlert[];
  floorApplied?: string;           // e.g. "US sanctions → minimum 75"
  baselineSource?: 'worldbank' | 'fallback'; // data provenance
  updatedAt: string;
}

// ── Recommendations ───────────────────────────────────────────────────

export interface SourcingRecommendation {
  sku: string;
  currentCountry: string;
  recommendedCountry: string;
  tippingPointRate?: number;       // tariff rate at which switching becomes cheaper (0-100)
  currentCostUSD: number;          // unitCost * (1 + currentTariffRate/100)
  recommendedCostUSD: number;      // unitCost * (1 + newTariffRate/100)
  annualSavingsUSD: number;        // (currentCost - recommendedCost) * annualVolume
  tariffRate: number;
  riskScore: number;               // 0-100
  riskAlerts: RiskAlert[];
  diversificationScore?: number;
}

// ── Agent Responses ───────────────────────────────────────────────────

export interface AgentResponse {
  answer: string;
  recommendations?: SourcingRecommendation[];
  riskAlerts?: RiskAlert[];
  chartData?: ChartData;
  heatmapData?: SourcingRiskIndex[]; // Full country risk data for map render
  tracingId?: string;                // Foundry SDK tracing ID
  tracingAgent?: string;             // Which agent handled the query
  tracingDurationMs?: number;        // End-to-end LLM call duration
  toolsUsed?: string[];              // MCP tools called during this response
  source: 'cloud' | 'local';
}

export interface ChartData {
  type: 'bar' | 'pie' | 'line' | 'heatmap';
  title: string;
  data: Record<string, unknown>[];
}

// ── Innovation 1: What-If Tariff Simulator ────────────────────────────

// Country metadata (sanctions, currencies, ISO2, risk flags) is now stored in the
// country_config SQLite table and accessed via getCountryConfig() from src/lib/countryConfig.ts.
// To add or update a country, insert/update a row in the DB — no code changes needed.

export interface WhatIfScenario {
  hypotheticalTariffRate: number;
  country: string;
  affectedSkus: string[];
  totalPortfolioImpactUSD: number;
  recommendations: SourcingRecommendation[];
  aiNarrative?: string;            // LLM-generated sourcing recommendation
  fxRates?: Record<string, number>; // live USD exchange rates at time of calculation
  currencyCode?: string;           // ISO 4217 code for the selected country (for FX display)
}

// ── Innovation 2: Diversification Health Score ────────────────────────

export interface DiversificationHealth {
  overallScore: number;            // 0-100, higher = safer = more diversified
  concentrationWarnings: {
    country: string;
    percentage: number;            // % of total annual spend from this country
    severity: 'low' | 'medium' | 'high' | 'critical';
  }[];
  countryBreakdown: {              // ALL countries with spend, for pie chart
    country: string;
    percentage: number;
    annualSpendUSD: number;
  }[];
  recommendedActions: string[];
  aiInsight?: string;              // LLM-generated executive summary of supply chain health
}

// ── Innovation 3: Morning Brief Agent ─────────────────────────────────

export interface MorningBriefItem {
  sku: string;
  affectedCountry: string;
  alertType: 'conflict' | 'tariff-change' | 'trade-agreement-expiry' | 'risk-escalation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  headline: string;
  recommendedAction: string;
  potentialSavingsUSD?: number;
}

export interface BriefDelta {
  hasDelta: boolean;                  // false on first run (no previous brief)
  previousGeneratedAt?: string;       // ISO timestamp of the previous brief
  newAlerts: string[];                // countries newly appearing as critical/high
  resolved: string[];                 // countries that were critical/high, now safe/elevated
  escalated: { country: string; from: string; to: string }[];  // tier got worse
  deEscalated: { country: string; from: string; to: string }[]; // tier improved
  newOpportunities: string[];         // SKU IDs with new savings opportunities
}

// AgentDecision — a ranked, actionable decision surfaced by the Morning Brief agent.
// The agent scores each item by urgency (risk × revenue impact) and pre-builds the
// exact query to run. User approves → query auto-submits. User defers/dismisses → skipped.
export interface AgentDecision {
  id: string;                      // stable ID for React key + state tracking
  type: 'risk' | 'savings' | 'diversification';
  country: string;
  sku?: string;                    // present for savings/SKU-specific decisions
  urgencyScore: number;            // 0-100 composite: sriScore * (1 + savings / totalPortfolio)
  headline: string;                // short label shown on the card
  rationale: string;               // one sentence explaining why this decision matters now
  prebuiltQuery: string;           // exact query to submit to the chat agent on Approve
  estimatedImpactUSD?: number;     // annual savings or risk-avoided cost
  sriScore?: number;               // raw SRI score (for risk decisions)
  severity: 'critical' | 'high' | 'medium';
}

export interface MorningBrief {
  generatedAt: string;
  criticalAlerts: MorningBriefItem[];
  savingsOpportunities: MorningBriefItem[];
  totalAffectedSkus: number;
  totalPotentialSavingsUSD: number;
  aiSummary?: string;              // LLM-generated executive brief
  decisions: AgentDecision[];      // ranked decisions for the Decision Queue
  delta?: BriefDelta;
}

// ── Innovation 4: AI Insights + Forecasts ────────────────────────────

export interface WorldBrief {
  summary: string;             // 2-3 sentence LLM-generated sourcing intelligence brief
  topRiskCountries: string[];  // Countries driving the brief
  headlines?: { headline: string; source: string; url?: string }[]; // Live RSS headlines
  updatedAt: string;
}

export type ForecastCategory =
  | 'conflict' | 'tariff' | 'supply-chain' | 'political' | 'port' | 'cyber';

export interface Forecast {
  id: string;
  category: ForecastCategory;
  country: string;
  region: string;
  title: string;
  probability: number;         // 0-1
  projections: { h24: number; d7: number; d30: number };
  trend: 'escalating' | 'stable' | 'de-escalating';
  updatedAt: string;
}

// ── Innovation 5: Signal Convergence Cards ────────────────────────────

export interface ConvergenceCard {
  country: string;
  countryCode: string;
  score: number;                   // convergence intensity 0-100
  severity: 'medium' | 'high' | 'critical';
  title: string;                   // e.g. "China: Multi-domain threat convergence"
  signals: string[];               // e.g. ['news:67', 'tariff:50', 'disruption:75']
  impactEstimateUSD?: number;      // estimated annual portfolio impact
  detectedAt: string;
}

// ── Infrastructure ────────────────────────────────────────────────────

export interface CacheEntry<T> {
  data: T;
  fetchedAt: string;
  ttlSeconds: number;
  recordCount: number;
  isStale: boolean;
}

export interface CircuitBreakerState {
  service: string;
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailure?: string;
  nextRetryAt?: string;
}
