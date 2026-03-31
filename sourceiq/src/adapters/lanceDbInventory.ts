// src/adapters/lanceDbInventory.ts — implements IInventoryStore via LanceDB
// RULE: Use dynamic import for LanceDB — NEVER top-level import (ESM/CJS crash in Next.js)
// RULE: Constructor receives IFoundryClient — never self-creates dependencies.
// NOTE: vectordb (0.4.x) SQL filter is unreliable — use vector search + JS filter for full scans.

import type { IInventoryStore, IFoundryClient } from './interfaces';
import type { InventoryItem } from '../types/index';
import { cache, TTL, SWR } from '../lib/cache';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

function stripVector({ vector: _v, ...item }: any): InventoryItem { return item as InventoryItem; }

// LanceDB v0.4 SQL filters miss rows — use a dummy vector scan to retrieve all rows
const DUMMY_VEC = new Array(384).fill(0.1);
const ALL_ROWS_LIMIT = 500;

// Inventory data is stable during a demo session — cache full scans aggressively
const INV_TTL = { ttlMs: TTL.SHORT, swrMs: SWR.SHORT, tags: ['inventory'] } as const;

export class LanceDbInventoryStore implements IInventoryStore {
  constructor(
    private readonly dbPath: string,
    private readonly foundry: IFoundryClient,
  ) {}

  private async openTable() {
    const { connect } = await import('vectordb');
    const db = await connect(this.dbPath);
    return db.openTable('inventory');
  }

  /** Full table scan — cached; all derived methods draw from this pool */
  private async allRows(): Promise<InventoryItem[]> {
    return cache.getOrCompute(
      'inventory:all',
      async () => {
        const table = await this.openTable();
        const rows: any[] = await (table as any).search(DUMMY_VEC).limit(ALL_ROWS_LIMIT).execute();
        return rows.map(stripVector);
      },
      { ttlMs: INV_TTL.ttlMs, swrMs: INV_TTL.swrMs, tags: [...INV_TTL.tags] },
    );
  }

  async search(query: string, limit = 5): Promise<InventoryItem[]> {
    // Vector search uses the embedding — can't dedupe from the full-scan cache.
    // Cache by normalized query string to avoid re-embedding identical queries.
    const key = `inventory:search:${query.toLowerCase().trim()}:${limit}`;
    return cache.getOrCompute(
      key,
      async () => {
        const embedding = await this.foundry.generateEmbedding(query);
        const table = await this.openTable();
        const results: any[] = await (table as any).search(embedding).limit(limit).execute();
        return results.map(stripVector);
      },
      { ttlMs: INV_TTL.ttlMs, swrMs: INV_TTL.swrMs, tags: [...INV_TTL.tags] },
    );
  }

  async getBySku(sku: string): Promise<InventoryItem | null> {
    const all = await this.allRows();
    return all.find(r => r.sku === sku) ?? null;
  }

  async getAll(): Promise<InventoryItem[]> {
    return this.allRows();
  }

  async getByCountry(country: string): Promise<InventoryItem[]> {
    const all = await this.allRows();
    return all.filter(r => r.currentSourceCountry === country);
  }
}
