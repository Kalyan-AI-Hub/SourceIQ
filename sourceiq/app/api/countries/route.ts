// app/api/countries/route.ts — GET /api/countries
// Returns sourcing countries from country_config DB table.
// Used by WhatIfSimulator and any other UI that needs the country list.

import { NextResponse } from 'next/server';
import { initializeApp } from '../../../src/lib/startup';
import { getCountryConfig } from '../../../src/lib/countryConfig';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    await initializeApp();
    const config = getCountryConfig();
    // Sourcing countries = not flagged as high-risk-only (users can select these for what-if)
    // Sanctioned countries are included so the UI can warn on selection (not silently omit)
    const countries = config.getAll()
      .filter(r => !r.isHighRisk)
      .map(r => ({ name: r.name, isSanctioned: r.isSanctioned }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json(countries);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
