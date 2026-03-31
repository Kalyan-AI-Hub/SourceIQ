// app/api/what-if/route.ts — GET /api/what-if?country=China&rate=45
// RULE 1: uses shared singletons from startup — never instantiates concrete classes.
import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, riskStore, inventoryStore, tariffStore, foundryClient } from '../../../src/lib/startup';
import { simulateTariff } from '../../../src/tools/whatIfSimulator';
import { fetchFxRates } from '../../../src/tools/exchangeRateFetcher';
import { getCountryConfig } from '../../../src/lib/countryConfig';
import { cache, TTL, SWR } from '../../../src/lib/cache';

import type { CacheTag } from '../../../src/lib/cache';

const SCENARIO_TTL = { ttlMs: TTL.SHORT,  swrMs: SWR.SHORT, tags: ['tariff', 'inventory'] as CacheTag[] };
const INSIGHT_TTL  = { ttlMs: TTL.MEDIUM, swrMs: SWR.SHORT, tags: ['ai-insight'] as CacheTag[] };

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await initializeApp();
    const { searchParams } = new URL(req.url);
    const country     = searchParams.get('country')?.trim();
    const rateStr     = searchParams.get('rate');
    const wantInsight = searchParams.get('insight') === '1';

    if (!country) return NextResponse.json({ error: 'Missing country param' }, { status: 400 });
    const rate = parseFloat(rateStr ?? '');
    if (isNaN(rate) || rate < 0 || rate > 100) {
      return NextResponse.json({ error: 'rate must be 0-100' }, { status: 400 });
    }

    // Sanctions guard — return compliance warning before running cost simulation
    if (getCountryConfig().isSanctioned(country)) {
      return NextResponse.json(
        { error: `⛔ ${country} is subject to US OFAC comprehensive sanctions. Direct sourcing is prohibited. Consult your legal/compliance team before proceeding.` },
        { status: 403 },
      );
    }

    const cacheKey   = `what-if:${country}:${rate}`;
    const insightKey = `${cacheKey}:insight`;

    // Data fast path — serve fresh or SWR stale without re-simulating
    if (cache.hasFresh(cacheKey) || cache.hasStale(cacheKey)) {
      const scenarioData = cache.get<object>(cacheKey)!;
      if (!wantInsight) return NextResponse.json(scenarioData);
      // Insight fast path on top of cached scenario
      if (cache.hasFresh(insightKey) || cache.hasStale(insightKey)) {
        return NextResponse.json({ ...scenarioData, aiNarrative: cache.get<string>(insightKey) });
      }
    }

    // Fetch live FX rates and run simulation in parallel
    const [scenario, fxRates, sri] = await Promise.all([
      simulateTariff(country, rate, inventoryStore, tariffStore),
      fetchFxRates(),
      riskStore.getSriForCountry(country),
    ]);

    // Build AI narrative context
    const currencyCode = getCountryConfig().getCurrency(country);
    const fxLine = currencyCode && fxRates[currencyCode]
      ? `Live FX rate: 1 USD = ${fxRates[currencyCode].toFixed(2)} ${currencyCode}.`
      : '';

    const sriLine = sri
      ? `Current SRI for ${country}: ${sri.score}/100 (${sri.tier}).`
      : '';

    const impactSign  = scenario.totalPortfolioImpactUSD >= 0 ? '+' : '';
    const topRec      = scenario.recommendations[0];
    const recLine     = topRec
      ? `Best alternative: ${topRec.recommendedCountry} saves $${topRec.annualSavingsUSD.toLocaleString()}/yr on SKU ${topRec.sku}.`
      : 'No lower-cost alternatives found in current data.';

    const narrativePrompt = `You are a sourcing analyst. Give a 2-sentence recommendation.
Data: ${country} at ${rate}% tariff. Portfolio impact: ${impactSign}$${scenario.totalPortfolioImpactUSD.toLocaleString()} / year across ${scenario.affectedSkus.length} SKUs. ${recLine} ${sriLine} ${fxLine}
Be specific. Mention the dollar impact, the best alternative country, and any risk concern. No generic advice.`;

    let aiNarrative: string | undefined;
    if (wantInsight) {
      try {
        aiNarrative = await cache.getOrCompute(
          insightKey,
          () => foundryClient.chat([{ role: 'user', content: narrativePrompt }]),
          INSIGHT_TTL,
        );
      } catch {
        aiNarrative = 'AI insight unavailable — model busy. Please try again.';
      }
    }

    const responseData = { ...scenario, fxRates, currencyCode, aiNarrative };
    cache.set(cacheKey, responseData, SCENARIO_TTL);
    return NextResponse.json(responseData);
  } catch (err) {
    console.error('[/api/what-if]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
