// app/api/diversification/route.ts — GET /api/diversification → DiversificationHealth
// RULE 1: uses shared singletons from startup — never creates its own stores.
//
// GET /api/diversification          → data + chart only (no LLM call, fast)
// GET /api/diversification?insight=1 → same data + AI insight (on-demand, cached separately)

import { NextResponse } from 'next/server';
import { initializeApp, riskStore, inventoryStore, tariffStore, foundryClient } from '../../../src/lib/startup';
import { calculateDiversification } from '../../../src/tools/diversificationScore';
import { cache, TTL, SWR } from '../../../src/lib/cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DATA_KEY    = 'diversification-v2';
const INSIGHT_KEY = 'diversification-insight';

async function buildInsight(health: Awaited<ReturnType<typeof calculateDiversification>>): Promise<string> {
  const top5 = health.countryBreakdown.slice(0, 5);
  const sriResults = await Promise.all(top5.map(c => riskStore.getSriForCountry(c.country)));
  const top5WithRisk = top5.map((c, i) => {
    const sri = sriResults[i];
    return `${c.country}: ${c.percentage}% of spend, risk score ${sri?.score ?? 'N/A'}/100`;
  });

  const allSri = await Promise.all(health.countryBreakdown.map(c => riskStore.getSriForCountry(c.country)));
  const lowRiskAlts = health.countryBreakdown
    .filter((c, i) => (allSri[i]?.score ?? 100) < 40 && c.percentage < 20)
    .slice(0, 3)
    .map(c => `${c.country} (${c.percentage}% of spend)`);

  const criticalWarnings = health.concentrationWarnings
    .filter(w => w.severity === 'critical' || w.severity === 'high')
    .map(w => `${w.country} (${w.percentage}%, ${w.severity})`);

  const userMessage = [
    `[PORTFOLIO DATA]`,
    `Diversification score: ${health.overallScore}/100 (0=fully concentrated, 100=fully diversified).`,
    `Total sourcing countries: ${health.countryBreakdown.length}.`,
    ``,
    `Top 5 countries by spend with risk scores:`,
    ...top5WithRisk.map(l => `  - ${l}`),
    ``,
    `High-concentration warnings: ${criticalWarnings.length > 0 ? criticalWarnings.join(', ') : 'none'}.`,
    `Lower-risk alternatives already in portfolio: ${lowRiskAlts.length > 0 ? lowRiskAlts.join(', ') : 'none identified'}.`,
    `[END DATA]`,
    ``,
    `Write 3 sentences for a retail supply-chain buyer:`,
    `1. State the overall risk level using the score and top concentration country with its %.`,
    `2. Name which specific countries drive the most risk and why (use risk scores from the data).`,
    `3. Give one concrete, data-backed action naming specific countries from the portfolio.`,
    `Use only the data above. No generic advice. Be direct and specific.`,
  ].join('\n');

  const systemPrompt = `You are a supply-chain risk analyst writing for a retail buyer. Use ONLY the data provided. Name specific countries, percentages, and risk scores. Never give generic advice.`;
  return foundryClient.chat([{ role: 'user', content: userMessage }], systemPrompt);
}

export async function GET(req: Request): Promise<NextResponse> {
  try {
    await initializeApp();
    const wantInsight = new URL(req.url).searchParams.get('insight') === '1';

    // ── Data (always returned) — SWR: serve stale while recomputing ─────
    const health = await cache.getOrCompute(
      DATA_KEY,
      () => calculateDiversification(inventoryStore, tariffStore, riskStore),
      { ttlMs: TTL.SHORT, swrMs: SWR.SHORT, tags: ['inventory', 'risk'] },
    );

    // ── AI Insight (only when explicitly requested) ─────────────────────
    if (wantInsight) {
      let aiInsight: string;
      try {
        aiInsight = await cache.getOrCompute(
          INSIGHT_KEY,
          () => buildInsight(health),
          { ttlMs: TTL.MEDIUM, swrMs: SWR.MEDIUM, tags: ['ai-insight'] },
        );
      } catch (aiErr) {
        console.warn('[/api/diversification] AI insight failed:', aiErr);
        aiInsight = 'AI insight unavailable — model busy. Please try again in a moment.';
      }
      return NextResponse.json({ ...health, aiInsight });
    }

    return NextResponse.json(health);
  } catch (err) {
    console.error('[/api/diversification]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
