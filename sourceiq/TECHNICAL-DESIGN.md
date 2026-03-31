# SourcingIntel — Technical Design Document

> **Audience:** Engineers reviewing the codebase, judges, contributors.
> **Scope:** Complete architecture, all modules, layer responsibilities, and end-to-end request flows.

---

## Why This Exists

Global tariff policy shifts and geopolitical disruptions now move at news-cycle speed. A retailer sourcing consumer electronics from China has to evaluate — within 48 hours of a tariff announcement — which of their 30+ SKUs are exposed, what switching to Vietnam or Mexico would cost, and whether those alternatives are themselves stable. Today, that analysis lives in spreadsheets, disconnected tariff tables, and gut instinct.

SourcingIntel replaces that process with a decision-support system backed by a live multi-agent intelligence platform. A buyer can assess China sourcing exposure, compare landed-cost tradeoffs across countries, and identify the most actionable sourcing switches from one workflow that brings together affected SKUs, current vs alternative landed costs, real-time geopolitical risk scores, and ranked recommendations — all grounded in live data and computed on-device, with no pricing or inventory data leaving the machine.

**What makes this technically distinct:**
- A LangGraph StateGraph orchestrates 7 specialist agents with keyword-first classification (saves 300–2000ms per query by avoiding LLM calls for clear-cut intents)
- A background risk pipeline (GDELT + RSS + US State Dept + World Bank) runs every 5 minutes, scoring every sourced country on a 0-100 SourcingRiskIndex and streaming live updates to the map via SSE
- An autonomous Morning Brief agent runs daily (or on-demand), ranking decisions by urgency score (risk × financial impact), pre-building the exact chat query for each, and diffing against the previous brief to surface what changed overnight
- All LLM inference runs on-device via Foundry Local (phi-4-mini). Sensitive pricing data never leaves the machine.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architectural Layers](#2-architectural-layers)
3. [Layer 0 — UI Components](#3-layer-0--ui-components)
4. [Layer 1 — API Routes](#4-layer-1--api-routes)
5. [Layer 2 — Agent Orchestration (LangGraph)](#5-layer-2--agent-orchestration-langgraph)
6. [Layer 3 — Specialist Agents](#6-layer-3--specialist-agents)
7. [Layer 4 — Services & Tools](#7-layer-4--services--tools)
8. [Layer 5 — Storage Adapters](#8-layer-5--storage-adapters)
9. [Layer 6 — AI Infrastructure](#9-layer-6--ai-infrastructure)
10. [MCP Tool Layer](#10-mcp-tool-layer)
11. [RAG Pipeline](#11-rag-pipeline)
12. [Dependency Injection & Startup](#12-dependency-injection--startup)
13. [End-to-End Request Flows](#13-end-to-end-request-flows)
14. [Data Models (TypeScript Interfaces)](#14-data-models-typescript-interfaces)
15. [Configuration & Environment](#15-configuration--environment)
16. [Testing Strategy](#16-testing-strategy)
17. [Responsible AI Design](#17-responsible-ai-design)

---

## 1. System Overview

SourcingIntel is a **multi-agent supply chain intelligence system** built with Next.js 14 (App Router). It helps retail buyers assess sourcing exposure, compare supplier-country tradeoffs, and act on supply chain risk by routing requests through a LangGraph StateGraph to specialist AI agents, each grounded on live data from LanceDB (vector), SQLite (structured), and a real-time risk store.

**Core design principles:**

- **Interface-gated layers**: Every cross-layer dependency goes through a TypeScript interface. Agents never import concrete adapter classes.
- **On-device AI**: All inference runs via Foundry Local (phi-4-mini). No pricing data leaves the machine by default.
- **Data-grounded responses**: Every agent embeds live data directly in the LLM's user turn, preventing hallucination of unseen values.
- **Dependency injection at one root**: `src/lib/startup.ts` is the only file that instantiates concrete classes. All other files receive interfaces.
- **Keyword-first classification**: Intent routing checks regex patterns before calling the LLM — saves 300–2000ms per query on clear-cut intents.

---

## 2. Architectural Layers

```
┌─────────────────────────────────────────────────────┐
│  Layer 0: UI (React / Next.js App Router)           │
│  app/components/*.tsx  ·  app/page.tsx              │
├─────────────────────────────────────────────────────┤
│  Layer 1: API Routes (Next.js Route Handlers)        │
│  app/api/*/route.ts                                 │
├─────────────────────────────────────────────────────┤
│  Layer 2: Agent Orchestration (LangGraph StateGraph) │
│  src/agents/orchestrator.ts                         │
├─────────────────────────────────────────────────────┤
│  Layer 3: Specialist Agents                         │
│  src/agents/{inventory,tariff,geoRisk,dashboard,    │
│              news,market}Agent.ts                   │
├─────────────────────────────────────────────────────┤
│  Layer 4: Services & Tools (Business Logic)         │
│  src/services/*.ts  ·  src/tools/*.ts               │
├─────────────────────────────────────────────────────┤
│  Layer 5: Storage Adapters (Interface-gated)        │
│  src/adapters/*.ts                                  │
├─────────────────────────────────────────────────────┤
│  Layer 6: AI Infrastructure                         │
│  Foundry Local + Xenova Transformers + Azure cloud  │
└─────────────────────────────────────────────────────┘
```

**Data flow rule:** Each layer only communicates with the layer immediately below it, and only through the interfaces defined in `src/adapters/interfaces.ts`. This makes every layer independently testable.

---

## 3. Layer 0 — UI Components

**Location:** `app/components/` · `app/page.tsx`

The UI is a single Next.js page (`app/page.tsx`) that renders `MainLayout`, which assembles the dashboard from 18 React components. Components communicate with the backend exclusively through the API Layer.

### Component Inventory

| File | Purpose | API endpoint(s) |
|------|---------|-----------------|
| `ChatInterface.tsx` | Natural-language query input + answer display with risk badges and chart rendering | `POST /api/query` |
| `ConflictHeatmap.tsx` | Leaflet.js + deck.gl country risk map with color-coded SRI scores; subscribes to SSE for live updates | `GET /api/risk-stream` (SSE) · `GET /api/heatmap` |
| `WhatIfSimulator.tsx` | Tariff slider (0–100%) for any country; renders cost impact breakdown + AI narrative | `GET /api/what-if` |
| `DiversificationGauge.tsx` | Circular gauge showing supply chain concentration risk; green/amber/red threshold bands | `GET /api/diversification` |
| `MorningBrief.tsx` | Panel rendering the autonomous daily risk brief (embedded in LeftPane or as overlay). Shows AI executive summary, risk alerts, savings opportunities, and a `DecisionQueue` of urgency-ranked decisions. Each decision card has an "Approve" button that auto-submits a pre-built query to the chat agent, and a "Dismiss" button to skip it. Supports `onPrefillChat` callback so alert cards can also prefill the chat input directly. | `GET /api/morning-brief` |
| `CostComparisonChart.tsx` | Recharts `BarChart` — current vs recommended sourcing cost per SKU | Rendered from `/api/query` response data |
| `SKUTable.tsx` | Sortable data table of inventory SKUs with SRI badge per source country | Rendered from `/api/query` response data |
| `CommodityTicker.tsx` | Header ticker showing live WTI, Brent crude, Baltic Dry Index, USD/CNY | `GET /api/commodities` |
| `ConvergenceCards.tsx` | Cards surfacing multi-domain risk overlaps (tariff + conflict + advisory on same country) | Rendered from heatmap/risk data |
| `AIInsightsPanel.tsx` | Sidebar with AI-generated sourcing insights | Rendered from chat session data |
| `LeftPane.tsx` | Left panel wrapper — tabs for Chat and Intelligence views | Wrapper only |
| `MainLayout.tsx` | Top-level layout: fixed left chat pane + right tabbed sections (Risk Map, Supply Chain Health, Tariff Simulator, Intelligence). Uses deferred rendering (`everShown` set) so Leaflet gets a real container size on mount. Dispatches `SourcingIntel:analyze-country` custom events for cross-component chat prefill. | Wrapper — routes to child components |
| `ThemeToggle.tsx` | Dark/light mode toggle button. Persists preference to `localStorage` under `SourcingIntel-theme` key; defaults to dark. | None (client-only) |
| `DecisionBrief.tsx` | Post-query intelligence card that auto-parses `AgentResponse` into a structured brief: headline, metrics (savings, risk score, item count), current vs recommended country, confidence level. Handles inventory-lookup, risk-brief, and sourcing-comparison responses with distinct layouts. | Rendered from `/api/query` response data |
| `DecisionQueue.tsx` | Agentic decision triage panel rendering urgency-ranked `AgentDecision` cards from the Morning Brief. User controls: Approve (auto-submits `prebuiltQuery` to chat + calls `/api/notify-procurement`), Defer (moves card to bottom), Dismiss (removes). Includes `TriageRunner` for batch execution. | `POST /api/notify-procurement` |
| `RiskRadarStrip.tsx` | Global Risk Radar cockpit hero strip. Shows top-3 critical/high countries with live SRI score + numeric trend delta (computed from previous SSE snapshot). Displays critical count and safe-zone count. Cards are clickable → dispatches `SourcingIntel:analyze-country`. | `GET /api/risk-stream` (SSE) |
| `SignalConvergenceStrip.tsx` | Live convergence pill strip showing multi-domain signal overlaps per country. Click any pill to expand full detail panel (signals, score, severity). Subscribes to SSE `convergence` events for real-time updates. | `GET /api/risk-stream` (SSE — `convergence` event) |
| `TriageRunner.tsx` | Batch triage execution: runs top 3 pending decisions sequentially through the chat agent by dispatching `prebuiltQuery` events with 1800ms spacing. Shows progress indicators per decision and a static Sourcing Action Plan summary on completion. | Dispatches to `ChatInterface` via `SourcingIntel:analyze-country` events |

### Key UI patterns

**SSE for real-time updates:**
```typescript
// ConflictHeatmap.tsx
const es = new EventSource('/api/risk-stream');
es.onmessage = (e) => {
  const data: SourcingRiskIndex[] = JSON.parse(e.data);
  updateHeatmapColors(data);
};
```

**SSR-disabled map component:**
```typescript
// app/page.tsx — Leaflet accesses window on load; must be client-only
const ConflictHeatmap = dynamic(() => import('./components/ConflictHeatmap'), { ssr: false });
```

**Auto-fetch on mount:**
All dashboard widgets call their endpoint on `useEffect([])` — no user interaction needed for initial data.

**Dark/light theme:**
`layout.tsx` injects an inline `<script>` that reads `localStorage` before first paint to prevent FOUC (flash of unstyled content). `ThemeToggle` component persists preference. Default is dark mode.

**Error boundary:**
`app/error.tsx` provides a global error boundary with a "Try again" reset button. Catches unhandled React errors across all routes.

**Cross-component communication:**
Components dispatch and listen for `SourcingIntel:analyze-country` custom events on `window` to prefill the chat input from any widget (e.g., clicking a country on the heatmap, approving a decision).

---

## 4. Layer 1 — API Routes

**Location:** `app/api/*/route.ts`

Each route is a Next.js App Router handler (`export async function GET/POST()`). Routes are thin — they call `initializeApp()` to ensure singletons are ready, then delegate to the service layer. They never instantiate concrete classes.

### Route Handlers

| Route | Method | Handler responsibility |
|-------|--------|----------------------|
| `/api/query` | POST | Validates body; calls `orchestrator.route(message)`; returns `AgentResponse` as JSON |
| `/api/risk-stream` | GET | Opens SSE connection; sends current heatmap snapshot then subscribes to `riskEmitter`; sends heartbeat every 30s; closes connection on client disconnect |
| `/api/heatmap` | GET | Returns `riskStore.getHeatmapData()` — full SRI snapshot for map initialization |
| `/api/what-if` | GET | Validates `country` + `rate` params; checks sanctions (HTTP 403 if sanctioned); runs `simulateTariff()`; fetches FX rates + SRI in parallel; calls LLM for narrative; returns full scenario |
| `/api/diversification` | GET | Calls `calculateDiversification(inventoryStore, tariffStore, riskStore)`; returns `DiversificationHealth` |
| `/api/morning-brief` | GET | Standalone agentic pipeline (does NOT route through orchestrator). Derives monitored countries from inventory, fetches SRI + tariff comparisons in parallel, builds risk alerts and savings opportunities, generates an urgency-scored Decision Queue, diffs against the previous brief (delta), calls Foundry Local for an AI executive summary, caches result (SWR), and fires an HTML email via nodemailer if SMTP is configured. Also receives Vercel cron at 07:00 UTC daily. |
| `/api/commodities` | GET | Calls `fetchOilPrices()`, `fetchShippingIndex()`, `fetchCommodityPrices()` in parallel |
| `/api/forecasts` | GET | Calls `generateForecasts(riskStore)`; returns 7-day risk projections |
| `/api/world-brief` | GET | Calls `orchestrator.route("Global situation brief...")` |
| `/api/countries` | GET | Returns `getCountryConfig().getAll()` — country metadata list |
| `/api/trace/[id]` | GET | Returns all `TraceRecord` spans for a given request ID (from the global trace store in `tracingClient.ts`). Used by the UI to show the full call tree for any query. |
| `/api/notify-procurement` | POST | Sends a contextual HTML email to the procurement team when a Decision Queue item is approved. Reads recipient from `config/local.json`; reuses the nodemailer SMTP transport from morning-brief. Returns `{ sent, simulated }`. |
| `/api/debug/lancedb` | GET | Raw LanceDB inventory inspection. Supports `?country=`, `?sku=`, `?search=` (vector) query params. Returns items with mode metadata. For development/validation only. |
| `/api/debug/sqlite` | GET | Raw SQLite inspection. Supports `?table=tariffs`, `?table=country_config`, `?country=`, `?hscode=` filters. Returns table summaries or filtered rows. For development/validation only. |

### SSE Implementation (risk-stream)

```
Client connects → GET /api/risk-stream
  ↓
Route sends snapshot: current heatmap (all SRI scores)
  ↓
Route registers: riskEmitter.on('update', updateListener)
  ↓
Every time RiskPoller updates an SRI score:
  InMemoryRiskStore.updateSri() → riskEmitter.emit('update', updatedSri)
  ↓
updateListener sends: data: [SourcingRiskIndex] + \n\n
  ↓
Client disconnects → route calls riskEmitter.off('update', updateListener)
                     (per-connection listener — never removeAllListeners)
```

---

## 5. Layer 2 — Agent Orchestration (LangGraph)

**Location:** `src/agents/orchestrator.ts`

The `Orchestrator` class wraps a LangGraph `StateGraph`. It is compiled lazily (first call to `route()`) to avoid ESM issues at Next.js build time.

### StateGraph Definition

**State channels:**
```typescript
interface GraphState {
  userMessage: string;
  intent: Intent | null;        // 'inventory' | 'tariff' | 'risk' | 'news' | 'market' | 'comparison' | 'general'
  inventoryResult: AgentResponse | null;
  tariffResult: AgentResponse | null;
  riskResult: AgentResponse | null;
  finalResponse: AgentResponse | null;
}
```

**Nodes:**

| Node | Responsibility |
|------|---------------|
| `classify` | Keyword check → comparison/news/market shortcut; LLM fallback for ambiguous queries |
| `inventoryNode` | Runs `InventoryAgent.query(message)` |
| `tariffNode` | Runs `TariffAgent.query(message)` |
| `riskNode` | Runs `GeoRiskAgent.query(message)` |
| `dashboardNode` | Runs `DashboardAgent.buildResponse(inv, tar)`; weaves `riskResult.answer` into output |
| `newsNode` | Runs `NewsAggregatorAgent.query(message)` |
| `marketNode` | Runs `MarketIntelAgent.query(message)` |
| `packInventory` | Passes `inventoryResult` → `finalResponse` (standalone inventory queries) |
| `packTariff` | Passes `tariffResult` → `finalResponse` (standalone tariff queries) |
| `packRisk` | Passes `riskResult` → `finalResponse` (standalone risk queries) |
| `generalNode` | Direct LLM chat with sourcing-scoped system prompt |

**Edge routing:**

```
classify → {
  news      → newsNode → END
  market    → marketNode → END
  inventory → inventoryNode → packInventory → END
  tariff    → tariffNode → packTariff → END
  risk      → riskNode → packRisk → END
  general   → generalNode → END
  comparison→ inventoryNode → tariffNode → riskNode → dashboardNode → END
}
```

### Intent Classification — Keyword-First

```
Query arrives
  │
  ├─ NEWS_PATTERNS match?  ──yes──→ intent="news"   (no LLM call)
  │
  ├─ MARKET_PATTERNS match? ──yes──→ intent="market" (no LLM call)
  │
  ├─ hasInventory AND hasRisk? ──yes──→ intent="comparison" (no LLM call)
  │
  └─ None match ──→ foundry.classifyText(message, labels) → LLM-classified intent
```

Pattern examples:
- `NEWS_PATTERNS`: `news`, `alerts`, `briefing`, `latest`, `what broke`
- `MARKET_PATTERNS`: `oil`, `crude`, `wti`, `brent`, `bdi`, `shipping costs`, `fx rate`, `sanction`, `embargo`
- `hasInventory`: `inventory`, `sku`, `items`, `products`, `stock`, `source from`
- `hasRisk`: `risk`, `safe`, `danger`, `conflict`, `advisory`

---

## 6. Layer 3 — Specialist Agents

**Location:** `src/agents/*.ts`

Each agent receives all dependencies through its constructor (interfaces only, never concrete classes). Agents follow three rules:
1. **Never import adapters directly** — receive them via constructor
2. **Always embed data in user turn** — not system prompt (phi-4-mini grounds better this way)
3. **Limit context to ~2KB** — filter before passing to LLM to avoid token limit cutoffs

### InventoryAgent (`inventoryAgent.ts`)

**Constructor:** `(store: IInventoryStore, foundry: IFoundryClient, tariffs?: ITariffStore, retriever?: InventoryRetriever)`

**Query routing logic:**
```
isPriceQuery?  → store.getAll() → sort by unitCostUSD → prepend "THE CHEAPEST IS…" header
mentionedCountry? → store.getByCountry(country)    (exact match, no semantic search)
categoryEntry?  → store.getAll() + JS filter by category
else           → store.search(query, 8)              (semantic vector search)
```

Country detection now uses `getCountryConfig().getAllCountryNames()` — the authoritative list from SQLite, not a derived list from inventory items. This ensures all 40+ monitored countries are recognized even if they're not in the current inventory.

**Grounding block format:**
```
[INVENTORY DATA — use ONLY items listed below, no other data]
⛔ COMPLIANCE ALERT: [country] is under US OFAC sanctions... (if applicable)
Inventory items sourced from China:
1. SKU-001 | USB-C Hub | China | $18.50 | vol: 25,000 | HS: 8471.30
2. ...
[END INVENTORY DATA]

Question: Which electronics do I source from China?
```

---

### TariffAgent (`tariffAgent.ts`)

**Constructor:** `(store: ITariffStore, foundry: IFoundryClient, inventory?: IInventoryStore, riskStore?: IRiskStore)`

Fetches all tariff rates (`store.getAllRates()`), then filters to country mentioned in query before sending to LLM (avoids 80-row context overload). Falls back to first 20 rows if no country match. Sets timeout to 60s (phi-4-mini is slow on large contexts). Also supports a structured SKU-switch path: when the query matches `analyze switching SKU-XXX from CountryA`, builds full `SourcingRecommendation[]` so the Decision Brief tiles populate correctly (requires optional `inventory` and `riskStore` dependencies).

**Data grounded on:** HS code, rate %, effective date, trade agreement (USMCA, Jordan FTA, etc.), today's date (injected to ensure correct tense).

---

### GeoRiskAgent (`geoRiskAgent.ts`)

**Constructor:** `(riskStore: IRiskStore, foundry: IFoundryClient)`

Fetches `getSriForCountry(mentionedCountry)` + top risky countries for context. Builds a deep-dive block including:
- Score, tier, trend
- Signal breakdown (newsRisk / tariffRisk / tradeDisruption / baselineRisk)
- `floorApplied` reason (e.g., "active conflict → minimum 85")
- Verbatim active alert messages

System prompt explicitly forbids generic advice ("supply chain disruptions possible") — must cite specific signals.

---

### DashboardAgent (`dashboardAgent.ts`)

**Constructor:** `(tariff: ITariffStore, inventory: IInventoryStore, risk: IRiskStore)`

The merge layer — runs after inventory + tariff + risk agents in a comparison query. Builds:
- `SourcingRecommendation[]`: best alternative country per SKU with annual savings
- `ChartData`: bar chart of current vs recommended cost per SKU
- `heatmapData`: SRI scores for map rendering

For each of the top 10 SKUs:
1. `compareCountries(hsCode)` → sorted tariff rates (cheapest first)
2. Best alternative = lowest-cost country ≠ current
3. `effectiveCost = unitCost × (1 + tariffRate/100)`
4. `annualSavings = (currentCost - recommendedCost) × annualVolume`

---

### NewsAggregatorAgent (`newsAggregatorAgent.ts`)

**Constructor:** `(riskStore: IRiskStore, foundry: IFoundryClient)`

Fetches all `getConflictAlerts()` (no country filter), groups by country, surfaces the top 5 highest-severity alerts. Also formats convergence cards from `getConvergenceCards()`. Provides regional context: if a sanctioned country appears, discusses spillover to neighboring sourcing countries.

---

### MarketIntelAgent (`marketIntelAgent.ts`)

**Constructor:** `(foundry: IFoundryClient)`

The MCP tool-calling agent. Does not use any storage adapter — all data comes from live financial APIs via the MCP runtime bridge and SDK-backed MCP clients.

**Three-step flow:**
1. `selectTools(query, country)` — picks relevant tools from the registry based on trigger patterns
2. `executeTools(selectedTools, { country })` — runs all selected tools, returns labeled results
3. Builds `[LIVE MARKET DATA]` block → LLM synthesis

Tools always included for sourcing/cost queries: `get_oil_price`, `get_shipping_index`, `get_fx_rates`.

---

## 7. Layer 4 — Services & Tools

### Services (Background / Stateful)

**Location:** `src/services/`

| File | Responsibility |
|------|---------------|
| `riskPoller.ts` | Runs a `setInterval` loop every `RISK_POLL_INTERVAL_MS` (default 5 min). Fetches GDELT batch + RSS per country + State Dept advisories. Runs `ConflictClassifier` on each article. Calls `RiskScorer` to compute SRI. Updates `InMemoryRiskStore`. Also invokes `ConvergenceDetector` and `WorldBankBaselines` refresh. |
| `riskScorer.ts` | Pure function `calculateSri(input)`. Weights: `newsRisk×0.30 + tariffRisk×0.25 + tradeDisruption×0.20 + baselineRisk×0.25`. Applies floor rules from `ICountryConfigStore`. Returns `SourcingRiskIndex`. |
| `conflictClassifier.ts` | Scores article severity (low/medium/high/critical) using keyword lists per severity tier. No LLM — preserves Foundry Local capacity for user queries. |
| `convergenceDetector.ts` | Detects when 2+ signal dimensions (newsRisk, tariffRisk, tradeDisruption, baselineRisk) exceed their thresholds simultaneously for the same country. Computes a convergence intensity score with bonuses for escalating trend, critical tier, and additional dimensions. Emits `ConvergenceCard` records. |
| `forecastGenerator.ts` | Projects 7-day SRI trend per country using linear extrapolation of `trendHistory`. Returns probability-ranked forecast cards. |
| `circuitBreaker.ts` | Generic `CircuitBreaker<T>` class. Trips open after N consecutive failures. Resets to closed after successful call in half-open state. Used by GDELT, RSS, State Dept fetchers. |
| `riskCache.ts` | TTL-based in-memory cache (Map + expiry timestamps). Used by World Bank API fetcher to avoid rate limiting. |
| `travelAdvisory.ts` | Fetches US State Dept travel advisory RSS feed; extracts `doNotTravel` flag per country. |

### Tools (Pure Functions)

**Location:** `src/tools/`

| File | Responsibility |
|------|---------------|
| `gdeltFetcher.ts` | Single batch GDELT API call per poll cycle; articles matched to countries by name mention. Avoids 20 separate calls. 15-minute in-memory cache. |
| `rssFetcher.ts` | Fetches BBC + Reuters RSS feeds in one pass; caches 15 minutes; `searchRss(country)` matches by country name. |
| `worldBankBaselines.ts` | Fetches World Bank WGI (Worldwide Governance Indicators) for all countries; cached 24h; provides governance stability baseline scores. |
| `commodityFetcher.ts` | Fetches WTI + Brent (Stooq), Baltic Dry Index (Stooq), cotton + copper (Stooq). Returns structured `OilData`, `ShippingData`, `CommodityData`. Also exports `getOilPriceAdjustment()` — adds 0–15 points to `tradeDisruption` when WTI > $80. |
| `exchangeRateFetcher.ts` | Fetches live USD exchange rates from ECB via `frankfurter.app/latest?from=USD`. Returns `Record<currency, rate>`. |
| `whatIfSimulator.ts` | `simulateTariff(country, rate, inventory, tariff)` — for each SKU currently sourced from `country`, computes `currentCost` at existing tariff vs `proposedCost` at `rate`%; recommends cheapest alternative; returns `WhatIfScenario`. |
| `diversificationScore.ts` | `calculateDiversification(inventory, tariff, risk)` — Herfindahl-like spend concentration index per country; SRI-weighted risk score; returns `DiversificationHealth` with color-coded gauge value. |
| `costCalculator.ts` | `effectiveCost(unitCostUSD, tariffRate)` — single formula: `unitCost × (1 + tariffRate / 100)`. |
| `tariffLookup.ts` | Tool definitions (name, description, parameters) used by `tariffMcpServer.ts`. |
---

## 8. Layer 5 — Storage Adapters

**Location:** `src/adapters/`

All adapters implement interfaces from `interfaces.ts`. Agents never import adapter classes directly.

### `interfaces.ts` — Contract Definitions

```typescript
IInventoryStore   // search, getBySku, getAll, getByCountry
ITariffStore      // getRate, compareCountries, calculateSavings, getAllRates
IRiskStore        // getSriForCountry, getHeatmapData, getConflictAlerts,
                  // updateSri, getConvergenceCards, setConvergenceCards
IFoundryClient    // generateEmbedding, chat, classifyText
ICountryConfigStore // getAllCountryNames, isSanctioned, isActiveConflict, etc.
```

### `lanceDbInventory.ts` — LanceDB Vector Adapter

Implements `IInventoryStore`. Uses **dynamic import** (`await import('vectordb')`) on every call to avoid ESM/CJS crash in Next.js.

| Method | Implementation |
|--------|---------------|
| `search(query, limit)` | `foundry.generateEmbedding(query)` → `table.search(embedding).limit(limit)` |
| `getAll()` | Dummy vector scan (DUMMY_VEC all 0.1) with limit 500; JS strips vector field |
| `getByCountry(country)` | Dummy vector scan + JS filter by `currentSourceCountry` |
| `getBySku(sku)` | Dummy vector scan + JS find by `sku` |

> **Note:** LanceDB v0.4 SQL filter is unreliable for full scans. Dummy vector + JS filter is the stable workaround for the demo's 33-SKU dataset. Production would add SQL-based getAll with proper field quoting.

### `sqliteTariff.ts` — SQLite Tariff Adapter

Implements `ITariffStore`. Uses `better-sqlite3` (synchronous, no async/await).

| Method | SQL |
|--------|-----|
| `getRate(country, hsCode)` | `SELECT * FROM tariffs WHERE country=? AND hs_code=?` |
| `getAllRates()` | `SELECT * FROM tariffs ORDER BY country, rate ASC` |
| `compareCountries(hsCode)` | `SELECT * FROM tariffs WHERE hs_code=? ORDER BY rate ASC` |
| `calculateSavings(item, targetCountry)` | Fetches both rates; returns `(currentCost - targetCost) × annualVolume` |

### `sqliteCountryConfig.ts` — Country Config Adapter

Implements `ICountryConfigStore`. Eagerly loads all rows from `country_config` table on construction; all methods are synchronous Map lookups. Provides: `isSanctioned`, `isActiveConflict`, `isChronicInstability`, `getCurrency`, `getIso2`, `getSanctionsDetail`, `getRiskOverride`.

### `inMemoryRisk.ts` — Risk Store

Implements `IRiskStore`. Backed by `Map<string, SourcingRiskIndex>`. Emits events on `riskEmitter` (shared EventEmitter) on every `updateSri()` call. SSE route subscribes to these events per-connection.

### `foundryLocal.ts` (adapter) + `foundryLocal.ts` (lib factory)

Implements `IFoundryClient`. Three methods:
- `generateEmbedding(text)`: calls `localEmbeddings.embed(text)` via Xenova
- `chat(messages, systemPrompt?)`: POST to `http://localhost:5273/v1/chat/completions`; graceful degradation on ECONNREFUSED (returns raw data summary)
- `classifyText(text, labels)`: special chat prompt → extracts JSON `{ label, confidence }`

### `foundryCloud.ts` — Azure AI Foundry Adapter

Implements `IFoundryClient`. Used when `AZURE_FOUNDRY_ENDPOINT` + `AZURE_FOUNDRY_API_KEY` are set. Routes `chat()` to Azure AI Foundry; routes `generateEmbedding()` to `localClient` (embeddings always on-device — Responsible AI).

---

## 9. Layer 6 — AI Infrastructure

### Foundry Local (phi-4-mini)

- **SDK:** `foundry-local-sdk` — auto-discovers port via `startWebService()`; type declarations in `src/types/foundry-local-sdk.d.ts`
- **Endpoint:** Auto-discovered by SDK (fallback: `http://localhost:5273`, configurable via `FOUNDRY_LOCAL_ENDPOINT`)
- **API:** OpenAI-compatible `/v1/chat/completions`
- **Model:** `phi-4-mini` — Microsoft's 3.8B parameter model, optimized for reasoning
- **Model TTL:** Set to 7200s (2h) at startup via `/openai/load/{model}?ttl=7200` — prevents auto-unload during demo idle time
- **SDK bypass:** Set `FOUNDRY_USE_SDK=false` to skip the SDK and use raw HTTP (instant rollback)
- **Timeout:** 60 seconds (AbortSignal) per call
- **Concurrency:** Sequential — all agents run sequentially, never concurrent LLM calls (prevents OOM on 16GB machines)
- **Graceful degradation:** On `ECONNREFUSED`, returns structured data summary without LLM narrative

### Xenova Transformers (all-MiniLM-L6-v2)

- **Library:** `@xenova/transformers` v2.17.2
- **Model:** `Xenova/all-MiniLM-L6-v2` — 384-dimensional general-purpose sentence embeddings
- **Import:** `await import(/* webpackIgnore: true */ '@xenova/transformers')` — prevents webpack bundling; runs in Node.js process only
- **Output:** `Float32Array` → `Array<number>` (384 floats per text)
- **Used for:** `IInventoryStore.search()` — semantic similarity between query and inventory descriptions

### Tracing Decorator (`tracingClient.ts`)

Every agent's LLM client is wrapped:
```typescript
const tracedClient = withTracing(foundry, 'tariff-agent');
// Every chat() call logs: [tariff-agent] traceId=abc123 start=... end=... duration=450ms
```

Provides: UUID per call (span-level `traceId`), request-level `requestId` (groups all spans for one user query), agent name tag, start/end timestamps, duration. Spans are stored in a global trace store (capped at 500 records, survives Next.js dev-mode hot reload via `globalThis`). The `/api/trace/[id]` route exposes spans by `requestId`.

Additional utilities:
- `recordSpan(agent, method, durationMs)` — records non-LLM steps (graph nodes, keyword routing)
- `setActiveRequestId(id)` / `getActiveRequestId()` — scopes spans to the current request
- `getTracesByRequestId(id)` — returns all spans for a given request (used by the trace API route)

### Risk Event Bus (`riskEvents.ts`)

A shared `EventEmitter` singleton (`riskEmitter`) used for real-time risk updates. `InMemoryRiskStore.updateSri()` emits here; the SSE route (`/api/risk-stream`) subscribes per-connection. Max listeners set to 50 for concurrent SSE clients.

### Cache Service (`cache.ts`)

A full-featured typed cache service with:
- Per-entry TTL with metadata (createdAt, expiresAt, tags, source)
- LRU eviction (max 256 entries — no unbounded growth)
- In-flight request coalescing (one recompute per key, not N stampedes)
- Stale-while-revalidate (serve stale immediately, recompute in background)
- Tag-based bulk invalidation (tags: `risk`, `inventory`, `tariff`, `market`, `brief`, `ai-insight`)
- Stats tracking (hits, misses, stale-hits, evictions)
- Survives Next.js dev-mode hot reload via `globalThis`

---

## 10. MCP Tool Layer

**Location:** `src/lib/mcpToolRegistry.ts` · `src/mcp/*.ts`

### In-Process Registry (Agent Runtime)

`mcpToolRegistry.ts` provides two functions:
- `selectTools(query, country?)` — pattern-matches query against each tool's `triggers[]` regex array; returns tool names to call
- `executeTools(toolNames, args)` — runs each tool, returns `{ tool, result }[]`; uses `Promise.allSettled` (failures don't block other tools)

**MCP runtime bridge:** 6 tool definitions covering oil prices, shipping index, commodity prices, FX rates, sanctions check, GDELT news.

### Stdio MCP Servers (External Clients)

7 standalone servers using `@modelcontextprotocol/sdk`. Can be connected to Claude Desktop or any MCP-compatible client.

| Server | Tools | Data source |
|--------|-------|-------------|
| `riskMcpServer.ts` | `get_sri_score`, `get_risk_heatmap`, `get_conflict_alerts`, `get_convergence_cards`, `get_sri_trend` | `InMemoryRiskStore` |
| `tariffMcpServer.ts` | `get_tariff_rate`, `compare_countries`, `calculate_savings`, `get_all_rates`, `get_trade_agreements` | `SQLite tariffs table` |
| `inventoryMcpServer.ts` | `search_inventory`, `get_sku`, `list_by_country`, `get_inventory_stats`, `get_sourcing_summary` | `LanceDB` |
| `commodityMcpServer.ts` | `get_oil_prices`, `get_shipping_index`, `get_commodity_prices`, `get_freight_assessment` | Stooq API |
| `sanctionsMcpServer.ts` | `check_sanctions`, `list_sanctioned_countries`, `get_compliance_guidance` | `country_config` table |
| `fxMcpServer.ts` | `get_fx_rates`, `get_country_currency`, `convert_currency` | ECB via frankfurter.app |
| `gdeltMcpServer.ts` | `search_gdelt_news`, `get_conflict_articles`, `get_country_events` | GDELT API |

### Internal MCP Clients — Three-Layer MCP Architecture

**Location:** `src/lib/internalMcpClients.ts`

At runtime, agents do **not** call raw storage adapters. Instead, `startup.ts` wires three internal MCP servers (tariff, inventory, risk) to in-process `Client` instances via `InMemoryTransport` from `@modelcontextprotocol/sdk`. It exposes `McpTariffAdapter`, `McpInventoryAdapter`, and `McpRiskAdapter` classes that implement the same `ITariffStore`, `IInventoryStore`, and `IRiskStore` interfaces — but route every call through `Client.callTool()` over the MCP protocol boundary.

**Call flow:**
```
Agent → McpXxxAdapter.method() → Client.callTool() → InMemoryTransport
  → MCP server handler → raw store (SqliteTariffStore / LanceDbInventoryStore / InMemoryRiskStore)
```

This guarantees that ALL agent-tool interactions traverse the MCP protocol at runtime, satisfying the three-layer MCP architecture (external stdio MCP servers + internal InMemoryTransport MCP clients + MCP runtime bridge for financial APIs).

---

## 10b. Prompt Registry

**Location:** `src/prompts/promptLoader.ts` · `src/prompts/prompts.json`

All agent system prompts are centralized in `prompts.json` (Prompty-inspired format) — no prompt strings scattered across agent files.

**Format:** Dot-notation keys (e.g., `geoRisk.analyst`) mapped to `PromptEntry` records containing:
- `name`, `description` — human-readable labels
- `model.parameters.max_tokens` — token budget co-located with the prompt
- `system` — the system prompt text with `{{variableName}}` placeholders for runtime substitution

**API:**
- `getPrompt(key, vars?)` — returns the system prompt with placeholders filled
- `getMaxTokens(key)` — returns the max_tokens value for the prompt

**Registered prompts:** `inventory.analyst`, `inventory.browse`, `tariff.analyst`, `geoRisk.analyst`, `marketIntel.analyst`, `newsAggregator.analyst`, `orchestrator.general`, `classifier.intentClassifier`.

---

## 10c. Manufacturing Cost Index

**Location:** `src/lib/costIndex.ts`

A shared country × category cost index used by the Morning Brief and What-If simulator to estimate manufacturing cost differences when switching suppliers between countries.

- `getCostIndex(country, category)` — returns the relative cost multiplier (China Electronics = 1.0 baseline)
- `estimateAltUnitCost(currentUnitCost, currentCountry, altCountry, category)` — computes what a product would cost if manufactured in `altCountry` instead of `currentCountry`

Covers 16 countries across 5 categories (Electronics, Apparel, Home, Toys, Food). Defaults to 1.20 for unknown country/category pairs.

---

## 11. RAG Pipeline

**Location:** `src/rag/`

### Ingestion (`ingest.ts`)

Run once via `npx tsx data/seedLanceDb.ts`:

```
inventory.csv
  ↓ parse CSV rows (33 SKUs)
  ↓ build embedding text: "{name} {category} {currentSourceCountry} {hsCode}"
  ↓ Xenova.embed(text) → Float32Array[384]
  ↓ LanceDB table.add({ vector, ...itemFields })
→ data/lancedb/inventory.lance (persisted)
```

### Retrieval (`retriever.ts`)

`InventoryRetriever` wraps `IInventoryStore` and provides:

```typescript
retrieve(query: string, topK?: number): Promise<RetrievedContext>
  // → store.search(query, topK)
  // → returns formatted grounding block ready for LLM injection

precisionAtK(query: string, relevantSkus: string[], k?: number): Promise<{ precision, retrieved, relevant }>
  // → measures retrieval quality without LLM (used in rag.test.ts evals)
```

### Agent-Side RAG Bypass Logic (InventoryAgent)

The InventoryAgent implements smart routing to avoid semantic search when it's the wrong tool:
- **Price queries** (cheapest, most expensive): `getAll()` → sort in JS → prevents ranking errors from cosine similarity
- **Country queries** (exact match): `getByCountry(country)` → SQL-level filter, no vectors
- **Category queries**: `getAll()` → JS filter by category
- **Semantic queries**: `search(query, 8)` → vector similarity

This ensures the LLM always receives correctly-ranked data regardless of query type.

---

## 12. Dependency Injection & Startup

**Location:** `src/lib/startup.ts`

`startup.ts` is the single DI root. It is the **only** file in the codebase that instantiates concrete adapter classes. All API routes call `await initializeApp()` first, then use the exported singletons.

### Singleton exports

```typescript
export let riskStore: IRiskStore;       // InMemoryRiskStore
export let inventoryStore: IInventoryStore; // LanceDbInventoryStore
export let tariffStore: ITariffStore;   // SqliteTariffStore
export let orchestrator: Orchestrator;  // LangGraph orchestrator
```

### Initialization sequence

```
initializeApp() — runs once per server process (guarded by 'initialized' flag)
  │
  ├─ createSqliteDb(SQLITE_PATH)
  │   └─ opens SourcingIntel.db; runs schema.sql if tables don't exist
  │
  ├─ initCountryConfig(new SqliteCountryConfigStore(db))
  │   └─ eagerly loads all country_config rows into memory
  │
  ├─ tariffStore = new SqliteTariffStore(db)
  ├─ inventoryStore = new LanceDbInventoryStore(LANCEDB_PATH, localFoundry)
  ├─ riskStore = new InMemoryRiskStore()
  │
  ├─ foundry = createFoundryClient()
  │   ├─ if AZURE_FOUNDRY_ENDPOINT set → FoundryCloudClient (reasoning=cloud, embeddings=local)
  │   └─ else → FoundryLocalClient (all on-device)
  │
  ├─ initFoundrySDK() — starts Foundry Local web service via foundry-local-sdk
  │   └─ Sets model TTL to 7200s (2h) so phi-4-mini stays loaded during demo idle time
  │
  ├─ initInternalMcpClients(rawTariffStore, rawInventoryStore, rawRiskStore)
  │   └─ Wires 3 MCP servers to InMemoryTransport clients
  │   └─ mcpTariff = McpTariffAdapter(), mcpInventory = McpInventoryAdapter(), mcpRisk = McpRiskAdapter(rawRiskStore)
  │
  ├─ Construct 6 agents (each gets MCP adapters via interfaces, never concrete classes)
  │   InventoryAgent(mcpInventory, withTracing(localFoundry, 'inventory-agent'), mcpTariff, InventoryRetriever(mcpInventory))
  │   TariffAgent(mcpTariff, withTracing(foundry, 'tariff-agent'), mcpInventory, mcpRisk)
  │   GeoRiskAgent(mcpRisk, withTracing(foundry, 'georisk-agent'))
  │   DashboardAgent(mcpTariff, mcpInventory, mcpRisk)
  │   NewsAggregatorAgent(mcpRisk, withTracing(foundry, 'news-agent'))
  │   MarketIntelAgent(withTracing(foundry, 'market-intel-agent'))
  │
  ├─ orchestrator = new Orchestrator(all 6 agents, tracedFoundry)
  │
  ├─ preSeedRiskStore(riskStore)
  │   └─ loads conflict-baseline.json → calculateSri() for each country → store.updateSri()
  │      (gives immediate non-zero SRI scores before first poll cycle)
  │
  └─ new RiskPoller(riskStore, ...).start()
      └─ setInterval every 5 min → fetch signals → classify → score → updateSri → emit
```

---

## 13. End-to-End Request Flows

### Flow 1: Simple Inventory Query

**Query:** *"Which electronics do I source from China?"*

```
[Browser] ChatInterface
  → POST /api/query { message: "Which electronics do I source from China?" }

[/api/query route.ts]
  → await initializeApp()  (no-op after first call)
  → orchestrator.route(message)

[Orchestrator — classify node]
  → lower = "which electronics do i source from china?"
  → NEWS_PATTERNS.test() → false
  → MARKET_PATTERNS.test() → false
  → hasInventory=false, hasRisk=false
  → foundry.classifyText(message, labels) → { label: "inventory", confidence: 0.92 }
  → intent = "inventory"

[Orchestrator — inventoryNode]
  → InventoryAgent.query(message)
  → lower contains "china" → getCountryConfig().getAllCountryNames().find("china") = "China"
  → store.getByCountry("China") → [3 China SKUs]
  → builds [INVENTORY DATA] grounding block
  → foundry.chat([{ role: 'user', content: groundedMessage }], SYSTEM_PROMPT)
  → phi-4-mini responds: "You source 3 electronics from China: SKU-001 USB-C Hub ($18.50)..."
  → returns { answer: "...", source: 'local' }

[Orchestrator — packInventory node]
  → finalResponse = inventoryResult

[/api/query]
  → return NextResponse.json({ answer: "...", source: "local" })

[Browser] ChatInterface renders answer text
```

---

### Flow 2: Full Comparison Query

**Query:** *"Compare sourcing China vs Vietnam for electronics — what's the risk?"*

```
[/api/query] → orchestrator.route(message)

[classify node]
  → hasInventory = /inventory|sku|items?|products?|stock/.test() → false
     but "source" triggers: "Compare sourcing" has "sourc"
     Wait, the regex is /\b(inventory|sku|items?|products?|stock|source from)\b/ — let me check
     Actually "sourcing" contains "source" but "source from" requires the literal "from"
  → Actually for this query: "sourc" is not matched exactly by the patterns
  → LLM is called: classifyText → "comparison"
  → hasInventory AND hasRisk would trigger if both patterns match
  → "risk?" matches hasRisk
  → but "sourcing" doesn't match hasInventory patterns (needs "inventory", "sku", "items", "products", "stock", or "source from")
  → LLM classifies as "comparison"
  → intent = "comparison"

[inventoryNode] → InventoryAgent.query(message)
  → "china" + "vietnam" both in getAllCountryNames()
  → takes first match: "China" → getByCountry("China") → China SKUs
  → grounded answer returned

[tariffNode] → TariffAgent.query(message)
  → getAllRates() → filter to China + Vietnam rows
  → grounded answer with rate comparison

[riskNode] → GeoRiskAgent.query(message)
  → getSriForCountry("China") + getSriForCountry("Vietnam")
  → deep-dive block: scores, signal breakdown, floor reason, alerts
  → LLM synthesizes risk comparison

[dashboardNode] → DashboardAgent.buildResponse(inv, tar)
  → getAll() → 33 SKUs
  → for each SKU: compareCountries(hsCode) → cheapest alternative
  → build SourcingRecommendation[] with annualSavingsUSD
  → append riskResult.answer to response
  → return { answer, recommendations, chartData, heatmapData, riskAlerts }

[Browser] ChatInterface renders:
  - Text answer (comparison + risk analysis)
  - CostComparisonChart (bar chart: current vs recommended)
  - SKUTable (SKUs with risk badges)
  - Risk alerts banner (if any critical alerts)
```

---

### Flow 3: Market Intelligence Query

**Query:** *"What is the current WTI oil price and how does it affect my China sourcing costs?"*

```
[classify node]
  → MARKET_PATTERNS.test("wti") → true
  → intent = "market" (no LLM call)

[marketNode] → MarketIntelAgent.query(message)

  Step 1: selectTools(message, "China")
    → MARKET_PATTERNS trigger: "wti" → get_oil_price
    → "china" mentioned → always add: get_sanctions_check, get_fx_rates, search_gdelt_news
    → "cost" → get_oil_price, get_shipping_index, get_fx_rates
    → selectedTools = ["get_oil_price", "get_shipping_index", "get_fx_rates", "get_sanctions_check", "search_gdelt_news"]

  Step 2: executeTools(selectedTools, { country: "China" })
    → get_oil_price: fetchOilPrices() → "WTI: $78.50/barrel (-0.3% today)"
    → get_shipping_index: fetchShippingIndex() → "BDI: 1,423 points (+2.1%)"
    → get_fx_rates: fetchFxRates() → "China: 1 USD = 7.24 CNY"
    → get_sanctions_check: getCountryConfig().isSanctioned("China") → false
    → search_gdelt_news: searchGdeltDirect("China", endpoint, 5) → 5 articles
    → Returns all results as { tool, result }[] via Promise.allSettled

  Step 3: build [LIVE MARKET DATA] grounding block
    → includes all 5 tool results with labeled sections
    → adds: "Tools called: get_oil_price, get_shipping_index..."
    → adds: "Country context: China"

  Step 4: foundry.chat(groundedMessage, SYSTEM_PROMPT)
    → phi-4-mini synthesizes: "WTI at $78.50 means moderate freight pressure..."

  Returns: { answer, source: 'local', toolsUsed: [...] }
```

---

### Flow 4: Real-Time Risk Update (SSE)

```
[Browser] ConflictHeatmap mounts
  → new EventSource('/api/risk-stream')

[/api/risk-stream]
  → initializeApp()
  → ReadableStream controller
  → Sends snapshot: JSON.stringify(await riskStore.getHeatmapData())
  → riskEmitter.on('update', updateListener)  ← per-connection closure
  → setInterval heartbeat every 30s

[Background — every 5 minutes]
  RiskPoller.poll()
    → fetchGdeltBatch() → [articles]
    → for each country sequentially:
        conflictClassifier.classify(articles, country) → ConflictSignal[]
        calculateSri({ country, signals, baselineRisk, tariffRate, doNotTravel })
        → SourcingRiskIndex { score, tier, trend, floorApplied, ... }
        riskStore.updateSri(sri)
          → updates Map
          → riskEmitter.emit('update', [sri])  ← triggers all connected SSE routes

[/api/risk-stream — updateListener fires]
  → controller.enqueue(`data: ${JSON.stringify([updatedSri])}\n\n`)

[Browser — EventSource.onmessage]
  → parse SourcingRiskIndex[]
  → update Leaflet layer colors by SRI score
  → update country tooltip content

[Browser disconnects]
  → ReadableStream cancel() called
  → riskEmitter.off('update', updateListener)  ← removes only THIS connection's listener
  → clearInterval(heartbeatTimer)
```

---

### Flow 5: What-If Simulation

**Request:** `GET /api/what-if?country=China&rate=40`

```
[/api/what-if]
  → initializeApp()
  → country = "China", rate = 40
  → getCountryConfig().isSanctioned("China") → false (HTTP 403 if true)

  → await Promise.all([
      simulateTariff("China", 40, inventoryStore, tariffStore),
      fetchFxRates(),
      riskStore.getSriForCountry("China"),
    ])

  simulateTariff("China", 40, ...):
    → inventoryStore.getByCountry("China") → [3 China SKUs]
    → for each SKU:
        currentRate = tariffStore.getRate("China", sku.hsCode)
        currentCost = effectiveCost(sku.unitCostUSD, currentRate.rate)
        proposedCost = effectiveCost(sku.unitCostUSD, 40)
        annualImpact = (proposedCost - currentCost) × sku.annualVolume
        cheapestAlt = tariffStore.compareCountries(sku.hsCode)[0]  // cheapest alternative
        altCost = effectiveCost(sku.unitCostUSD, cheapestAlt.rate)
        annualSavings = (proposedCost - altCost) × sku.annualVolume
    → totalPortfolioImpact = sum of all annualImpact values
    → returns WhatIfScenario { affectedSkus, totalPortfolioImpactUSD, recommendations }

  → aiNarrative = await foundry.chat(narrativePrompt)
    (2-sentence recommendation citing dollar impact + best alternative country + risk)

  → return { ...scenario, fxRates, currencyCode, aiNarrative }

[Browser] WhatIfSimulator renders:
  - Impact gauge: "+$2.1M / year" at 40% China tariff
  - Recommendation cards per SKU
  - AI narrative text
  - FX rate context (1 USD = 7.24 CNY)
```

---

### Flow 6: Morning Brief (Autonomous Agent)

**Trigger:** Vercel cron at 07:00 UTC, or manual refresh button click in the UI.

The Morning Brief is a **standalone agentic pipeline** in `app/api/morning-brief/route.ts`. It does not route through the orchestrator or any agent class — it is purpose-built to autonomously rank decisions and diff against the previous run.

```
[Vercel Cron / Browser] → GET /api/morning-brief

[/api/morning-brief]
  → initializeApp()
  → SWR cache check: if brief is fresh and no ?bust= param → return cached brief immediately

  Step 1: Parallel data fetch
  → await Promise.all([
      inventoryStore.getAll(),      // all SKUs
      tariffStore.getAllRates(),     // all tariff rows
    ])
  → Group items by currentSourceCountry in one pass (avoids N getByCountry() calls)
  → monitoredCountries = Array.from(itemsByCountry.keys())   ← derived from inventory, no hardcoding

  Step 2: Parallel risk fetch for all sourcing countries
  → await Promise.all(
      monitoredCountries.map(country => Promise.all([
        riskStore.getSriForCountry(country),
        riskStore.getConflictAlerts(country),
      ]))
    )

  Step 3: Pre-fetch tariff comparisons for all distinct HS codes (one pass, not O(n²))
  → await Promise.all(
      distinctHsCodes.map(hs => tariffStore.compareCountries(hs))
    )
  → altRatesMap: Map<hsCode, CountryRate[]>

  Step 4: Build critical alerts
  For each country where SRI tier = 'critical' or 'high':
    → Find best alternative using estimateAltUnitCost(item.unitCostUSD, srcCountry, altCountry, category)
       (manufacturing-cost-aware: adjusts for labor + logistics differences between countries)
    → Deduplicate alert headlines — pick most specific, strip RSS category suffix
    → Push one MorningBriefItem per country (not per SKU — avoids noise)

  Step 5: Build savings opportunities
  For each SKU in each country:
    → currentCost = effectiveCost(unitCostUSD, currentTariffRate)
    → altLanded = effectiveCost(estimateAltUnitCost(unitCost, src, alt, category), altRate)
    → annualSavings = (currentCost - altLanded) × annualVolume
    → Skip if savings ≤ 0

  Step 6: AI executive summary (Foundry Local phi-4-mini)
  → Prompt: 2-3 sentence brief covering (1) risk countries + SKU count, (2) top savings opportunity, (3) one action
  → Structured fallback used when Foundry is unavailable — brief always shows something useful

  Step 7: Decision Queue — rank actionable decisions by urgency score
  Risk decisions (one per critical/high country):
    urgencyScore = min(100, sriScore × (1 + riskAvoidanceUSD / totalPortfolioValue))
    Each decision includes:
      prebuiltQuery: exact chat query to auto-submit on "Approve"
      estimatedImpactUSD: sum of annual spend for affected SKUs (risk-avoidance value)
      sriScore, severity, rationale

  Savings decisions (top 6 opportunities):
    urgencyScore = min(100, (savings / totalPortfolio × 100) + sriScore × 0.30)
    Each decision includes:
      prebuiltQuery: "Compare tariff rates and switching costs for {sku} from {country}..."
      estimatedImpactUSD: annual savings amount

  → decisions sorted: urgencyScore DESC, then critical > high > medium
  → capped at 7 decisions (enough to demo without overwhelming)

  Step 8: Delta computation (diff against previous brief)
  → Reads prev brief from cache (PREV_CACHE_KEY, 24h TTL)
  → Computes: newAlerts (countries newly critical/high), resolved (were high, now safe),
              escalated (tier got worse), deEscalated (tier improved), newOpportunities (new SKU savings)
  → BriefDelta.hasDelta = false on first run (no previous brief to diff against)

  Step 9: Persist + notify
  → cache.set(CACHE_KEY, brief, SWR_TTL)          — serves subsequent requests
  → cache.set(PREV_CACHE_KEY, brief, 24h TTL)     — reference for next run's delta
  → sendBriefEmail(brief) [fire-and-forget]        — HTML email via nodemailer if SMTP configured
  → return NextResponse.json(brief)

[Browser] MorningBrief component renders:
  - AI executive summary (prose paragraph)
  - Risk alerts list (critical first, then high)
  - Savings opportunities list (sorted by annual savings DESC)
  - DecisionQueue: urgency-sorted cards with Approve / Dismiss / Defer actions
    → Approve: auto-submits prebuiltQuery to ChatInterface
    → Dismiss: removes card from queue
  - Delta badge: "+2 new alerts", "1 resolved", "China escalated safe→high"
  - Manual refresh button (?bust=true forces cache miss)
```

---

## 14. Data Models (TypeScript Interfaces)

**Location:** `src/types/index.ts` · `src/adapters/interfaces.ts`

### Core Domain Types

```typescript
// A single inventory item (one SKU)
interface InventoryItem {
  sku: string;
  name: string;
  category: 'Electronics' | 'Apparel' | 'Home' | 'Toys' | 'Food';
  currentSourceCountry: string;
  unitCostUSD: number;
  annualVolume: number;
  hsCode: string;           // 6–10 digit HS tariff classification code
  quantity: number;
}

// A US import tariff rate row
interface TariffRate {
  country: string;
  hsCode: string;
  rate: number;             // 0–100 (percentage)
  effectiveDate: string;
  tradeAgreement: string | null;  // "USMCA", "US-Jordan FTA", etc.
}

// Sourcing Risk Index — the primary risk data model
// Score formula (riskScorer.ts): newsRisk×0.30 + tariffRisk×0.25 + tradeDisruption×0.20 + baselineRisk×0.25
// Baseline raised to 25% (from original 10%) because pure-news weighting over-penalized low-signal stable countries
interface SourcingRiskIndex {
  country: string;
  countryCode: string;        // ISO 3166-1 alpha-2
  score: number;              // 0–100 (100 = maximum risk)
  tier: 'safe' | 'elevated' | 'high' | 'critical';
  signals: {
    newsRisk: number;         // 0–100, weight 30%
    tariffRisk: number;       // 0–100, weight 25%
    tradeDisruption: number;  // 0–100, weight 20%
    baselineRisk: number;     // 0–100, weight 25% (World Bank WGI or fallback JSON)
  };
  trend: 'escalating' | 'stable' | 'de-escalating';
  trendHistory: number[];     // Last 24 scores
  activeAlerts: RiskAlert[];
  floorApplied?: string;      // e.g. "active conflict → minimum 85"
  baselineSource: 'worldbank' | 'fallback';
  updatedAt: string;          // ISO timestamp
}

// A conflict signal from GDELT / RSS / State Dept
interface ConflictSignal {
  country: string;
  headline: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;         // 0–1
  source: string;
  url?: string;
  timestamp: string;
}

// An active risk alert (surfaced in UI)
interface RiskAlert {
  severity: 'low' | 'medium' | 'high' | 'critical';
  country: string;
  message: string;
  source: string;
  timestamp: string;
}

// Multi-domain convergence event
interface ConvergenceCard {
  country: string;
  countryCode: string;             // ISO 3166-1 alpha-2
  score: number;                   // convergence intensity 0–100
  severity: 'medium' | 'high' | 'critical';
  title: string;                   // e.g. "China: Multi-domain threat convergence"
  signals: string[];               // e.g. ['news:67', 'tariff:50', 'disruption:75']
  impactEstimateUSD?: number;      // estimated annual portfolio impact
  detectedAt: string;
}

// Sourcing recommendation (output of DashboardAgent / WhatIfSimulator)
interface SourcingRecommendation {
  sku: string;
  currentCountry: string;
  recommendedCountry: string;
  tippingPointRate?: number;      // tariff rate at which switching becomes cheaper (0-100)
  currentCostUSD: number;
  recommendedCostUSD: number;
  annualSavingsUSD: number;
  tariffRate: number;
  riskScore: number;
  riskAlerts: RiskAlert[];
  diversificationScore?: number;
}

// Standard agent response (all agents return this)
interface AgentResponse {
  answer: string;
  source: 'local' | 'cloud';
  recommendations?: SourcingRecommendation[];
  riskAlerts?: RiskAlert[];
  chartData?: ChartData;
  heatmapData?: SourcingRiskIndex[];
  toolsUsed?: string[];           // MCP tools called (MarketIntelAgent)
  tracingId?: string;             // Per-request tracing ID (links to /api/trace/[id])
  tracingAgent?: string;          // Which agent handled the query
  tracingDurationMs?: number;     // End-to-end LLM call duration
}

// ── Morning Brief Agent Types ─────────────────────────────────────────

// A single actionable item in the morning brief (risk alert or savings opportunity)
interface MorningBriefItem {
  sku: string;                    // SKU ID(s), comma-joined for multi-SKU risk alerts
  affectedCountry: string;
  alertType: 'conflict' | 'tariff-change' | 'trade-agreement-expiry' | 'risk-escalation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  headline: string;               // Deduplicated, cleaned headline
  recommendedAction: string;      // e.g. "Evaluate moving 3 SKUs to Vietnam"
  potentialSavingsUSD?: number;   // Present for savings opportunities only
}

// Ranked, actionable decision surfaced by the Morning Brief agent.
// The agent scores each item by urgency (risk × revenue impact) and pre-builds
// the exact query to run. User approves → query auto-submits to ChatInterface.
interface AgentDecision {
  id: string;                     // Stable ID for React key + state tracking
  type: 'risk' | 'savings' | 'diversification';
  country: string;
  sku?: string;                   // Present for savings/SKU-specific decisions
  urgencyScore: number;           // 0-100 composite score (see formula below)
  // Risk: urgencyScore = min(100, sriScore × (1 + riskAvoidanceUSD / totalPortfolioValue))
  // Savings: urgencyScore = min(100, (savings / totalPortfolio × 100) + sriScore × 0.30)
  headline: string;               // Short label shown on the decision card
  rationale: string;              // One sentence explaining why this decision matters now
  prebuiltQuery: string;          // Exact query submitted to chat agent on Approve
  estimatedImpactUSD?: number;    // Annual savings or risk-avoided annual spend
  sriScore?: number;              // Raw SRI score (for risk decisions)
  severity: 'critical' | 'high' | 'medium';
}

// Delta between the current brief and the previous one (diffed at generation time)
interface BriefDelta {
  hasDelta: boolean;              // false on first run (no previous brief)
  previousGeneratedAt?: string;
  newAlerts: string[];            // Countries newly appearing as critical/high
  resolved: string[];             // Countries that were critical/high, now safe/elevated
  escalated: { country: string; from: string; to: string }[];   // Tier got worse
  deEscalated: { country: string; from: string; to: string }[]; // Tier improved
  newOpportunities: string[];     // SKU IDs with new savings opportunities
}

// The full morning brief response
interface MorningBrief {
  generatedAt: string;            // ISO timestamp
  criticalAlerts: MorningBriefItem[];        // Sorted: critical first, then high
  savingsOpportunities: MorningBriefItem[];  // Sorted: savings DESC
  totalAffectedSkus: number;
  totalPotentialSavingsUSD: number;
  aiSummary?: string;             // LLM-generated 2-3 sentence executive brief
  decisions: AgentDecision[];     // Urgency-ranked, capped at 7 (enough to demo without overwhelming)
  delta?: BriefDelta;             // What changed since the previous brief
}
```

### Additional Domain Types

```typescript
// Supplier profile (from suppliers.json, seeded into SQLite)
interface SupplierInfo {
  country: string;
  category: string;
  leadTimeDays: number;
  reliabilityScore: number;        // 0-100
  carbonScore: number;             // 0-100, lower = more carbon-intensive
  minimumOrderQuantity: number;
}

// What-If tariff scenario result
interface WhatIfScenario {
  hypotheticalTariffRate: number;
  country: string;
  affectedSkus: string[];
  totalPortfolioImpactUSD: number;
  recommendations: SourcingRecommendation[];
  aiNarrative?: string;            // LLM-generated sourcing recommendation
  fxRates?: Record<string, number>; // live USD exchange rates at time of calculation
  currencyCode?: string;           // ISO 4217 code for the selected country
}

// Supply chain concentration health gauge
interface DiversificationHealth {
  overallScore: number;            // 0-100, higher = safer = more diversified
  concentrationWarnings: {
    country: string;
    percentage: number;            // % of total annual spend from this country
    severity: 'low' | 'medium' | 'high' | 'critical';
  }[];
  countryBreakdown: {
    country: string;
    percentage: number;
    annualSpendUSD: number;
  }[];
  recommendedActions: string[];
  aiInsight?: string;              // LLM-generated executive summary of supply chain health
}

// World Brief — AI-generated global sourcing intelligence summary
interface WorldBrief {
  summary: string;
  topRiskCountries: string[];
  headlines?: { headline: string; source: string; url?: string }[];
  updatedAt: string;
}

// Risk forecast (7-day SRI projection)
interface Forecast {
  id: string;
  category: 'conflict' | 'tariff' | 'supply-chain' | 'political' | 'port' | 'cyber';
  country: string;
  region: string;
  title: string;
  probability: number;             // 0-1
  projections: { h24: number; d7: number; d30: number };
  trend: 'escalating' | 'stable' | 'de-escalating';
  updatedAt: string;
}

// Infrastructure observability types
interface TraceRecord {
  traceId: string;                 // span-level UUID
  requestId: string;               // groups all spans for one user query
  agent: string;
  method: string;
  durationMs: number;
  timestamp: string;
  status: 'ok' | 'error';
  errorMessage?: string;
}
```

### SQLite Schema (key tables)

```sql
-- US import tariff rates
CREATE TABLE tariffs (
  id INTEGER PRIMARY KEY,
  country TEXT NOT NULL,
  hs_code TEXT NOT NULL,
  rate REAL NOT NULL,
  effective_date TEXT,
  trade_agreement TEXT
);

-- Supplier profiles
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  country TEXT NOT NULL,
  name TEXT NOT NULL,
  tier INTEGER,
  categories TEXT,
  lead_time_days INTEGER,
  min_order_usd REAL
);

-- Country configuration (floor rules, sanctions, currency, ISO codes)
CREATE TABLE country_config (
  name TEXT PRIMARY KEY,
  iso2 TEXT,
  currency TEXT,
  is_sanctioned INTEGER DEFAULT 0,
  is_high_risk INTEGER DEFAULT 0,
  is_active_conflict INTEGER DEFAULT 0,
  is_chronic_instability INTEGER DEFAULT 0,
  risk_score_override REAL,
  sanctions_detail TEXT
);
```

---

## 15. Configuration & Environment

**Files:** `.env.local` (runtime) · `.env.example` (template) · `src/lib/env.ts` (typed loader)

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `FOUNDRY_LOCAL_ENDPOINT` | No | `http://localhost:5273` | Foundry Local API base URL (auto-discovered when using SDK) |
| `FOUNDRY_LOCAL_MODEL` | Yes | — | Model name for Foundry Local (e.g. `phi-4-mini`) |
| `FOUNDRY_LOCAL_APP_NAME` | No | `SourcingIntel` | App name passed to foundry-local-sdk for logs/telemetry |
| `FOUNDRY_USE_SDK` | No | `true` | Set to `false` to bypass foundry-local-sdk and use raw HTTP |
| `LANCEDB_PATH` | Yes | — | Path to LanceDB vector store |
| `SQLITE_PATH` | Yes | — | Path to SQLite database |
| `GDELT_ENDPOINT` | Yes | — | GDELT API URL |
| `RISK_POLL_INTERVAL_MS` | No | `900000` (15min) | RiskPoller interval |
| `NEXT_PUBLIC_APP_URL` | Yes | — | App URL (for SSE absolute URLs) |
| `AZURE_FOUNDRY_ENDPOINT` | No | — | Enables Azure AI Foundry cloud fallback |
| `AZURE_FOUNDRY_API_KEY` | No | — | API key for Azure AI Foundry |
| `AZURE_FOUNDRY_MODEL` | No | `gpt-4o` | Model deployment name for Azure AI Foundry |
| `BING_SEARCH_API_KEY` | No | — | Bing Search API key (optional news source) |
| `STATE_DEPT_ADVISORY_URL` | No | `""` | US State Dept travel advisory RSS URL |
| `ALERT_EMAIL_TO` | No | — | Recipient address for morning brief HTML email |
| `SMTP_HOST` | No | — | SMTP server hostname (e.g. `smtp.sendgrid.net`) |
| `SMTP_PORT` | No | `587` | SMTP port (465 for SSL, 587 for STARTTLS) |
| `SMTP_USER` | No | — | SMTP authentication username |
| `SMTP_PASS` | No | — | SMTP authentication password / API key |

### Key Config Files

| File | Purpose |
|------|---------|
| `next.config.mjs` | `webpack.externals` for `vectordb` and `better-sqlite3` (native .node addons can't be bundled) |
| `vitest.config.mjs` | `setupFiles: ['tests/setup.ts']` — initializes CountryConfig mock before all tests |
| `vercel.json` | Cron: `{ "path": "/api/morning-brief", "schedule": "0 7 * * *" }` — 7am daily UTC |
| `tsconfig.scripts.json` | Separate tsconfig for seed scripts (CommonJS module resolution) |
| `tailwind.config.ts` | Tailwind with `content: ['./app/**/*.tsx', './src/**/*.tsx']` |
| `config/local.json` | Local deployment config: procurement team email, CC list, team name, app name, base URL. Used by `/api/notify-procurement` for email dispatch. |
| `start.ps1` | PowerShell startup script: runs `foundry service start` then `foundry model run phi-4-mini-instruct-openvino-gpu:2` to pre-load the model before `npm run dev`. |
| `scripts/warm-demo.ts` | Pre-warm script: hits all dashboard endpoints + common what-if scenarios to populate server-side cache before a live demo. Exits non-zero if any critical endpoint fails. |

---

## 16. Testing Strategy

**Location:** `tests/` · `vitest.config.mjs`

### Test Files

| File | Tests | What's Verified |
|------|-------|----------------|
| `riskScorer.test.ts` | 4 | SRI floor rules (Yemen ≥85, Russia ≥75), trend detection, low-SRI for stable countries |
| `agents.test.ts` | 6 | CircuitBreaker state machine, InventoryAgent country routing, Orchestrator intent dispatch |
| `evals.test.ts` | 44 | Orchestrator pattern matching, tariff DB accuracy (real SQLite), inventory grounding headers, MCP sanctions tool, SRI floor correctness |
| `rag.test.ts` | 14 | InventoryRetriever contract, precision@K (0%, 50%, 100%), grounding block format, metadata |

### Global Setup (`tests/setup.ts`)

Before any test runs, `initCountryConfig(mockCountryConfig)` is called with an in-memory implementation of `ICountryConfigStore`. This provides:
- Floor rules for Yemen, Russia, Iran, North Korea (active conflict / sanctions)
- Country recognition for all 40+ countries (so `InventoryAgent` detects "China" without DB)
- Sanctions check data for MCP tool tests

This means **all 69 tests run without a live SQLite database or Foundry Local instance**.

### Test Philosophy

- **No LLM mocking for agent logic**: agents are tested by verifying the grounding data passed to the LLM (`foundry.lastMessage()`), not the LLM's output
- **Real SQLite for tariff tests**: `evals.test.ts` tariff group hits the actual `data/SourcingIntel.db` file
- **Precision@K for RAG**: `rag.test.ts` verifies the retriever's contract without needing LanceDB or embeddings

---

## 17. Responsible AI Design

SourcingIntel applies Responsible AI principles at the infrastructure level, not as an afterthought:

### Privacy — On-Device by Default

All LLM inference routes through Foundry Local by default. When `AZURE_FOUNDRY_ENDPOINT` is set, the cloud adapter (`foundryCloud.ts`) still routes `generateEmbedding()` to the local client — inventory item text and pricing data never leave the device.

### Sanctions Enforcement

The `what-if` simulator enforces at the HTTP level:
```typescript
if (getCountryConfig().isSanctioned(country)) {
  return NextResponse.json({ error: "⛔ OFAC sanctions..." }, { status: 403 });
}
```

The `executeTool('get_sanctions_check', { country })` MCP tool surfaces sanctions warnings to any agent that receives OFAC-flagged countries in its context. The `InventoryAgent` emits a compliance warning directly into the LLM's user turn if any source country is sanctioned.

### Floor Rules — Non-Suppressible Risk Floors

Active conflict and sanctions floors are data-driven from the `country_config` SQLite table. They cannot be suppressed by absent news signals (e.g., if GDELT is down, Iran still gets SRI ≥ 85). The floor reason is surfaced in `SourcingRiskIndex.floorApplied` and in GeoRiskAgent responses.

### Grounded Responses — No Hallucination by Design

Every agent's LLM call uses an explicit data block in the **user turn** (not the system prompt):
```
[INVENTORY DATA — use ONLY items listed below, no other data]
...actual data rows...
[END INVENTORY DATA]
```

The system prompt instructs the model: "Use ONLY the data in the block above — never invent items not in the list." This is enforced by instruction, not by output filtering.

### Circuit Breaker — Graceful Degradation

Every external API call (GDELT, RSS, State Dept, Stooq, ECB, World Bank) goes through `CircuitBreaker`. After 3 consecutive failures, the circuit trips open and subsequent calls return the last known cached value rather than crashing the risk pipeline. This means the UI stays functional even when all external data sources are unreachable.

### Tracing — Full Observability

Every LLM call emits a structured log line:
```
[tariff-agent] traceId=abc-123 start=2026-03-22T07:00:01.234Z end=...+450ms duration=450ms
```

This gives operators full visibility into which agent made which LLM call and how long it took, without any external observability service.
