/**
 * data/seedLanceDb.ts — seeds LanceDB inventory table from inventory.csv
 *
 * Run:
 *   NODE_OPTIONS="--max-old-space-size=4096" npx ts-node --project tsconfig.scripts.json data/seedLanceDb.ts
 *
 * Requires Foundry Local running for real embeddings.
 * Falls back to deterministic fake vectors so the app still works without embeddings.
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const LANCEDB_PATH = process.env['LANCEDB_PATH'] ?? './data/lancedb';

// ── CSV parser ─────────────────────────────────────────────────────────────

interface InventoryRow {
  sku: string;
  name: string;
  category: string;
  quantity: number;
  currentSourceCountry: string;
  unitCostUSD: number;
  hsCode: string;
  annualVolume: number;
}

function parseCsv(filePath: string): InventoryRow[] {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const obj: Record<string, string | number> = {};
    headers.forEach((h, i) => { obj[h.trim()] = values[i]?.trim() ?? ''; });
    return {
      sku:                  String(obj['sku']),
      name:                 String(obj['name']),
      category:             String(obj['category']),
      quantity:             Number(obj['quantity']),
      currentSourceCountry: String(obj['currentSourceCountry']),
      unitCostUSD:          Number(obj['unitCostUSD']),
      hsCode:               String(obj['hsCode']),
      annualVolume:         Number(obj['annualVolume']),
    };
  });
}

// ── Embedding helpers ──────────────────────────────────────────────────────

const VECTOR_DIM = 384;  // fallback dimension (common for small embedding models)

/** Deterministic fake vector based on text hash — used when embeddings endpoint unavailable */
function fakeEmbedding(text: string): number[] {
  const vec: number[] = new Array(VECTOR_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % VECTOR_DIM] += text.charCodeAt(i) / 1000;
  }
  // L2-normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipe: any = null;

async function getEmbedding(text: string): Promise<number[]> {
  try {
    const { pipeline } = await import('@xenova/transformers');
    if (!_pipe) {
      console.log('⏳ Loading Xenova/all-MiniLM-L6-v2 (downloads ~22 MB on first run)…');
      _pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      console.log('✅ Embedding model loaded');
    }
    const out = await _pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data as Float32Array);
  } catch (err) {
    console.warn('⚠️  Transformers.js unavailable — falling back to fake vectors:', err);
    return fakeEmbedding(text);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = path.resolve(__dirname, 'inventory.csv');
  const items = parseCsv(csvPath);
  console.log(`📦 Loaded ${items.length} inventory items from inventory.csv`);

  // Test embedding endpoint
  console.log('🔌 Testing Xenova/all-MiniLM-L6-v2 embedding model…');
  const testVec = await getEmbedding('test');
  const usingReal = testVec.length !== VECTOR_DIM || testVec[0] !== fakeEmbedding('test')[0];
  console.log(usingReal
    ? `✅ Real embeddings — dim=${testVec.length}`
    : `⚠️  Embeddings endpoint unavailable — using deterministic fake vectors (dim=${VECTOR_DIM}). Semantic search will not be meaningful but the app will work.`
  );

  // Generate embeddings
  console.log('⏳ Generating vectors…');
  const rows = await Promise.all(items.map(async item => {
    const text = `${item.name} ${item.category} sourced from ${item.currentSourceCountry} HS ${item.hsCode}`;
    const vector = await getEmbedding(text);
    return { ...item, vector };
  }));

  // Write to LanceDB
  const { connect } = await import('vectordb');
  const dbPath = path.resolve(process.cwd(), LANCEDB_PATH);
  fs.mkdirSync(dbPath, { recursive: true });

  const db = await connect(dbPath);

  // Drop existing table if it exists
  try {
    await db.dropTable('inventory');
    console.log('🗑️  Dropped existing inventory table');
  } catch {
    // table didn't exist — fine
  }

  await db.createTable('inventory', rows);
  console.log(`✅ LanceDB seeded — ${rows.length} inventory rows written to ${dbPath}`);
}

main().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
