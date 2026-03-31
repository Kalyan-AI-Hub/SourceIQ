// app/api/world-brief/route.ts — GET /api/world-brief
// Generates an AI sourcing intelligence brief from live SRI data + RSS headlines.
// Cached in-memory for 1 hour. RSS fetch runs in parallel with heatmap fetch.

import { NextResponse } from 'next/server';
import { initializeApp, riskStore, foundryClient } from '../../../src/lib/startup';
import { getTopSupplyChainHeadlines } from '../../../src/tools/rssFetcher';
import { cache, TTL, SWR } from '../../../src/lib/cache';
import type { WorldBrief } from '../../../src/types/index';

const RSS_TIMEOUT_MS = 5_000;
const CACHE_KEY = 'world-brief';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await initializeApp();

    if (cache.hasFresh(CACHE_KEY) || cache.hasStale(CACHE_KEY)) {
      return NextResponse.json(cache.get<WorldBrief>(CACHE_KEY)!);
    }

    // Fetch heatmap + RSS headlines in parallel — neither blocks the other
    const rssTimeout = new Promise<[]>(resolve => setTimeout(() => resolve([]), RSS_TIMEOUT_MS));

    const [heatmapResult, headlinesResult] = await Promise.allSettled([
      riskStore.getHeatmapData(),
      Promise.race([getTopSupplyChainHeadlines(6), rssTimeout]),
    ]);

    const heatmap = heatmapResult.status === 'fulfilled' ? heatmapResult.value : [];
    const rssHeadlines = headlinesResult.status === 'fulfilled' ? headlinesResult.value : [];

    const sorted  = [...heatmap].sort((a, b) => b.score - a.score);
    const top5    = sorted.slice(0, 5);
    const topRiskCountries = top5.map(s => s.country);

    // Build SRI context for LLM
    const scoreLines = top5.map(s =>
      `- ${s.country}: SRI ${s.score}/100 (${s.tier}, ${s.trend})` +
      (s.floorApplied ? ` [${s.floorApplied}]` : '') +
      (s.activeAlerts[0] ? ` — alert: "${s.activeAlerts[0].message}"` : '')
    ).join('\n');

    const escalating = sorted.filter(s => s.trend === 'escalating').map(s => s.country);
    const criticalCount = top5.filter(s => s.tier === 'critical').length;

    // Build RSS headline context (if available)
    const headlineLines = rssHeadlines.length
      ? rssHeadlines.map(h => `- "${h.headline}" (${h.source})`).join('\n')
      : '';

    const userMessage = [
      `[LIVE SOURCING DATA — ${new Date().toDateString()}]`,
      `Top risk countries (SRI scores):`,
      scoreLines,
      escalating.length ? `Escalating trend: ${escalating.join(', ')}.` : '',
      headlineLines
        ? `\nLIVE SUPPLY-CHAIN HEADLINES (use these to ground your brief in real events):\n${headlineLines}`
        : '',
      `[END DATA]`,
      ``,
      `Write a 2-3 sentence World Brief for retail procurement buyers. Do NOT include any labels, numbering, or prefixes like "Sentence 1" — write in flowing plain prose.`,
      `Cover: (1) the biggest sourcing threat by country name and SRI score, referencing a specific headline if available; (2) the supply-chain impact such as shipping routes, port delays, commodity prices, or sanctions; (3) one specific buyer action — no generic advice.`,
    ].filter(Boolean).join('\n');

    const systemPrompt = `You are a senior sourcing intelligence analyst. Write concise, grounded intelligence briefs for procurement teams. Use ONLY the data provided. Reference real headlines when available. Never use "Country X" — always use real country names from the data. Write in plain prose with no sentence labels, no bullet points, and no markdown formatting.`;

    // Structured fallback — real data, no LLM
    const top1 = top5[0];
    let summary = top1
      ? `${top1.country} (SRI ${top1.score}/100, ${top1.tier}) leads sourcing risk today${top1.floorApplied ? ` — ${top1.floorApplied}` : ''}. ${criticalCount} countr${criticalCount === 1 ? 'y' : 'ies'} at critical tier — review alternative suppliers immediately.`
      : `${top5.length} countries monitored. Risk poller initializing — check back shortly.`;

    try {
      summary = await foundryClient.chat(
        [{ role: 'user', content: userMessage }],
        systemPrompt,
      );
    } catch {
      // Foundry offline — fallback summary already set above
    }

    // Store top headlines for display (strip score, keep display fields only)
    const headlines = rssHeadlines.map(({ headline, source, url }) => ({ headline, source, url }));

    const brief: WorldBrief = {
      summary,
      topRiskCountries,
      headlines: headlines.length ? headlines : undefined,
      updatedAt: new Date().toISOString(),
    };

    cache.set(CACHE_KEY, brief, { ttlMs: TTL.LONG, swrMs: SWR.LONG, tags: ['brief'] });
    return NextResponse.json(brief);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
