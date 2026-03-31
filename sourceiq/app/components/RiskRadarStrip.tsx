'use client';
// RiskRadarStrip — Global Risk Radar cockpit hero strip
// MUST be loaded via dynamic(() => import(...), { ssr: false }) — uses EventSource.
//
// Shows live SRI data from /api/risk-stream:
//   - Top-3 critical/high countries with score + trend arrow (numeric delta after 2nd update)
//   - Critical count + safe-zone count as at-a-glance summary
//   - Each card is clickable → dispatches sourceiq:analyze-country

import { useEffect, useRef, useState } from 'react';
import type { SourcingRiskIndex } from '../../src/types/index';

const TIER_RING: Record<string, string> = {
  critical: 'border-red-700/70 bg-red-950/50',
  high:     'border-orange-700/60 bg-orange-950/40',
  elevated: 'border-yellow-700/50 bg-yellow-950/30',
  safe:     'border-emerald-700/40 bg-emerald-950/20',
};

const TIER_LABEL: Record<string, string> = {
  critical: 'text-red-300',
  high:     'text-orange-300',
  elevated: 'text-yellow-300',
  safe:     'text-emerald-300',
};

const TIER_DOT: Record<string, string> = {
  critical: 'bg-red-400',
  high:     'bg-orange-400',
  elevated: 'bg-yellow-400',
  safe:     'bg-emerald-400',
};

interface SriWithDelta extends SourcingRiskIndex {
  delta: number;
}

function TrendArrow({ trend, delta }: { trend: string; delta: number }) {
  // Prefer numeric delta once we have 2+ snapshots; fall back to trend field
  if (Math.abs(delta) >= 0.5) {
    return delta > 0
      ? <span className="text-red-400 text-[9px] font-bold tabular-nums">▲{Math.abs(delta).toFixed(0)}</span>
      : <span className="text-emerald-400 text-[9px] font-bold tabular-nums">▼{Math.abs(delta).toFixed(0)}</span>;
  }
  if (trend === 'escalating')    return <span className="text-red-400 text-[9px]">▲</span>;
  if (trend === 'de-escalating') return <span className="text-emerald-400 text-[9px]">▼</span>;
  return <span className="text-slate-500 text-[9px]">—</span>;
}

export default function RiskRadarStrip() {
  const [sriData, setSriData] = useState<SriWithDelta[]>([]);
  const prevMap = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const es = new EventSource('/api/risk-stream');

    const applyData = (raw: string) => {
      try {
        const d = JSON.parse(raw) as SourcingRiskIndex[];
        if (!Array.isArray(d)) return;

        const withDelta: SriWithDelta[] = d.map(s => ({
          ...s,
          delta: s.score - (prevMap.current.get(s.country) ?? s.score),
        }));

        // Persist scores for next delta calculation
        for (const s of d) prevMap.current.set(s.country, s.score);

        // Sort: critical → high → elevated → safe, then by score desc
        const tierOrder = ['critical', 'high', 'elevated', 'safe'];
        const sorted = [...withDelta].sort((a, b) =>
          tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier) || b.score - a.score,
        );

        setSriData(sorted);
      } catch { /* ignore parse errors */ }
    };

    es.addEventListener('snapshot', (e: MessageEvent) => applyData(e.data as string));
    es.addEventListener('update',   (e: MessageEvent) => applyData(e.data as string));
    return () => es.close();
  }, []);

  if (sriData.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-slate-900 border-b border-slate-700 shrink-0 text-xs text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-600 animate-pulse" aria-hidden="true" />
        Risk Radar initializing…
      </div>
    );
  }

  const top3         = sriData.slice(0, 3);
  const criticalCount = sriData.filter(s => s.tier === 'critical').length;
  const atRiskCount   = sriData.filter(s => s.tier === 'critical' || s.tier === 'high').length;
  const safeCount     = sriData.filter(s => s.tier === 'safe' || s.tier === 'elevated').length;
  const extraAtRisk   = atRiskCount > 3 ? atRiskCount - 3 : 0;

  return (
    <div
      className="flex items-stretch bg-slate-900 border-b border-slate-700 shrink-0 overflow-x-auto"
      role="region"
      aria-label="Global Risk Radar — top sourcing risk countries"
    >
      {/* ── Label column ── */}
      <div className="flex flex-col justify-center px-3 py-2 border-r border-slate-700 shrink-0 min-w-[90px]">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${criticalCount > 0 ? 'bg-red-400 animate-pulse' : 'bg-slate-500'}`}
            aria-hidden="true"
          />
          <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
            Risk Radar
          </span>
        </div>
        <div className="mt-0.5 flex gap-2 text-[9px] tabular-nums">
          <span className="text-red-400">{criticalCount} critical</span>
          <span className="text-emerald-400">{safeCount} safe</span>
        </div>
      </div>

      {/* ── Top-3 country cards ── */}
      <div className="flex items-center gap-2 px-3 py-2 flex-1 min-w-0 overflow-x-auto">
        {top3.map(s => (
          <button
            key={s.country}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('sourceiq:analyze-country', {
                  detail: `Analyze sourcing risk for ${s.country}`,
                }),
              )
            }
            className={`flex items-center gap-2 px-2.5 py-1.5 rounded border text-left shrink-0
              transition-all hover:brightness-125 focus:outline-none focus:ring-1 focus:ring-blue-500
              ${TIER_RING[s.tier] ?? 'border-slate-700 bg-slate-800'}`}
            title={`${s.country} — SRI ${s.score}/100 · ${s.tier} · Click to analyze`}
            aria-label={`${s.country} risk: ${s.tier}, score ${s.score}`}
          >
            {/* Tier dot */}
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${TIER_DOT[s.tier] ?? 'bg-slate-500'}
                ${s.tier === 'critical' ? 'animate-pulse' : ''}`}
              aria-hidden="true"
            />
            <div className="flex flex-col leading-none">
              <span className={`text-[11px] font-semibold ${TIER_LABEL[s.tier] ?? 'text-slate-300'}`}>
                {s.country}
              </span>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] text-slate-400 tabular-nums">
                  {s.score}
                </span>
                <TrendArrow trend={s.trend} delta={s.delta} />
              </div>
            </div>
          </button>
        ))}

        {extraAtRisk > 0 && (
          <span className="text-[10px] text-slate-500 shrink-0 pl-1">
            +{extraAtRisk} more at risk
          </span>
        )}
      </div>
    </div>
  );
}
