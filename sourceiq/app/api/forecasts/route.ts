// app/api/forecasts/route.ts — GET /api/forecasts?category=conflict
// Returns deterministic supply chain probability forecasts derived from live SRI data.
// No LLM per forecast — probabilities come from signal math, not generation.

import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, riskStore } from '../../../src/lib/startup';
import { generateForecasts } from '../../../src/services/forecastGenerator';
import type { ForecastCategory } from '../../../src/types/index';

export const dynamic = 'force-dynamic';

const VALID_CATEGORIES = new Set<ForecastCategory>([
  'conflict', 'tariff', 'supply-chain', 'political', 'port', 'cyber',
]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await initializeApp();

    const cat = req.nextUrl.searchParams.get('category') as ForecastCategory | null;
    const category = cat && VALID_CATEGORIES.has(cat) ? cat : undefined;

    const heatmap   = await riskStore.getHeatmapData();
    const forecasts = generateForecasts(heatmap, category);

    return NextResponse.json(forecasts);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
