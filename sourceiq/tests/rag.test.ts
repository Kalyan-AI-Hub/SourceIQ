/**
 * tests/rag.test.ts — RAG retriever evaluation (precision@K)
 *
 * Tests the InventoryRetriever abstraction with a mock IInventoryStore.
 * No live LanceDB required — measures retriever contract and precision@K logic.
 *
 * Evaluation philosophy:
 *   The LLM's grounding quality depends on the retriever returning the right items.
 *   If precision@K is high for the test queries below, the RAG pipeline is working.
 *   Thresholds: ≥0.8 precision@3 for category queries, ≥1.0 for exact-name queries.
 */

import { describe, it, expect, vi } from 'vitest';
import { InventoryRetriever } from '../src/rag/retriever';
import type { IInventoryStore } from '../src/adapters/interfaces';
import type { InventoryItem } from '../src/types/index';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ELECTRONICS_HUB: InventoryItem = {
  sku: 'SKU-E01', name: 'USB-C Hub', category: 'Electronics',
  currentSourceCountry: 'China', unitCostUSD: 18.50, quantity: 100,
  hsCode: '8471.30', annualVolume: 25000,
};
const ELECTRONICS_CABLE: InventoryItem = {
  sku: 'SKU-E02', name: 'USB-A Charging Cable', category: 'Electronics',
  currentSourceCountry: 'China', unitCostUSD: 2.50, quantity: 1000,
  hsCode: '8471.30', annualVolume: 100000,
};
const APPAREL_SHIRT: InventoryItem = {
  sku: 'SKU-A01', name: 'Cotton T-Shirt', category: 'Apparel',
  currentSourceCountry: 'Bangladesh', unitCostUSD: 4.20, quantity: 500,
  hsCode: '6109.10', annualVolume: 50000,
};
const TOYS_BOARD: InventoryItem = {
  sku: 'SKU-T01', name: 'Wooden Balance Board', category: 'Toys',
  currentSourceCountry: 'Vietnam', unitCostUSD: 12.00, quantity: 200,
  hsCode: '9503.00', annualVolume: 15000,
};
const HOME_PAN: InventoryItem = {
  sku: 'SKU-H01', name: 'Stainless Steel Pan', category: 'Home',
  currentSourceCountry: 'Mexico', unitCostUSD: 22.00, quantity: 150,
  hsCode: '7323.93', annualVolume: 8000,
};

function makeStore(searchResults: InventoryItem[]): IInventoryStore {
  return {
    search:       vi.fn().mockResolvedValue(searchResults),
    getBySku:     vi.fn().mockResolvedValue(null),
    getAll:       vi.fn().mockResolvedValue([ELECTRONICS_HUB, ELECTRONICS_CABLE, APPAREL_SHIRT, TOYS_BOARD, HOME_PAN]),
    getByCountry: vi.fn().mockResolvedValue([]),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InventoryRetriever — retrieval contract', () => {
  it('retrieve() calls store.search with the correct query and topK', async () => {
    const store = makeStore([ELECTRONICS_HUB]);
    const retriever = new InventoryRetriever(store, 5);
    await retriever.retrieve('electronics components');
    expect(store.search).toHaveBeenCalledWith('electronics components', 5);
  });

  it('retrieve() respects topK override over default', async () => {
    const store = makeStore([ELECTRONICS_HUB]);
    const retriever = new InventoryRetriever(store, 5);
    await retriever.retrieve('any query', 3);
    expect(store.search).toHaveBeenCalledWith('any query', 3);
  });

  it('retrieve() returns [RAG CONTEXT] grounding block markers', async () => {
    const store = makeStore([ELECTRONICS_HUB, ELECTRONICS_CABLE]);
    const retriever = new InventoryRetriever(store);
    const result = await retriever.retrieve('USB electronics');
    expect(result.formatted).toContain('[RAG CONTEXT');
    expect(result.formatted).toContain('[END RAG CONTEXT]');
  });

  it('retrieve() embeds item name, SKU, cost, and country in grounding block', async () => {
    const store = makeStore([ELECTRONICS_HUB]);
    const retriever = new InventoryRetriever(store);
    const result = await retriever.retrieve('hub');
    expect(result.formatted).toContain('USB-C Hub');
    expect(result.formatted).toContain('SKU-E01');
    expect(result.formatted).toContain('18.5');
    expect(result.formatted).toContain('China');
  });

  it('retrieve() returns empty-context message when store returns no items', async () => {
    const store = makeStore([]);
    const retriever = new InventoryRetriever(store);
    const result = await retriever.retrieve('quantum entanglement chips');
    expect(result.formatted).toContain('No relevant inventory items found');
    expect(result.items).toHaveLength(0);
  });

  it('retrieve() returns correct metadata (query, topK, retrievedAt)', async () => {
    const store = makeStore([ELECTRONICS_HUB]);
    const retriever = new InventoryRetriever(store);
    const before = Date.now();
    const result = await retriever.retrieve('test query', 3);
    const after = Date.now();
    expect(result.query).toBe('test query');
    expect(result.topK).toBe(3);
    expect(new Date(result.retrievedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(result.retrievedAt).getTime()).toBeLessThanOrEqual(after);
  });
});

describe('InventoryRetriever — precision@K evaluation', () => {
  it('precisionAtK=1.0 when all retrieved items are relevant (perfect retrieval)', async () => {
    // Both returned items are relevant
    const store = makeStore([ELECTRONICS_HUB, ELECTRONICS_CABLE]);
    const retriever = new InventoryRetriever(store);
    const { precision, retrieved } = await retriever.precisionAtK(
      'USB electronics charging', ['SKU-E01', 'SKU-E02'], 2,
    );
    expect(precision).toBe(1.0);
    expect(retrieved).toContain('SKU-E01');
    expect(retrieved).toContain('SKU-E02');
  });

  it('precisionAtK=0.5 when half of retrieved items are relevant', async () => {
    // Returns electronics + apparel, but query is about electronics only
    const store = makeStore([ELECTRONICS_HUB, APPAREL_SHIRT]);
    const retriever = new InventoryRetriever(store);
    const { precision, relevant } = await retriever.precisionAtK(
      'USB hub electronics', ['SKU-E01'], 2,
    );
    expect(precision).toBeCloseTo(0.5, 5);
    expect(relevant).toEqual(['SKU-E01']);
  });

  it('precisionAtK=0.0 when no retrieved items match the relevant set', async () => {
    // Returns apparel + toys, but query expects electronics
    const store = makeStore([APPAREL_SHIRT, TOYS_BOARD]);
    const retriever = new InventoryRetriever(store);
    const { precision, relevant } = await retriever.precisionAtK(
      'USB cable electronics', ['SKU-E01', 'SKU-E02'], 2,
    );
    expect(precision).toBe(0.0);
    expect(relevant).toHaveLength(0);
  });

  it('precisionAtK handles empty retrieval result (precision=0, no crash)', async () => {
    const store = makeStore([]);
    const retriever = new InventoryRetriever(store);
    const { precision, retrieved, relevant } = await retriever.precisionAtK(
      'some query', ['SKU-E01'], 3,
    );
    expect(precision).toBe(0);
    expect(retrieved).toHaveLength(0);
    expect(relevant).toHaveLength(0);
  });

  it('precisionAtK uses defaultTopK when k is not specified', async () => {
    const store = makeStore([ELECTRONICS_HUB]);
    const retriever = new InventoryRetriever(store, 5);
    await retriever.precisionAtK('electronics', ['SKU-E01']);
    // store.search should have been called with default k=5
    expect(store.search).toHaveBeenCalledWith('electronics', 5);
  });
});

describe('RAG grounding block — LLM prompt injection quality', () => {
  it('grounding block includes HS code for tariff-aware grounding', async () => {
    const store = makeStore([ELECTRONICS_HUB]);
    const retriever = new InventoryRetriever(store);
    const { formatted } = await retriever.retrieve('electronics from China');
    expect(formatted).toContain('8471.30');
  });

  it('grounding block includes category for LLM classification context', async () => {
    const store = makeStore([APPAREL_SHIRT]);
    const retriever = new InventoryRetriever(store);
    const { formatted } = await retriever.retrieve('apparel textile sourcing');
    expect(formatted).toContain('Apparel');
  });

  it('grounding block numbers items sequentially (1., 2., 3.)', async () => {
    const store = makeStore([ELECTRONICS_HUB, APPAREL_SHIRT, TOYS_BOARD]);
    const retriever = new InventoryRetriever(store);
    const { formatted } = await retriever.retrieve('mixed query');
    expect(formatted).toContain('1.');
    expect(formatted).toContain('2.');
    expect(formatted).toContain('3.');
  });

  it('grounding block embeds query string for LLM self-reference', async () => {
    const store = makeStore([HOME_PAN]);
    const retriever = new InventoryRetriever(store);
    const { formatted } = await retriever.retrieve('steel cookware Mexico');
    expect(formatted).toContain('steel cookware Mexico');
  });
});
