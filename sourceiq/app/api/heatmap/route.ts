// app/api/heatmap/route.ts — GET /api/heatmap → SRI scores for all countries → map
import { NextResponse } from 'next/server';
import { initializeApp, riskStore } from '../../../src/lib/startup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<NextResponse> {
  try {
    await initializeApp();
    const data = await riskStore.getHeatmapData();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[/api/heatmap]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
