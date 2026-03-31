// app/api/debug/lancedb/route.ts — raw LanceDB inventory inspection for validation
// GET /api/debug/lancedb                     → all inventory items
// GET /api/debug/lancedb?country=China       → items sourced from a specific country
// GET /api/debug/lancedb?sku=SKU-001         → single item by SKU
// GET /api/debug/lancedb?search=electronics  → vector semantic search (top 10)

import { NextResponse } from 'next/server';
import { initializeApp, inventoryStore } from '../../../../src/lib/startup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  try {
    await initializeApp();
    const { searchParams } = new URL(req.url);
    const country = searchParams.get('country');
    const sku     = searchParams.get('sku');
    const search  = searchParams.get('search');

    // Vector semantic search
    if (search) {
      const results = await inventoryStore.search(search, 10);
      return NextResponse.json({
        mode: 'vector-search',
        query: search,
        resultCount: results.length,
        items: results,
      });
    }

    // Single item by SKU
    if (sku) {
      const item = await inventoryStore.getBySku(sku);
      if (!item) return NextResponse.json({ error: `SKU "${sku}" not found` }, { status: 404 });
      return NextResponse.json({ mode: 'sku-lookup', item });
    }

    // Filter by source country
    if (country) {
      const items = await inventoryStore.getByCountry(country);
      return NextResponse.json({
        mode: 'country-filter',
        country,
        itemCount: items.length,
        items,
      });
    }

    // Default: return all items with a spend summary
    const all = await inventoryStore.getAll();
    const spendByCountry: Record<string, number> = {};
    let totalSpend = 0;
    for (const item of all) {
      const spend = item.unitCostUSD * item.annualVolume;
      spendByCountry[item.currentSourceCountry] = (spendByCountry[item.currentSourceCountry] ?? 0) + spend;
      totalSpend += spend;
    }

    const countryBreakdown = Object.entries(spendByCountry)
      .map(([c, spend]) => ({
        country: c,
        annualSpendUSD: Math.round(spend),
        sharePercent: Math.round((spend / totalSpend) * 1000) / 10,
      }))
      .sort((a, b) => b.annualSpendUSD - a.annualSpendUSD);

    return NextResponse.json({
      mode: 'all',
      itemCount: all.length,
      totalAnnualSpendUSD: Math.round(totalSpend),
      countryBreakdown,
      items: all,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
