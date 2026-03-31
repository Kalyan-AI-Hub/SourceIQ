// src/rag/retriever.ts — RAG retriever abstraction over the LanceDB vector store
// Provides a typed semantic retrieval interface separate from the inventory adapter.
// Agents use this to retrieve grounding context without knowing the vector DB internals.
// Supports precision@K evaluation for measuring retrieval quality.

import type { IInventoryStore } from '../adapters/interfaces';
import type { InventoryItem } from '../types/index';

export interface RetrievedContext {
  items: InventoryItem[];
  query: string;
  topK: number;
  retrievedAt: string;
  /** LLM-ready grounding block — inject directly into a user-turn message */
  formatted: string;
}

export class InventoryRetriever {
  constructor(
    private readonly store: IInventoryStore,
    private readonly defaultTopK = 5,
  ) {}

  /**
   * Semantic retrieval: embed the query and return the top-K most similar inventory items.
   * Results are formatted into a grounding block ready for injection into an LLM prompt.
   */
  async retrieve(query: string, topK?: number): Promise<RetrievedContext> {
    const k = topK ?? this.defaultTopK;
    const items = await this.store.search(query, k);

    const formatted =
      items.length === 0
        ? '[RAG CONTEXT: No relevant inventory items found for this query]'
        : [
            `[RAG CONTEXT — top ${items.length} semantically similar items for: "${query}"]`,
            ...items.map(
              (item, i) =>
                `${i + 1}. ${item.name} (${item.sku}) — $${item.unitCostUSD}/unit` +
                ` from ${item.currentSourceCountry} | ${item.category} | HS: ${item.hsCode}`,
            ),
            `[END RAG CONTEXT]`,
          ].join('\n');

    return {
      items,
      query,
      topK: k,
      retrievedAt: new Date().toISOString(),
      formatted,
    };
  }

  /**
   * Precision@K evaluation: for a test query with known relevant SKUs,
   * returns the fraction of top-K retrieved results that are relevant.
   * Use this to measure RAG retrieval quality without a live LLM.
   *
   * @param query       - Natural language query
   * @param relevantSkus - Ground-truth set of SKUs that should appear in top-K results
   * @param k           - Number of results to retrieve (default: defaultTopK)
   * @returns precision  - fraction of retrieved items that were relevant (0.0–1.0)
   */
  async precisionAtK(
    query: string,
    relevantSkus: string[],
    k?: number,
  ): Promise<{ precision: number; retrieved: string[]; relevant: string[] }> {
    const { items } = await this.retrieve(query, k ?? this.defaultTopK);
    const retrieved = items.map(i => i.sku);
    const relevant = retrieved.filter(sku => relevantSkus.includes(sku));
    return {
      precision: retrieved.length === 0 ? 0 : relevant.length / retrieved.length,
      retrieved,
      relevant,
    };
  }
}
