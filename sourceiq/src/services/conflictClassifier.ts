// src/services/conflictClassifier.ts — two-stage conflict signal classifier
// Stage 1: Keyword match (0-5ms) — handles ~90% of cases
// Stage 2: Foundry Local LLM — only for low-confidence signals (confidence < 0.6)
// Foundry Local is optional here: Stage 1 runs without it.

import type { ConflictSignal } from '../types/index';
import type { IFoundryClient } from '../adapters/interfaces';
import { sentimentRiskScore } from '../lib/localEmbeddings';

// Keyword sets mapped to severity + confidence
const SEVERITY_KEYWORDS: {
  severity: ConflictSignal['severity'];
  confidence: number;
  keywords: string[];
}[] = [
  {
    severity: 'critical',
    confidence: 0.95,
    keywords: [
      'war', 'invasion', 'bombing', 'airstrike', 'missile strike', 'genocide',
      'do not travel', 'level 4', 'armed conflict', 'civil war', 'occupation',
    ],
  },
  {
    severity: 'high',
    confidence: 0.80,
    keywords: [
      'sanctions', 'embargo', 'port closure', 'trade ban', 'blockade',
      'military escalation', 'coup', 'uprising', 'martial law', 'terrorist attack',
      'reconsider travel', 'level 3',
    ],
  },
  {
    severity: 'medium',
    confidence: 0.65,
    keywords: [
      'protest', 'strike', 'disruption', 'trade dispute', 'tariff increase',
      'supply chain', 'shortage', 'increased caution', 'level 2', 'unrest',
      'demonstration', 'riot',
    ],
  },
  {
    severity: 'low',
    confidence: 0.50,
    keywords: [
      'tension', 'warning', 'concern', 'risk', 'instability', 'uncertainty',
      'political', 'election', 'border dispute',
    ],
  },
];

function keywordClassify(headline: string): {
  severity: ConflictSignal['severity'];
  confidence: number;
} {
  const lower = headline.toLowerCase();

  for (const tier of SEVERITY_KEYWORDS) {
    if (tier.keywords.some(kw => lower.includes(kw))) {
      return { severity: tier.severity, confidence: tier.confidence };
    }
  }

  // Not a conflict signal
  return { severity: 'low', confidence: 0.2 };
}

export class ConflictClassifier {
  constructor(private readonly foundry?: IFoundryClient) {}

  async classify(signal: ConflictSignal): Promise<ConflictSignal> {
    // Stage 1: keyword (always runs)
    const stage1 = keywordClassify(signal.headline);

    // Stage 1.5: embedding-based sentiment — adjusts confidence ±0.15
    // Runs in parallel with nothing (fast: anchors cached after first call)
    let confidence = stage1.confidence;
    try {
      const sentiment = await sentimentRiskScore(signal.headline);
      // High sentiment (risk-like text) → boost; low sentiment → reduce
      confidence = Math.min(0.95, Math.max(0.1, confidence + (sentiment - 0.5) * 0.3));
    } catch { /* sentiment unavailable — keep keyword confidence */ }

    // Stage 2: LLM only if confidence is still borderline AND Foundry Local is available
    if (confidence >= 0.6 || !this.foundry) {
      return {
        ...signal,
        severity: stage1.severity,
        confidence,
        classifierPath: 'keyword',
      };
    }

    // Stage 2: ask the LLM
    try {
      const result = await this.foundry.classifyText(
        `Supply chain risk classification for: "${signal.headline}" (country: ${signal.country})`,
        ['low', 'medium', 'high', 'critical'],
      );
      return {
        ...signal,
        severity: result.label as ConflictSignal['severity'],
        confidence: result.confidence,
        classifierPath: 'llm',
      };
    } catch {
      // LLM unavailable — fall back to Stage 1
      return {
        ...signal,
        severity: stage1.severity,
        confidence,
        classifierPath: 'keyword',
      };
    }
  }

  async classifyBatch(signals: ConflictSignal[]): Promise<ConflictSignal[]> {
    // Sequential — prevents concurrent LLM calls from overwhelming Foundry Local
    const results: ConflictSignal[] = [];
    for (const s of signals) {
      results.push(await this.classify(s));
    }
    return results;
  }
}
