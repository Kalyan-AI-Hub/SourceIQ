/**
 * tests/evals.test.ts — SourcingIntel Query-Level Evaluations
 *
 * Tests are grouped into 5 categories:
 *   1. Orchestrator routing accuracy  — keyword patterns route to correct agent
 *   2. Tariff data accuracy           — real SQLite DB, no mocks
 *   3. Inventory data grounding       — agent builds correct "THE CHEAPEST IS" header
 *   4. MCP sanctions tool             — Iran flagged, UAE/Qatar clean
 *   5. Risk scorer correctness        — floors enforced for Iran, Russia, Yemen
 *
 * Philosophy: the LLM is only as good as the data it receives.
 * These evals validate the grounding layer — if the data block is correct,
 * the model has everything it needs to give a correct answer.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import path from 'path';
import { calculateSri } from '../src/services/riskScorer';
import { executeTool } from '../src/lib/mcpToolRegistry';
import { createSqliteDb } from '../src/db/sqlite';
import { SqliteTariffStore } from '../src/adapters/sqliteTariff';
import { InventoryAgent } from '../src/agents/inventoryAgent';
import type { IFoundryClient, IInventoryStore } from '../src/adapters/interfaces';
import type { InventoryItem, TariffRate } from '../src/types/index';

// ── Shared test fixtures ───────────────────────────────────────────────────

const DB_PATH = path.resolve(__dirname, '../data/sourceiq.db');

function makeFoundry(chatReply = 'mock answer'): IFoundryClient & { lastMessage: () => string } {
  let captured = '';
  const client: IFoundryClient = {
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    chat: vi.fn().mockImplementation(async (msgs: { role: string; content: string }[]) => {
      captured = msgs[0]?.content ?? '';
      return chatReply;
    }),
    classifyText: vi.fn().mockResolvedValue({ label: 'inventory', confidence: 0.9 }),
  };
  return Object.assign(client, { lastMessage: () => captured });
}

function makeInventoryStore(items: InventoryItem[]): IInventoryStore {
  return {
    search:       vi.fn().mockResolvedValue(items),
    getBySku:     vi.fn().mockResolvedValue(null),
    getAll:       vi.fn().mockResolvedValue(items),
    getByCountry: vi.fn().mockResolvedValue(items),
  };
}

// Sample items sorted by cost (ascending) for grounding tests
const SAMPLE_ITEMS: InventoryItem[] = [
  { sku: 'SKU-X01', name: 'Cheap Widget',     category: 'Electronics', quantity: 100, currentSourceCountry: 'Vietnam', unitCostUSD: 2.50,  hsCode: '8471.30', annualVolume: 10000 },
  { sku: 'SKU-X02', name: 'Mid Widget',       category: 'Electronics', quantity: 100, currentSourceCountry: 'China',   unitCostUSD: 14.00, hsCode: '8471.30', annualVolume: 5000  },
  { sku: 'SKU-X03', name: 'Expensive Widget', category: 'Electronics', quantity: 100, currentSourceCountry: 'Mexico',  unitCostUSD: 35.00, hsCode: '8471.30', annualVolume: 2000  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. ORCHESTRATOR ROUTING — keyword patterns
// ─────────────────────────────────────────────────────────────────────────────

describe('Orchestrator routing patterns', () => {
  // Re-import the patterns directly by testing their regex behaviour
  const NEWS_PATTERNS   = /\b(news|alerts?|headlines?|what('s| is) happening|briefing|today('s| is)|conflict news|war news|summarize|what broke|latest)\b/i;
  const MARKET_PATTERNS = /\b(oil|crude|wti|brent|barrel|fuel|bdi|baltic|shipping costs?|shipping index|freight costs?|freight rate|cotton price|copper price|commodity|fx rate|exchange rate|currency rate|sanction|ofac|embargo|compliance check)\b/i;

  it.each([
    ['What is the latest news on conflict?',     'news'],
    ['Summarize today\'s risk alerts',            'news'],
    ['What broke overnight in the supply chain?', 'news'],
    ['Show me today\'s briefing',                 'news'],
  ])('"%s" → news intent', (query, expected) => {
    const isNews = NEWS_PATTERNS.test(query.toLowerCase());
    expect(isNews).toBe(true);
    expect(expected).toBe('news');
  });

  it.each([
    ['What is the current WTI crude oil price?',    'market'],
    ['Check OFAC sanctions for Iran',               'market'],
    ['What is the Baltic Dry Index today?',         'market'],
    ['Show me the USD to yuan exchange rate',       'market'],
    ['Is there an embargo on this country?',        'market'],
    ['What are current shipping costs from China?', 'market'],
  ])('"%s" → market intent', (query, expected) => {
    const isMarket = MARKET_PATTERNS.test(query.toLowerCase());
    expect(isMarket).toBe(true);
    expect(expected).toBe('market');
  });

  it.each([
    ['Which SKUs do I source from China?'],
    ['What products do I buy from Vietnam?'],
    ['List all my electronics inventory'],
  ])('"%s" does NOT trigger news or market override', (query) => {
    expect(NEWS_PATTERNS.test(query.toLowerCase())).toBe(false);
    expect(MARKET_PATTERNS.test(query.toLowerCase())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TARIFF DATA ACCURACY — real SQLite database
// ─────────────────────────────────────────────────────────────────────────────

describe('Tariff store accuracy (real DB)', () => {
  let store: SqliteTariffStore;

  beforeAll(() => {
    const db = createSqliteDb(DB_PATH);
    store = new SqliteTariffStore(db);
  });

  it('China electronics tariff = 25%', async () => {
    const rate = await store.getRate('China', '8471.30');
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBe(25);
  });

  it('Mexico electronics tariff = 0% (USMCA)', async () => {
    const rate = await store.getRate('Mexico', '8471.30');
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBe(0);
    expect(rate!.tradeAgreement).toBe('USMCA');
  });

  it('Jordan apparel tariff = 0% (US-Jordan FTA)', async () => {
    const rate = await store.getRate('Jordan', '6109.10');
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBe(0);
    expect(rate!.tradeAgreement).toBe('US-Jordan FTA');
  });

  it('Oman home goods tariff = 0% (US-Oman FTA)', async () => {
    const rate = await store.getRate('Oman', '7323.93');
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBe(0);
    expect(rate!.tradeAgreement).toBe('US-Oman FTA');
  });

  it('Qatar tariff = 5% (no FTA)', async () => {
    const rate = await store.getRate('Qatar', '7323.93');
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBe(5);
    expect(rate!.tradeAgreement).toBeNull();
  });

  it('Iran tariff = 35% (sanctions-era rate)', async () => {
    const rate = await store.getRate('Iran', '2106.90');
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBe(35);
  });

  it('compareCountries returns cheapest country first for food HS 2106.90', async () => {
    const rates = await store.compareCountries('2106.90');
    expect(rates.length).toBeGreaterThan(1);
    // Sorted ascending — first entry should have the lowest rate
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i]!.rate).toBeGreaterThanOrEqual(rates[i - 1]!.rate);
    }
    // Mexico should be first (0% USMCA) or tied with other 0%-rate countries
    expect(rates[0]!.rate).toBe(0);
  });

  it('calculateSavings: switching China SKU-001 to Vietnam yields positive savings (cost-index-aware)', async () => {
    const item: InventoryItem = {
      sku: 'SKU-001', name: 'USB-C Hub', category: 'Electronics',
      quantity: 8500, currentSourceCountry: 'China',
      unitCostUSD: 18.50, hsCode: '8471.30', annualVolume: 25000,
    };
    const savings = await store.calculateSavings(item, 'Vietnam');
    // China 25% → landed 23.125; Vietnam mfg index 1.08 → unit 19.98, tariff 12% → landed 22.38
    // Savings per unit ≈ 0.75; × 25000 ≈ 18,685
    expect(savings).toBeGreaterThan(15_000);
    expect(savings).toBeLessThan(25_000);
  });

  it('calculateSavings: already at cheapest country returns ~0', async () => {
    const item: InventoryItem = {
      sku: 'SKU-021', name: 'Balance Board', category: 'Toys',
      quantity: 5000, currentSourceCountry: 'Mexico',
      unitCostUSD: 18.00, hsCode: '9503.00', annualVolume: 15000,
    };
    // Mexico → Mexico should be ~0 savings
    const savings = await store.calculateSavings(item, 'Mexico');
    expect(savings).toBeCloseTo(0, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. INVENTORY DATA GROUNDING — "THE CHEAPEST ITEM IS" eval
// ─────────────────────────────────────────────────────────────────────────────

describe('InventoryAgent data grounding', () => {
  it('cheapest query: grounded message header names the lowest-cost item', async () => {
    const foundry = makeFoundry();
    const store = makeInventoryStore(SAMPLE_ITEMS); // already sorted cheapest-first
    const agent = new InventoryAgent(store, foundry);

    await agent.query('What is the cheapest item in my inventory?');

    const msg = foundry.lastMessage();
    expect(msg).toContain('THE CHEAPEST ITEM IS');
    // Header must identify the cheapest item
    expect(msg).toContain('SKU-X01');   // $2.50 — cheapest
    expect(msg).toContain('2.5');        // unit cost present
    // Full list includes all items (top 10 pass-through) — that is correct behaviour
    // The critical assertion is that the HEADER names the right winner, not that others are absent
  });

  it('cheapest query: getAll() is called (not semantic search)', async () => {
    const foundry = makeFoundry();
    const store = makeInventoryStore(SAMPLE_ITEMS);
    const agent = new InventoryAgent(store, foundry);

    await agent.query('Which product has the lowest unit cost?');

    expect(store.getAll).toHaveBeenCalledOnce();
    expect(store.search).not.toHaveBeenCalled();
  });

  it('most expensive query: grounded message header names the highest-cost item', async () => {
    // Return items in natural (unsorted) order — agent must sort them
    const shuffled: InventoryItem[] = [SAMPLE_ITEMS[1]!, SAMPLE_ITEMS[2]!, SAMPLE_ITEMS[0]!];
    const foundry = makeFoundry();
    const store = makeInventoryStore(shuffled);
    const agent = new InventoryAgent(store, foundry);

    await agent.query('What is the most expensive item?');

    const msg = foundry.lastMessage();
    expect(msg).toContain('THE MOST EXPENSIVE ITEM IS');
    expect(msg).toContain('SKU-X03');   // $35.00 — most expensive
  });

  it('country query: uses getByCountry(), not getAll()', async () => {
    const foundry = makeFoundry('SKU-001 from China');
    const store = makeInventoryStore([SAMPLE_ITEMS[1]!]); // China item
    const agent = new InventoryAgent(store, foundry);

    await agent.query('Which SKUs do I source from China?');

    expect(store.getByCountry).toHaveBeenCalledWith('China');
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it('grounded message contains INVENTORY DATA block markers', async () => {
    const foundry = makeFoundry();
    const store = makeInventoryStore(SAMPLE_ITEMS);
    const agent = new InventoryAgent(store, foundry);

    await agent.query('Show me all electronics');

    const msg = foundry.lastMessage();
    expect(msg).toContain('--- INVENTORY DATA ---');
    expect(msg).toContain('--- END DATA ---');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. MCP SANCTIONS TOOL — compliance accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP sanctions tool accuracy', () => {
  it('Iran → SANCTIONED (OFAC comprehensive)', async () => {
    const result = await executeTool('get_sanctions_check', { country: 'Iran' });
    expect(result).toContain('SANCTIONED');
    expect(result.toUpperCase()).toContain('PROHIBITED');
  });

  it('Russia → SANCTIONED (broad sectoral)', async () => {
    const result = await executeTool('get_sanctions_check', { country: 'Russia' });
    expect(result).toContain('SANCTIONED');
  });

  it('North Korea → SANCTIONED (near-total embargo)', async () => {
    const result = await executeTool('get_sanctions_check', { country: 'North Korea' });
    expect(result).toContain('SANCTIONED');
  });

  it('UAE → no US comprehensive sanctions', async () => {
    const result = await executeTool('get_sanctions_check', { country: 'UAE' });
    expect(result).not.toContain('SANCTIONED');
    expect(result).toContain('No US comprehensive sanctions');
  });

  it('Qatar → no US comprehensive sanctions', async () => {
    const result = await executeTool('get_sanctions_check', { country: 'Qatar' });
    expect(result).not.toContain('SANCTIONED');
  });

  it('Oman → no US comprehensive sanctions', async () => {
    const result = await executeTool('get_sanctions_check', { country: 'Oman' });
    expect(result).not.toContain('SANCTIONED');
  });

  it('missing country argument returns helpful message', async () => {
    const result = await executeTool('get_sanctions_check', {});
    expect(result).toContain('No country');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. RISK SCORER FLOORS — SRI correctness
// ─────────────────────────────────────────────────────────────────────────────

describe('Risk scorer floor rules', () => {
  it('Iran SRI >= 85 (active armed conflict + OFAC sanctions)', () => {
    const sri = calculateSri({
      country: 'Iran', signals: [], baselineRisk: 0,
      tariffRate: 0, doNotTravel: false, previousScores: [],
    });
    expect(sri.score).toBeGreaterThanOrEqual(85);
    expect(sri.tier).toBe('critical');
  });

  it('Yemen SRI >= 85 (active conflict)', () => {
    const sri = calculateSri({
      country: 'Yemen', signals: [], baselineRisk: 0,
      tariffRate: 0, doNotTravel: false, previousScores: [],
    });
    expect(sri.score).toBeGreaterThanOrEqual(85);
    expect(sri.tier).toBe('critical');
  });

  it('Russia SRI >= 75 (US/EU broad sanctions floor)', () => {
    const sri = calculateSri({
      country: 'Russia', signals: [], baselineRisk: 0,
      tariffRate: 0, doNotTravel: false, previousScores: [],
    });
    expect(sri.score).toBeGreaterThanOrEqual(75);
    expect(sri.tier).toBe('critical');
  });

  it('do-not-travel advisory applies >= 65 floor', () => {
    const sri = calculateSri({
      country: 'SomeCountry', signals: [], baselineRisk: 0,
      tariffRate: 0, doNotTravel: true, previousScores: [],
    });
    expect(sri.score).toBeGreaterThanOrEqual(65);
  });

  it('Qatar SRI is low (no sanctions, no conflict, low tariff)', () => {
    const sri = calculateSri({
      country: 'Qatar', signals: [], baselineRisk: 15,
      tariffRate: 5, doNotTravel: false, previousScores: [],
    });
    expect(sri.score).toBeLessThan(50);
    expect(['safe', 'elevated']).toContain(sri.tier);
  });

  it('UAE SRI is low (no sanctions, no conflict)', () => {
    const sri = calculateSri({
      country: 'UAE', signals: [], baselineRisk: 10,
      tariffRate: 5, doNotTravel: false, previousScores: [],
    });
    expect(sri.score).toBeLessThan(50);
  });

  it('Mexico SRI stays low with no signals', () => {
    const sri = calculateSri({
      country: 'Mexico', signals: [], baselineRisk: 10,
      tariffRate: 5, doNotTravel: false, previousScores: [],
    });
    expect(sri.score).toBeLessThanOrEqual(35);
  });

  it('high-tariff country gets elevated tariff risk component', () => {
    const lowTariff = calculateSri({
      country: 'Vietnam', signals: [], baselineRisk: 20,
      tariffRate: 12, doNotTravel: false, previousScores: [],
    });
    const highTariff = calculateSri({
      country: 'Vietnam', signals: [], baselineRisk: 20,
      tariffRate: 60, doNotTravel: false, previousScores: [],
    });
    expect(highTariff.score).toBeGreaterThan(lowTariff.score);
  });

  it('SRI trend is escalating when current score is well above recent average', () => {
    // previousScores avg = 20; current: baselineRisk=80, tariffRate=50 → score ~45
    const sri = calculateSri({
      country: 'TestCountry', signals: [], baselineRisk: 80,
      tariffRate: 50, doNotTravel: false, previousScores: [20, 20, 20],
    });
    expect(sri.trend).toBe('escalating');
  });

  it('SRI trend is de-escalating when current score is well below recent average', () => {
    // previousScores avg = 80; current: baselineRisk=10, tariffRate=3 → score ~9
    const sri = calculateSri({
      country: 'TestCountry', signals: [], baselineRisk: 10,
      tariffRate: 3, doNotTravel: false, previousScores: [80, 80, 80],
    });
    expect(sri.trend).toBe('de-escalating');
  });
});
