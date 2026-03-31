// src/lib/localEmbeddings.ts — singleton Transformers.js embedder
// Model: Xenova/all-MiniLM-L6-v2 (22 MB, 384-dim, downloaded to ~/.cache on first use)
// Works fully offline after first download. Does NOT use Foundry Local.

/* eslint-disable @typescript-eslint/no-explicit-any */

let embedPipeline: any = null;

async function getEmbedPipeline(): Promise<any> {
  if (!embedPipeline) {
    // webpackIgnore: true — prevents webpack from transforming this ESM-only import to require()
    const { pipeline, env } = await import(/* webpackIgnore: true */ '@xenova/transformers');
    // Disable remote model checks after first download
    env.allowRemoteModels = true;
    embedPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('[LocalEmbeddings] Xenova/all-MiniLM-L6-v2 loaded (384-dim)');
  }
  return embedPipeline;
}

export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbedPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

// ── Embedding-based sentiment — no extra model download ───────────────
// Uses cosine similarity to risk vs safe anchor embeddings.
// Returns 0 (safe/positive) → 1 (high-risk/negative).

const RISK_ANCHOR = 'armed conflict war bombing sanctions embargo crisis blockade port closure supply chain disruption';
const SAFE_ANCHOR = 'peace stability diplomatic agreement trade growth recovery safe investment';

let riskAnchor: number[] | null = null;
let safeAnchor: number[] | null = null;

async function getAnchors(): Promise<[number[], number[]]> {
  if (!riskAnchor || !safeAnchor) {
    [riskAnchor, safeAnchor] = await Promise.all([embed(RISK_ANCHOR), embed(SAFE_ANCHOR)]);
  }
  return [riskAnchor, safeAnchor];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Returns 0 (safe/positive) → 1 (high-risk/negative). Anchors cached after first call. */
export async function sentimentRiskScore(text: string): Promise<number> {
  try {
    const [[riskEmb, safeEmb], textEmb] = await Promise.all([getAnchors(), embed(text)]);
    const riskSim = cosine(textEmb, riskEmb);
    const safeSim = cosine(textEmb, safeEmb);
    // Normalize to 0-1: 0.5 = neutral, 1 = maximally risk-like
    return Math.max(0, Math.min(1, (riskSim - safeSim + 1) / 2));
  } catch {
    return 0.5; // neutral on failure
  }
}
