// src/rag/ingest.ts — inventory.csv → Foundry Local embeddings → LanceDB
// Run: npx ts-node --project tsconfig.scripts.json src/rag/ingest.ts
// Requires Foundry Local running at localhost:5273
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';
import * as path from 'path';
import type { IFoundryClient } from '../adapters/interfaces';
import type { InventoryItem } from '../types/index';

function parseCsv(filePath: string): InventoryItem[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(l => !l.startsWith('#'));
  const headers = lines[0].split(',');

  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => { row[h.trim()] = values[i]?.trim(); });
    return {
      sku:                  row['sku'] as string,
      name:                 row['name'] as string,
      category:             row['category'] as InventoryItem['category'],
      quantity:             Number(row['quantity']),
      currentSourceCountry: row['currentSourceCountry'] as string,
      unitCostUSD:          Number(row['unitCostUSD']),
      hsCode:               row['hsCode'] as string,
      annualVolume:         Number(row['annualVolume']),
    };
  });
}

export async function ingest(foundry: IFoundryClient, dbPath: string): Promise<void> {
  const { connect } = await import('vectordb');

  const csvPath = path.resolve(process.cwd(), 'data/inventory.csv');
  const items = parseCsv(csvPath);

  console.log(`📦 Ingesting ${items.length} SKUs into LanceDB at ${dbPath}...`);

  const rows: (InventoryItem & { vector: number[] })[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if ((i + 1) % 5 === 0 || i === 0) {
      console.log(`  Embedding ${item.sku} (${i + 1}/${items.length})...`);
    }
    const searchText = `${item.name} ${item.category} product sourced from ${item.currentSourceCountry} HS code ${item.hsCode} unit cost $${item.unitCostUSD} annual volume ${item.annualVolume} SKU ${item.sku}`;
    const vector = await foundry.generateEmbedding(searchText);
    rows.push({ ...item, vector });
  }

  const db = await connect(dbPath);

  // Drop existing table if present (safe re-run)
  try { await (db as any).dropTable('inventory'); } catch { /* table didn't exist */ }
  await db.createTable('inventory', rows);

  console.log(`✅ Ingested ${items.length} SKUs into LanceDB`);
}

// CLI entry point
if (require.main === module) {
  void (async () => {
    const { createFoundryLocalClient } = await import('../lib/foundryLocal');
    const { LANCEDB_PATH } = await import('../lib/env');
    await ingest(createFoundryLocalClient(), LANCEDB_PATH);
  })();
}
