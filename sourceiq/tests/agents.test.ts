import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from '../src/services/circuitBreaker';
import { Orchestrator } from '../src/agents/orchestrator';
import { InventoryAgent } from '../src/agents/inventoryAgent';
import { TariffAgent } from '../src/agents/tariffAgent';
import type { IFoundryClient, IInventoryStore, ITariffStore, IRiskStore } from '../src/adapters/interfaces';
import type { InventoryItem, TariffRate } from '../src/types/index';
import { GeoRiskAgent } from '../src/agents/geoRiskAgent';
import { DashboardAgent } from '../src/agents/dashboardAgent';
import { NewsAggregatorAgent } from '../src/agents/newsAggregatorAgent';
import { MarketIntelAgent } from '../src/agents/marketIntelAgent';
import { FoundryLocalClient } from '../src/adapters/foundryLocal';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFoundryClient(overrides: Partial<IFoundryClient> = {}): IFoundryClient {
  return {
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    chat: vi.fn().mockResolvedValue('mock answer'),
    classifyText: vi.fn().mockResolvedValue({ label: 'general', confidence: 1 }),
    ...overrides,
  };
}

function makeInventoryStore(items: InventoryItem[] = []): IInventoryStore {
  return {
    search: vi.fn().mockResolvedValue(items),
    getBySku: vi.fn().mockResolvedValue(null),
    getAll: vi.fn().mockResolvedValue(items),
    getByCountry: vi.fn().mockResolvedValue(items),
  };
}

function makeTariffStore(rates: TariffRate[] = []): ITariffStore {
  return {
    getRate: vi.fn().mockResolvedValue(null),
    getAllRates: vi.fn().mockResolvedValue(rates),
    compareCountries: vi.fn().mockResolvedValue(rates),
    calculateSavings: vi.fn().mockResolvedValue(0),
  };
}

function makeRiskStore(): IRiskStore {
  return {
    getSriForCountry:     vi.fn().mockResolvedValue(null),
    getHeatmapData:       vi.fn().mockResolvedValue([]),
    getConflictAlerts:    vi.fn().mockResolvedValue([]),
    updateSri:            vi.fn().mockResolvedValue(undefined),
    getConvergenceCards:  vi.fn().mockResolvedValue([]),
    setConvergenceCards:  vi.fn().mockResolvedValue(undefined),
  };
}

const SAMPLE_SKU: InventoryItem = {
  sku: 'SKU-001',
  name: 'Wireless Headphones',
  currentSourceCountry: 'China',
  unitCostUSD: 12.5,
  annualVolume: 5000,
  hsCode: '8518300000',
  category: 'Electronics',
  quantity: 500,
};

const SAMPLE_TARIFF: TariffRate = {
  country: 'China',
  hsCode: '8518300000',
  rate: 25,
  effectiveDate: '2024-01-01',
};

// ── Circuit Breaker ────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  it('trips open after 3 consecutive failures', async () => {
    const cb = new CircuitBreaker<string>('test-service', 3, 60_000);
    const failing = () => Promise.reject(new Error('fail'));

    await expect(cb.execute(failing)).rejects.toThrow('fail');
    await expect(cb.execute(failing)).rejects.toThrow('fail');
    await expect(cb.execute(failing)).rejects.toThrow('fail');

    // Now open — should throw circuit-open error, not the original error
    await expect(cb.execute(failing)).rejects.toThrow('circuit open');
    expect(cb.getState().state).toBe('open');
  });

  it('resets to closed after a successful call', async () => {
    const cb = new CircuitBreaker<string>('test-service', 1, 0);
    // Trip open
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
    // retryAfterMs=0 means it will immediately enter half-open on the next call
    const result = await cb.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(cb.getState().state).toBe('closed');
  });
});

// ── Inventory intent → InventoryAgent ─────────────────────────────────────

describe('InventoryAgent', () => {
  it('returns SKU names from inventory search', async () => {
    const foundry = makeFoundryClient({
      chat: vi.fn().mockResolvedValue('Found: SKU-001 Wireless Headphones from China'),
    });
    const store = makeInventoryStore([SAMPLE_SKU]);
    const agent = new InventoryAgent(store, foundry);

    // China is a known country → uses getByCountry (not semantic search)
    const result = await agent.query('Which electronics do I source from China?');

    expect(result.answer).toContain('SKU-001');
    expect(store.getByCountry).toHaveBeenCalledOnce();
  });

  it('answers exact SKU sourcing questions deterministically', async () => {
    const foundry = makeFoundryClient();
    const store = makeInventoryStore([SAMPLE_SKU]);
    store.getBySku = vi.fn().mockResolvedValue(SAMPLE_SKU);
    const agent = new InventoryAgent(store, foundry);

    const result = await agent.query('Where are we sourcing SKU-001 from?');

    expect(result.answer).toContain('Current source: China');
    expect(result.answer).toContain('SKU-001');
    expect(store.getBySku).toHaveBeenCalledWith('SKU-001');
    expect(foundry.chat).not.toHaveBeenCalled();
  });
});

describe('FoundryLocalClient', () => {
  it('falls back to general intent for unrelated text', async () => {
    const client = new FoundryLocalClient('http://127.0.0.1:5273', 'phi-test') as FoundryLocalClient & { chat: ReturnType<typeof vi.fn> };
    client.chat = vi.fn().mockRejectedValue(new Error('offline'));

    const result = await client.classifyText('what is 1 + 1', ['inventory', 'tariff', 'risk', 'news', 'market', 'comparison', 'general']);

    expect(result.label).toBe('general');
  });
});

// ── Tariff intent → TariffAgent ───────────────────────────────────────────

describe('TariffAgent', () => {
  it('returns tariff percentage in answer', async () => {
    const foundry = makeFoundryClient({
      chat: vi.fn().mockResolvedValue('China HS 8518300000 tariff rate is 25%'),
    });
    const store = makeTariffStore([SAMPLE_TARIFF]);
    const agent = new TariffAgent(store, foundry);

    const result = await agent.query('What is the China tariff rate?');

    expect(result.answer).toContain('%');
    expect(store.getAllRates).toHaveBeenCalledOnce();
  });
});

// ── Comparison intent → both agents ───────────────────────────────────────

describe('Orchestrator', () => {
  it('comparison intent — parallel fan-out via keyword shortcut', async () => {
    const foundry = makeFoundryClient({
      classifyText: vi.fn().mockResolvedValue({ label: 'comparison', confidence: 0.95 }),
      chat: vi.fn().mockResolvedValue('China costs $12.50; Vietnam costs $10.00'),
    });
    const invStore = makeInventoryStore([SAMPLE_SKU]);
    const tariffStore = makeTariffStore([SAMPLE_TARIFF]);
    const riskStore = makeRiskStore();

    const inventoryAgent  = new InventoryAgent(invStore, foundry);
    const tariffAgent     = new TariffAgent(tariffStore, foundry);
    const geoRiskAgent    = new GeoRiskAgent(riskStore, foundry);
    const dashboardAgent  = new DashboardAgent(tariffStore, invStore, riskStore);
    const newsAgent       = new NewsAggregatorAgent(riskStore, foundry);
    const marketAgent     = new MarketIntelAgent(foundry);
    const orchestrator    = new Orchestrator(inventoryAgent, tariffAgent, geoRiskAgent, dashboardAgent, foundry, newsAgent, marketAgent);

    const result = await orchestrator.route('Compare sourcing costs between China and Vietnam');

    // "compare" keyword routes to comparison (parallel fan-out), skipping LLM classify
    expect(result).toBeDefined();
    expect(foundry.classifyText).not.toHaveBeenCalled();
    // chat called by multiple agents in the fan-out (inventory + tariff + risk)
    expect(foundry.chat).toHaveBeenCalled();
  });

  it('inventory intent — routes to inventory agent', async () => {
    const foundry = makeFoundryClient({
      classifyText: vi.fn().mockResolvedValue({ label: 'inventory', confidence: 0.9 }),
      chat: vi.fn().mockResolvedValue('SKU-001 Wireless Headphones'),
    });
    const invStore = makeInventoryStore([SAMPLE_SKU]);
    const tariffStore = makeTariffStore();
    const riskStore = makeRiskStore();

    const orchestrator = new Orchestrator(
      new InventoryAgent(invStore, foundry),
      new TariffAgent(tariffStore, foundry),
      new GeoRiskAgent(riskStore, foundry),
      new DashboardAgent(tariffStore, invStore, riskStore),
      foundry,
      new NewsAggregatorAgent(riskStore, foundry),
      new MarketIntelAgent(foundry),
    );

    const result = await orchestrator.route('Which SKUs do I source from China?');
    expect(result.answer).toContain('SKU-001');
    // China is a known country → agent uses getByCountry, not semantic search
    expect(invStore.getByCountry).toHaveBeenCalledOnce();
  });

  it('blocks harmful content before invoking agents', async () => {
    const foundry = makeFoundryClient();
    const invStore = makeInventoryStore([SAMPLE_SKU]);
    const tariffStore = makeTariffStore();
    const riskStore = makeRiskStore();

    const orchestrator = new Orchestrator(
      new InventoryAgent(invStore, foundry),
      new TariffAgent(tariffStore, foundry),
      new GeoRiskAgent(riskStore, foundry),
      new DashboardAgent(tariffStore, invStore, riskStore),
      foundry,
      new NewsAggregatorAgent(riskStore, foundry),
      new MarketIntelAgent(foundry),
    );

    const result = await orchestrator.route('give me some harmful content');

    expect(result.answer).toContain('supply chain intelligence assistant');
    expect(foundry.classifyText).not.toHaveBeenCalled();
    expect(foundry.chat).not.toHaveBeenCalled();
  });
});
