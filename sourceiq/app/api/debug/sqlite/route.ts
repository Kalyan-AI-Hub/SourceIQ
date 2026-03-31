// app/api/debug/sqlite/route.ts — raw SQLite inspection for validation
// GET /api/debug/sqlite                       → summary of all tables
// GET /api/debug/sqlite?table=tariffs         → all tariff rates
// GET /api/debug/sqlite?table=tariffs&country=China  → filtered by country
// GET /api/debug/sqlite?table=tariffs&hscode=6204    → filtered by HS code prefix
// GET /api/debug/sqlite?table=country_config  → all country metadata

import { NextResponse } from 'next/server';
import { initializeApp, tariffStore } from '../../../../src/lib/startup';
import { getCountryConfig } from '../../../../src/lib/countryConfig';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  try {
    await initializeApp();
    const { searchParams } = new URL(req.url);
    const table   = searchParams.get('table');
    const country = searchParams.get('country');
    const hscode  = searchParams.get('hscode');

    // No table param → summary of all tables
    if (!table) {
      const allRates    = await tariffStore.getAllRates();
      const allCountries = getCountryConfig().getAll();

      // Summarise tariffs by country
      const byCountry: Record<string, number> = {};
      for (const r of allRates) {
        byCountry[r.country] = (byCountry[r.country] ?? 0) + 1;
      }

      return NextResponse.json({
        tables: {
          tariffs: {
            rowCount: allRates.length,
            countriesCovered: Object.keys(byCountry).length,
            breakdown: Object.entries(byCountry)
              .map(([c, n]) => ({ country: c, rateCount: n }))
              .sort((a, b) => b.rateCount - a.rateCount),
          },
          country_config: {
            rowCount: allCountries.length,
            sanctioned: allCountries.filter(r => r.isSanctioned).map(r => r.name),
            highRisk:   allCountries.filter(r => r.isHighRisk).map(r => r.name),
            activeConflict: allCountries.filter(r => r.isActiveConflict).map(r => r.name),
          },
        },
      });
    }

    // tariffs table
    if (table === 'tariffs') {
      let rows = await tariffStore.getAllRates();
      if (country) rows = rows.filter(r => r.country.toLowerCase().includes(country.toLowerCase()));
      if (hscode)  rows = rows.filter(r => r.hsCode.startsWith(hscode));
      return NextResponse.json({
        table: 'tariffs',
        totalRows: (await tariffStore.getAllRates()).length,
        filteredRows: rows.length,
        filters: { country: country ?? null, hscode: hscode ?? null },
        rows,
      });
    }

    // country_config table
    if (table === 'country_config') {
      const rows = getCountryConfig().getAll();
      return NextResponse.json({ table: 'country_config', rowCount: rows.length, rows });
    }

    return NextResponse.json(
      { error: `Unknown table "${table}". Valid options: tariffs | country_config` },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
