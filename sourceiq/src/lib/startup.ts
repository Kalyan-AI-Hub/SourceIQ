// src/lib/startup.ts — dependency injection root (wires all adapters + agents)
// RULE 3: This is the ONLY place that instantiates concrete classes.
// All other files depend on interfaces.
// Step 22: Auto-switches between Foundry Local and Azure AI Foundry cloud
//   - AZURE_FOUNDRY_ENDPOINT set → use cloud for reasoning, local for embeddings
//   - Otherwise → Foundry Local for everything

import { createSqliteDb } from '../db/sqlite';
import { SqliteTariffStore } from '../adapters/sqliteTariff';
import { SqliteCountryConfigStore } from '../adapters/sqliteCountryConfig';
import { LanceDbInventoryStore } from '../adapters/lanceDbInventory';
import { InMemoryRiskStore } from '../adapters/inMemoryRisk';
import { initCountryConfig, getCountryConfig } from './countryConfig';
import { detectConvergence } from '../services/convergenceDetector';
import { createFoundryLocalClient, getResolvedFoundryLocalModel, initFoundrySDK } from './foundryLocal';
import { TariffAgent } from '../agents/tariffAgent';
import { InventoryAgent } from '../agents/inventoryAgent';
import { GeoRiskAgent } from '../agents/geoRiskAgent';
import { DashboardAgent } from '../agents/dashboardAgent';
import { NewsAggregatorAgent } from '../agents/newsAggregatorAgent';
import { MarketIntelAgent } from '../agents/marketIntelAgent';
import { Orchestrator } from '../agents/orchestrator';
import { InventoryRetriever } from '../rag/retriever';
import { RiskPoller } from '../services/riskPoller';
import { withTracing } from './tracingClient';
import { calculateSri } from '../services/riskScorer';
import { initInternalMcpClients, McpTariffAdapter, McpInventoryAdapter, McpRiskAdapter } from './internalMcpClients';
import type { IRiskStore, IFoundryClient, IInventoryStore, ITariffStore } from '../adapters/interfaces';
import {
  SQLITE_PATH, LANCEDB_PATH, GDELT_ENDPOINT,
  RISK_POLL_INTERVAL_MS, AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY,
  AZURE_FOUNDRY_MODEL, STATE_DEPT_ADVISORY_URL, NEXT_PUBLIC_APP_URL,
} from './env';

/** Pre-seed the risk store with baseline-only SRI entries so queries work immediately.
 *  The first poll cycle will overwrite these with live signal data. */
async function preSeedRiskStore(store: IRiskStore): Promise<void> {
  // Load fallback JSON synchronously — instant, no network call
  let baselines: Record<string, number> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    baselines = require('../../data/conflict-baseline.json') as Record<string, number>;
  } catch { /* file not found */ }

  const { getCountryConfig } = await import('./countryConfig');
  for (const country of getCountryConfig().getAllCountryNames()) {
    const baseline = baselines[country] ?? 10;
    const sri = calculateSri({
      country,
      signals: [],              // no live signals yet
      baselineRisk: baseline,
      baselineSource: 'fallback',
      tariffRate: 0,
      doNotTravel: false,
      previousScores: [],
    });
    await store.updateSri(sri);
  }
  console.log(`[Startup] Pre-seeded risk store with baseline data for all monitored countries`);
}

// ── Process-level singleton registry ─────────────────────────────────────────
// Uses globalThis so the guard survives Next.js dev-mode per-route module
// re-evaluation. Without this, each route bundle gets its own `initialized = false`
// and spawns its own poller — causing 6+ concurrent startup cycles on page load.
declare global {
  // eslint-disable-next-line no-var
  var __sourceIQ: {
    initialized: boolean;
    initPromise: Promise<void> | null;  // prevents double-init on concurrent first requests
    riskStore: IRiskStore;
    inventoryStore: IInventoryStore;
    tariffStore: ITariffStore;
    orchestrator: Orchestrator;
    foundryClient: IFoundryClient;
  } | undefined;
  // API response cache — survives route bundle re-evaluation in Next.js dev mode
  // eslint-disable-next-line no-var
  var __sourceIQCache: Record<string, { data: unknown; at: number }>;
}

if (!globalThis.__sourceIQCache) globalThis.__sourceIQCache = {};

if (!globalThis.__sourceIQ) {
  globalThis.__sourceIQ = {
    initialized:   false,
    initPromise:   null,
    riskStore:      undefined as unknown as IRiskStore,
    inventoryStore: undefined as unknown as IInventoryStore,
    tariffStore:    undefined as unknown as ITariffStore,
    orchestrator:   undefined as unknown as Orchestrator,
    foundryClient:  undefined as unknown as IFoundryClient,
  };
}

// Module-level named exports — re-synced from globalThis on every initializeApp() call
// so any route bundle that imports them gets the shared instances, not undefined.
export let riskStore: IRiskStore;
export let inventoryStore: IInventoryStore;
export let tariffStore: ITariffStore;
export let orchestrator: Orchestrator;
export let foundryClient: IFoundryClient;

async function createFoundryClient(): Promise<IFoundryClient> {
  // Embeddings always run on Foundry Local (pricing data stays on-device — Responsible AI)
  const localClient = createFoundryLocalClient();

  if (AZURE_FOUNDRY_ENDPOINT && AZURE_FOUNDRY_API_KEY) {
    console.log('[Startup] Using Azure AI Foundry cloud for reasoning; Foundry Local for embeddings');
    const { FoundryCloudClient } = await import('../adapters/foundryCloud');
    // Cloud model name defaults to endpoint-configured deployment — override via env if needed
    const model = AZURE_FOUNDRY_MODEL;
    return new FoundryCloudClient(AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY, model, localClient);
  }

  console.log(`[Startup] Using Foundry Local for all inference`);
  return localClient;
}

async function _doInit(): Promise<void> {
  // ── Step 0: Start Foundry Local SDK web service ───────────────────────────
  // Must complete before any agent fires a chat() call.
  // In fallback mode (FOUNDRY_USE_SDK=false) this returns immediately.
  const foundryEndpoint = await initFoundrySDK();
  const foundryModel = getResolvedFoundryLocalModel();

  // Set model TTL to 7200s so phi-4-mini stays loaded during demo idle time.
  // Default TTL is 600s — a 10-min pause without queries unloads the model.
  // GET /openai/load/{name}?ttl=<seconds> overrides the auto-unload timer.
  try {
    const ttlUrl = `${foundryEndpoint}/openai/load/${encodeURIComponent(foundryModel)}?ttl=7200`;
    const ttlRes = await fetch(ttlUrl, { signal: AbortSignal.timeout(60_000) });
    if (ttlRes.ok) {
      console.log(`[Startup] Model TTL set to 7200s — ${foundryModel} stays loaded for 2h`);
    } else if (ttlRes.status === 404) {
      console.warn('[Startup] TTL endpoint is not supported by this Foundry Local runtime');
    } else {
      console.warn(`[Startup] TTL request returned ${ttlRes.status} — model may auto-unload after 10 min`);
    }
  } catch (err) {
    // Non-fatal: model loads on-demand, just adds 10-30s latency on first cold query
    console.warn('[Startup] TTL keep-alive skipped (non-fatal):', err instanceof Error ? err.message : err);
  }

  // Layer 1 — storage adapters
  const db             = createSqliteDb(SQLITE_PATH);

  // Country config must be initialized first — all agents and tools depend on it via singleton
  initCountryConfig(new SqliteCountryConfigStore(db));

  const localFoundry   = createFoundryLocalClient();  // always used for embeddings
  const foundry        = await createFoundryClient();
  const tracedFoundry  = withTracing(foundry, 'orchestrator');

  // Layer 1 — raw store instances (concrete classes, only instantiated here)
  const rawTariffStore    = new SqliteTariffStore(db);
  const rawInventoryStore = new LanceDbInventoryStore(LANCEDB_PATH, localFoundry);
  const rawRiskStore      = new InMemoryRiskStore();

  // Layer 2 — internal MCP server connections (InMemoryTransport)
  // All agent-tool interactions will traverse the MCP protocol boundary at runtime.
  await initInternalMcpClients(rawTariffStore, rawInventoryStore, rawRiskStore);
  const mcpTariff    = new McpTariffAdapter();
  const mcpInventory = new McpInventoryAdapter();
  // McpRiskAdapter delegates write ops (updateSri, convergenceCards) to rawRiskStore
  const mcpRisk      = new McpRiskAdapter(rawRiskStore);

  // Expose MCP adapters as the shared stores — API routes and agents both use these
  globalThis.__sourceIQ!.foundryClient   = foundry;
  globalThis.__sourceIQ!.tariffStore     = mcpTariff;
  globalThis.__sourceIQ!.inventoryStore  = mcpInventory;
  globalThis.__sourceIQ!.riskStore       = mcpRisk;

  // Layer 3 — agents (receive MCP adapters via store interfaces — never raw stores or concrete classes)
  const tariffAgent    = new TariffAgent(mcpTariff, withTracing(foundry, 'tariff-agent'), mcpInventory, mcpRisk);
  const inventoryAgent = new InventoryAgent(mcpInventory, withTracing(foundry, 'inventory-agent'), mcpTariff, new InventoryRetriever(mcpInventory));
  const geoRiskAgent   = new GeoRiskAgent(mcpRisk, withTracing(foundry, 'georisk-agent'));
  const dashboardAgent = new DashboardAgent(mcpTariff, mcpInventory, mcpRisk);
  const newsAgent      = new NewsAggregatorAgent(mcpRisk, withTracing(foundry, 'news-agent'));
  const marketAgent    = new MarketIntelAgent(withTracing(foundry, 'market-intel-agent'));

  globalThis.__sourceIQ!.orchestrator = new Orchestrator(
    inventoryAgent, tariffAgent, geoRiskAgent, dashboardAgent,
    tracedFoundry, newsAgent, marketAgent,
  );

  // Pre-seed store with baseline SRI so queries work immediately (before first poll cycle).
  // Uses raw store directly — pre-seeding is a startup write op, not an agent tool call.
  await preSeedRiskStore(rawRiskStore);

  // Seed initial convergence cards from baseline data so SignalConvergenceStrip shows immediately.
  // The first real poll cycle will overwrite these with live-signal convergence data.
  try {
    const allSri = await rawRiskStore.getHeatmapData();
    const sourcingCountries = new Set(
      getCountryConfig().getAll().filter(r => !r.isHighRisk).map(r => r.name),
    );
    const initialCards = detectConvergence(allSri, sourcingCountries);
    if (initialCards.length > 0) {
      await rawRiskStore.setConvergenceCards(initialCards);
      console.log(`[Startup] Initial convergence pre-seeded: ${initialCards.length} card(s)`);
    }
  } catch (err) {
    console.warn('[Startup] Initial convergence seed failed (non-fatal):', err instanceof Error ? err.message : err);
  }

  // Start background risk poller — only ONE instance across all route bundles.
  // RiskPoller writes SRI data via rawRiskStore (updateSri is a write op, not an agent read).
  // McpRiskAdapter.updateSri() delegates to rawRiskStore so data is still readable via MCP.
  const stateDeptUrl = STATE_DEPT_ADVISORY_URL;
  const poller = new RiskPoller(
    rawRiskStore, GDELT_ENDPOINT, stateDeptUrl,
    RISK_POLL_INTERVAL_MS, undefined, rawTariffStore,
  );
  poller.start();

  // Pre-warm Foundry-dependent caches sequentially in background.
  // Waits 20s for the first risk-poller cycle to populate baseline data,
  // then fills each cache one at a time so the serial Foundry queue isn't
  // overwhelmed when the browser loads and fires 5 fetches simultaneously.
  setTimeout(() => void preWarmCaches(), 20_000);
}

/** Sequential cache warm-up — each route's Foundry call finishes before the next starts. */
async function preWarmCaches(): Promise<void> {
  const baseUrl = NEXT_PUBLIC_APP_URL;
  const routes = ['/api/world-brief', '/api/morning-brief', '/api/diversification'];
  for (const route of routes) {
    try {
      await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(60_000) });
      console.log(`[PreWarm] ${route} cached`);
    } catch (err) {
      console.warn(`[PreWarm] ${route} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log('[PreWarm] All caches warmed');
}

export async function initializeApp(): Promise<void> {
  const g = globalThis.__sourceIQ!;

  // Already fully initialized — just sync module-level exports for this bundle's scope
  if (g.initialized) {
    riskStore = g.riskStore;
    inventoryStore = g.inventoryStore;
    tariffStore = g.tariffStore;
    orchestrator = g.orchestrator;
    foundryClient = g.foundryClient;
    return;
  }

  // If another bundle started init concurrently, wait for it to finish
  if (g.initPromise) {
    await g.initPromise;
    riskStore = g.riskStore;
    inventoryStore = g.inventoryStore;
    tariffStore = g.tariffStore;
    orchestrator = g.orchestrator;
    foundryClient = g.foundryClient;
    return;
  }

  // This bundle is first — run the real init and store the Promise so others wait
  g.initPromise = _doInit().then(() => { g.initialized = true; });
  await g.initPromise;

  // Sync module-level exports for this bundle
  riskStore = g.riskStore;
  inventoryStore = g.inventoryStore;
  tariffStore = g.tariffStore;
  orchestrator = g.orchestrator;
  foundryClient = g.foundryClient;
}
