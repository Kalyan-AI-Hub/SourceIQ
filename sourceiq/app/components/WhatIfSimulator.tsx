'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { WhatIfScenario, SourcingRecommendation } from '../../src/types/index';

interface CountryOption { name: string; isSanctioned: boolean; }

function pressureLevel(rate: number, impact: number): { label: string; color: string; border: string } {
  if (rate >= 50 || impact > 500_000)  return { label: 'CRITICAL', color: '#f87171', border: '#7f1d1d' };
  if (rate >= 30 || impact > 200_000)  return { label: 'HIGH',     color: '#fb923c', border: '#7c2d12' };
  if (rate >= 15 || impact > 50_000)   return { label: 'WATCH',    color: '#facc15', border: '#713f12' };
  return                                        { label: 'LOW',      color: '#4ade80', border: '#14532d' };
}

function skuStatus(rec: SourcingRecommendation, rate: number): 'SWITCH' | 'WATCH' | 'KEEP' {
  if (rec.annualSavingsUSD > 0) return 'SWITCH';
  if (rec.tippingPointRate !== undefined && rate >= rec.tippingPointRate * 0.8) return 'WATCH';
  return 'KEEP';
}

const STATUS_COLORS: Record<string, { dot: string; text: string }> = {
  SWITCH: { dot: '#f87171', text: '#fca5a5' },
  WATCH:  { dot: '#facc15', text: '#fde68a' },
  KEEP:   { dot: '#4ade80', text: '#86efac' },
};

function PressureSlider({ rate, tippingPoints, onChange }: {
  rate: number; tippingPoints: number[]; onChange: (v: number) => void;
}) {
  const track = 'linear-gradient(to right,#16a34a 0%,#16a34a 15%,#ca8a04 15%,#ca8a04 30%,#ea580c 30%,#ea580c 50%,#dc2626 50%,#dc2626 100%)';
  return (
    <div className="relative w-full" style={{ paddingBottom: 14 }}>
      {/* Track */}
      <div className="relative rounded-full" style={{ height: 6, background: track }}>
        {tippingPoints.filter(tp => tp >= 0 && tp <= 100).map((tp, i) => (
          <div key={i} title={`Tipping point: ${tp}%`}
            className="absolute rounded-full bg-white/70"
            style={{ left: `${tp}%`, top: '50%', transform: 'translate(-50%,-50%)', width: 2, height: 12 }}
          />
        ))}
        {/* Thumb */}
        <div className="absolute rounded-full bg-white border-2 border-slate-500 shadow"
          style={{ left: `${rate}%`, top: '50%', transform: 'translate(-50%,-50%)', width: 14, height: 14, pointerEvents: 'none' }}
        />
      </div>
      {/* Invisible range input overlay */}
      <input type="range" min={0} max={100} value={rate}
        onChange={e => onChange(Number(e.target.value))}
        className="absolute inset-0 w-full opacity-0 cursor-pointer"
        style={{ height: 6, top: 0 }}
      />
      {/* Zone labels */}
      <div className="flex justify-between" style={{ marginTop: 4 }}>
        {(['Safe','Watch','High','Critical'] as const).map((l, i) => (
          <span key={l} className="text-slate-500" style={{ fontSize: 9, color: ['#4ade80','#facc15','#fb923c','#f87171'][i] }}>{l}</span>
        ))}
      </div>
    </div>
  );
}

function SkuRow({ rec, rate }: { rec: SourcingRecommendation; rate: number }) {
  const status = skuStatus(rec, rate);
  const { dot, text } = STATUS_COLORS[status]!;
  return (
    <div className="flex items-center gap-2 py-1 border-b border-slate-800 last:border-0">
      <span style={{ color: dot, fontSize: 8 }}>●</span>
      <span className="font-mono text-slate-300" style={{ fontSize: 10, minWidth: 64 }}>{rec.sku}</span>
      <span style={{ fontSize: 9, color: text, fontWeight: 700, minWidth: 42 }}>{status}</span>
      <span className="text-slate-400 truncate flex-1" style={{ fontSize: 9 }}>→ {rec.recommendedCountry}</span>
      {rec.annualSavingsUSD > 0 && (
        <span className="text-green-400 font-semibold shrink-0" style={{ fontSize: 10 }}>
          +${rec.annualSavingsUSD.toLocaleString()}
        </span>
      )}
      {rec.tippingPointRate !== undefined && status !== 'SWITCH' && (
        <span className="text-slate-500 shrink-0" style={{ fontSize: 9 }}>tips@{rec.tippingPointRate}%</span>
      )}
    </div>
  );
}

export default function WhatIfSimulator() {
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [country, setCountry]     = useState('China');
  const [rate, setRate]           = useState(25);
  const [scenario, setScenario]   = useState<WhatIfScenario | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [insight, setInsight]     = useState<string | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadStartedRef = useRef(false);
  const selectedCountry = countries.find(c => c.name === country) ?? null;
  const isSanctionedCountry = selectedCountry?.isSanctioned ?? false;

  const fetchScenario = useCallback((c: string, r: number, silent = false) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      if (!silent) setError(null);
      setInsight(null);
      try {
        const res = await fetch(`/api/what-if?country=${encodeURIComponent(c)}&rate=${r}`);
        if (!res.ok) throw new Error((await res.json() as { error: string }).error);
        setScenario(await res.json() as WhatIfScenario);
        setError(null);
      } catch (e) {
        setScenario(null);
        if (!silent) setError(e instanceof Error ? e.message : 'Failed to load scenario');
      } finally {
        setLoading(false);
      }
    }, 300);
  }, []);

  useEffect(() => {
    fetch('/api/countries').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setCountries(d as CountryOption[]);
    }).catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialLoadStartedRef.current || countries.length === 0) return;
    if (!countries.some(c => c.name === country)) return;
    initialLoadStartedRef.current = true;
    const t = setTimeout(() => fetchScenario(country, rate, true), 1200);
    return () => clearTimeout(t);
  }, [countries, country, rate, fetchScenario]);

  // Listen for "Simulate Reroute" clicks from the ConflictHeatmap
  useEffect(() => {
    const handler = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      if (countries.some(c => c.name === name)) {
        setCountry(name);
        fetchScenario(name, rate);
      }
    };
    window.addEventListener('sourceiq:whatif-country', handler);
    return () => window.removeEventListener('sourceiq:whatif-country', handler);
  }, [countries, rate, fetchScenario]);

  function requestInsight() {
    if (isSanctionedCountry) {
      setInsight('Direct sourcing is prohibited for this country under OFAC sanctions. AI sourcing guidance is disabled until you switch to a compliant market.');
      return;
    }

    setInsightLoading(true);
    fetch(`/api/what-if?country=${encodeURIComponent(country)}&rate=${rate}&insight=1`)
      .then(async r => {
        const data = await r.json() as WhatIfScenario | { error?: string };
        if (!r.ok) throw new Error('error' in data && data.error ? data.error : 'Unable to generate insight.');
        return data;
      })
      .then(d => setInsight((d as WhatIfScenario).aiNarrative || null))
      .catch((err: unknown) => setInsight(err instanceof Error ? err.message : 'Unable to generate insight. Please try again.'))
      .finally(() => setInsightLoading(false));
  }

  const impact     = scenario?.totalPortfolioImpactUSD ?? 0;
  const pressure   = pressureLevel(rate, Math.abs(impact));
  const tippingPts = (scenario?.recommendations ?? [])
    .map(r => r.tippingPointRate ?? -1).filter(tp => tp >= 0 && tp <= 100);
  const fxRate = scenario?.fxRates && scenario.currencyCode
    ? scenario.fxRates[scenario.currencyCode] : null;

  return (
    <div className="p-4 flex flex-col gap-2">
      <h2 className="sq-label">What-If Tariff Simulator</h2>

      {/* Country + pressure pill */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={country}
          onChange={e => { setCountry(e.target.value); fetchScenario(e.target.value, rate); }}
          className="text-xs border border-slate-600 bg-slate-800 text-slate-200 rounded px-2 py-1 outline-none focus:border-blue-500"
        >
          {countries.map(c => (
            <option key={c.name} value={c.name}>{c.isSanctioned ? `⛔ ${c.name}` : c.name}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1.5 border rounded-md px-2.5 py-1"
          style={{ borderColor: pressure.border, background: pressure.border + '33' }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: pressure.color }}>{pressure.label}</span>
          <span style={{ fontSize: 18, fontWeight: 900, color: pressure.color }}>{rate}%</span>
        </div>
      </div>

      {/* Pressure slider */}
      <PressureSlider rate={rate} tippingPoints={tippingPts}
        onChange={r => { setRate(r); fetchScenario(country, r); }} />

      {/* Impact row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-slate-500">Impact:</span>
        <span className="text-lg font-bold" style={{ color: impact > 0 ? '#f87171' : impact < 0 ? '#4ade80' : '#94a3b8' }}>
          {impact >= 0 ? '+' : ''}{impact.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
        </span>
        <span className="text-xs text-slate-600">/yr</span>
        {fxRate && scenario?.currencyCode && (
          <span className="ml-auto flex items-center gap-1" style={{ fontSize: 10, color: '#64748b' }}>
            <span className="inline-block rounded-full bg-green-400 animate-pulse" style={{ width: 6, height: 6 }} />
            1 USD = {fxRate.toFixed(2)} {scenario.currencyCode}
          </span>
        )}
        {loading && <span className="text-xs text-slate-500 animate-pulse ml-1">Calculating…</span>}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Loading skeleton — shown while scenario is computing */}
      {loading && !scenario && (
        <div className="space-y-2 animate-pulse mt-1">
          <div className="h-10 rounded-lg bg-slate-800" />
          <div className="h-[110px] rounded-lg bg-slate-800" />
        </div>
      )}

      {/* SKU rows */}
      {scenario && scenario.recommendations.length > 0 && (() => {
        const switchable = scenario.recommendations.filter(r => r.annualSavingsUSD > 0);
        const totalSavings = switchable.reduce((s, r) => s + r.annualSavingsUSD, 0);
        return (
          <>
            {totalSavings > 0 && (
              <div className="rounded-lg px-3 py-2 flex items-center justify-between"
                style={{ border: '1px solid rgba(34,197,94,0.40)', background: 'rgba(34,197,94,0.12)' }}>
                <div>
                  <span className="sq-label" style={{ color: '#4ade80' }}>Switch opportunity</span>
                  <div className="text-base font-bold text-green-400 tabular-nums mt-0.5">
                    +${totalSavings.toLocaleString()}<span className="text-xs font-normal text-slate-500 ml-1">/yr</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="sq-label text-slate-500">{switchable.length} SKU{switchable.length !== 1 ? 's' : ''}</span>
                  <div className="text-xs text-slate-500 mt-0.5">can switch</div>
                </div>
              </div>
            )}
            <div className="border border-slate-700 rounded-lg px-3 py-1 overflow-y-auto" style={{ maxHeight: 110 }}>
              {scenario.recommendations.slice(0, 8).map(rec => (
                <SkuRow key={rec.sku} rec={rec} rate={rate} />
              ))}
            </div>
          </>
        );
      })()}
      {scenario && scenario.recommendations.length === 0 && !loading && (
        <p className="text-xs text-slate-400 italic">No switch opportunities at this rate.</p>
      )}

      {/* AI Insight */}
      {insight ? (
        <div className="sq-insight">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            <span className="sq-label" style={{ color: '#60a5fa' }}>{isSanctionedCountry ? 'Compliance Notice' : 'AI Insight'}</span>
            {!isSanctionedCountry && <span className="sq-badge-ai ml-auto"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="3" opacity=".5"/><circle cx="4" cy="4" r="1.5"/></svg>AI generated</span>}
          </div>
          <p className="text-slate-300 leading-relaxed" style={{ fontSize: 11 }}>{insight}</p>
        </div>
      ) : isSanctionedCountry ? (
        <div className="rounded-lg border border-red-800/60 bg-red-950/25 px-3 py-2.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="w-2 h-2 rounded-full bg-red-400" />
            <span className="sq-label" style={{ color: '#fca5a5' }}>Compliance Lock</span>
          </div>
          <p className="text-[11px] leading-relaxed text-red-200">Iran is subject to US OFAC comprehensive sanctions. Direct sourcing is prohibited, so AI rerouting guidance is disabled until you switch to a compliant market.</p>
        </div>
      ) : (
        <button onClick={requestInsight} disabled={insightLoading || loading || !scenario} className="sq-ai-btn">
          {insightLoading ? (
            <>
              <svg className="animate-spin w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <span className="text-blue-400" style={{ fontSize: 11 }}>Analysing scenario…</span>
            </>
          ) : (
            <>
              <span className="text-blue-400">✦</span>
              <span className="font-medium text-blue-400" style={{ fontSize: 11 }}>Generate AI Insight</span>
            </>
          )}
        </button>
      )}
    </div>
  );
}
