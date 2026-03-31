/**
 * scripts/warm-demo.ts — Pre-warm all demo-critical cache paths before a live demo.
 *
 * Run: npx ts-node -r dotenv/config scripts/warm-demo.ts
 *
 * What it does:
 *  1. Hits all dashboard endpoints to populate server-side cache
 *  2. Hits the most common what-if scenarios judges will touch
 *  3. Prints timing + status for each endpoint
 *  4. Exits non-zero if any critical endpoint fails
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

interface WarmResult {
  endpoint: string;
  status: number;
  ms: number;
  ok: boolean;
  error?: string;
}

async function hit(endpoint: string, label?: string): Promise<WarmResult> {
  const url = `${BASE_URL}${endpoint}`;
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    const ms = Date.now() - start;
    const ok = res.ok;
    if (!ok) {
      const body = await res.text().catch(() => '');
      console.log(`  ✗ [${res.status}] ${label ?? endpoint} (${ms}ms) — ${body.slice(0, 80)}`);
    } else {
      console.log(`  ✓ [${res.status}] ${label ?? endpoint} (${ms}ms)`);
    }
    return { endpoint, status: res.status, ms, ok };
  } catch (err) {
    const ms = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ [ERR] ${label ?? endpoint} (${ms}ms) — ${error}`);
    return { endpoint, status: 0, ms, ok: false, error };
  }
}

async function main() {
  console.log(`\nSourceIQ Demo Warm-Up`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Started: ${new Date().toLocaleTimeString()}\n`);

  const results: WarmResult[] = [];

  // ── Phase 1: Core dashboard surfaces ──────────────────────────────────
  console.log('Phase 1 — Core dashboard surfaces');
  results.push(await hit('/api/world-brief',      'World Brief (AI + RSS)'));
  results.push(await hit('/api/morning-brief',    'Morning Brief (alerts + savings)'));
  results.push(await hit('/api/diversification',  'Diversification (data)'));
  results.push(await hit('/api/diversification?insight=1', 'Diversification (AI insight)'));
  results.push(await hit('/api/commodities',      'Commodity Ticker (oil/FX/BDI)'));
  results.push(await hit('/api/heatmap',          'Risk Heatmap'));
  results.push(await hit('/api/countries',        'Country List'));

  // ── Phase 2: What-If scenarios judges will likely run ─────────────────
  console.log('\nPhase 2 — What-If scenarios');
  const scenarios = [
    { country: 'China',   rate: 25  },
    { country: 'China',   rate: 45  },
    { country: 'Vietnam', rate: 12  },
    { country: 'India',   rate: 15  },
    { country: 'Mexico',  rate: 25  },
  ];
  for (const { country, rate } of scenarios) {
    results.push(await hit(
      `/api/what-if?country=${encodeURIComponent(country)}&rate=${rate}`,
      `What-If: ${country} @ ${rate}%`,
    ));
  }

  // ── Phase 3: What-If AI insights ──────────────────────────────────────
  console.log('\nPhase 3 — What-If AI insights (top 2)');
  results.push(await hit('/api/what-if?country=China&rate=25&insight=1',   'What-If China insight'));
  results.push(await hit('/api/what-if?country=Vietnam&rate=12&insight=1', 'What-If Vietnam insight'));

  // ── Summary ───────────────────────────────────────────────────────────
  const total   = results.length;
  const passed  = results.filter(r => r.ok).length;
  const failed  = total - passed;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);
  const avgMs   = Math.round(totalMs / total);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed}/${total} endpoints warmed`);
  console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s  |  Avg: ${avgMs}ms per endpoint`);

  if (failed > 0) {
    console.log(`\nFailed endpoints:`);
    results.filter(r => !r.ok).forEach(r => {
      console.log(`  ✗ ${r.endpoint} — ${r.error ?? `HTTP ${r.status}`}`);
    });
    console.log(`\nWarm-up completed with errors. Check that:\n  1. App is running on ${BASE_URL}\n  2. Foundry Local model is loaded\n  3. .env.local is configured correctly`);
    process.exit(1);
  }

  console.log(`\nAll endpoints warm. Demo is ready.\n`);
}

main().catch(err => {
  console.error('Warm-up script crashed:', err);
  process.exit(1);
});
