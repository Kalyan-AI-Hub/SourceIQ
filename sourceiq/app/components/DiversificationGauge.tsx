'use client';

import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import type { DiversificationHealth } from '../../src/types/index';

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startAngle));
  const y1 = cy + r * Math.sin(toRad(startAngle));
  const x2 = cx + r * Math.cos(toRad(endAngle));
  const y2 = cy + r * Math.sin(toRad(endAngle));
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

function scoreColor(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#eab308';
  return '#ef4444';
}

function Gauge({ score }: { score: number }) {
  const cx = 100, cy = 100, r = 76;
  const startAngle = 180;
  const endAngle = 180 - (score / 100) * 180;
  const trackPath = arcPath(cx, cy, r, 180, 0);
  const valuePath = arcPath(cx, cy, r, startAngle, endAngle);
  return (
    <svg className="w-full max-w-[200px] h-auto" viewBox="0 0 200 115">
      <path d={trackPath} fill="none" stroke="#334155" strokeWidth={14} strokeLinecap="round" />
      <path d={valuePath} fill="none" stroke={scoreColor(score)} strokeWidth={14} strokeLinecap="round" />
      <text x={100} y={96} textAnchor="middle" fontSize={30} fontWeight="bold" fill={scoreColor(score)}>
        {score}
      </text>
    </svg>
  );
}

const COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e','#3b82f6',
  '#8b5cf6','#ec4899','#14b8a6','#a855f7','#f59e0b',
  '#06b6d4','#84cc16','#fb923c','#34d399','#60a5fa',
  '#f472b6','#a3e635','#38bdf8',
];

export default function DiversificationGauge() {
  const [data, setData] = useState<DiversificationHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insight, setInsight] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      fetch('/api/diversification')
        .then(r => r.json())
        .then(d => setData(d as DiversificationHealth))
        .catch(console.error)
        .finally(() => setLoading(false));
    }, 2000);
    return () => clearTimeout(t);
  }, []);

  function requestInsight() {
    setInsightLoading(true);
    fetch('/api/diversification?insight=1')
      .then(r => r.json())
      .then(d => setInsight((d as DiversificationHealth).aiInsight ?? null))
      .catch(() => setInsight('Unable to generate insight. Please try again.'))
      .finally(() => setInsightLoading(false));
  }

  const score   = data?.overallScore ?? 0;
  const pieData = data?.countryBreakdown?.map(c => ({ name: c.country, value: c.percentage })) ?? [];

  return (
    <div className="p-4 h-full flex flex-col gap-3">

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="sq-label">Supply Chain Health</h2>
        {data && (
          <span className="sq-chip">
            <span className="w-1 h-1 rounded-full bg-green-400 inline-block animate-pulse" />
            Live
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-slate-500 animate-pulse">Loading…</p>
      ) : (
        <>
          {/* AI Insight — top */}
          {insight ? (
            <div className="sq-insight">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                <span className="sq-label" style={{ color: '#60a5fa' }}>AI Insight</span>                <span className="sq-badge-ai ml-auto"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="3" opacity=".5"/><circle cx="4" cy="4" r="1.5"/></svg>AI generated</span>              </div>
              <p className="text-xs text-slate-300 leading-relaxed">{insight}</p>
            </div>
          ) : (
            <button onClick={requestInsight} disabled={insightLoading} className="sq-ai-btn">
              {insightLoading ? (
                <>
                  <svg className="animate-spin w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  <span className="text-[11px] text-blue-400">Analysing portfolio…</span>
                </>
              ) : (
                <>
                  <span className="text-blue-400">✦</span>
                  <span className="text-[11px] font-medium text-blue-400">Generate AI Insight</span>
                </>
              )}
            </button>
          )}

          {/* Score row */}
          <div className="flex flex-col sm:flex-row items-center gap-4">
            <Gauge score={score} />
            <div>
              <p className="text-2xl font-bold" style={{ color: scoreColor(score) }}>
                {score}<span className="text-sm text-slate-500 font-normal">/100</span>
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {score >= 70 ? 'Well diversified' : score >= 40 ? 'Moderate risk' : 'Concentrated risk'}
              </p>
            </div>
          </div>

          {/* Donut — centred, no labels */}
          {pieData.length > 0 && (
            <div className="flex flex-col items-center gap-4">
              <div className="w-full max-w-[220px] lg:max-w-[260px]" style={{ aspectRatio: '1' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={100}
                      innerRadius={44}
                    >
                      {pieData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                      formatter={(v: number, name: string) => [`${v}%`, name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              {/* Country grid below chart */}
              <div className="w-full grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-1.5 px-2 pb-2">
                {pieData.map((entry, i) => (
                  <div key={entry.name} className="flex items-center gap-2 min-w-0">
                    <span
                      className="shrink-0 rounded-full"
                      style={{ width: 8, height: 8, backgroundColor: COLORS[i % COLORS.length] }}
                    />
                    <span className="text-xs text-slate-400 truncate flex-1">{entry.name}</span>
                    <span className="text-xs font-semibold tabular-nums text-slate-200 shrink-0">
                      {entry.value}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Concentration warnings */}
          {data?.concentrationWarnings && data.concentrationWarnings.length > 0 && (
            <div className="flex flex-col gap-1">
              {data.concentrationWarnings
                .filter(w => w.severity === 'critical' || w.severity === 'high')
                .slice(0, 3)
                .map(w => (
                  <div
                    key={w.country}
                    className="flex items-center gap-2 rounded-md px-2.5 py-1.5 border"
                    style={{
                      borderColor: w.severity === 'critical' ? 'rgba(239,68,68,0.45)' : 'rgba(249,115,22,0.45)',
                      background:  w.severity === 'critical' ? 'rgba(239,68,68,0.14)' : 'rgba(249,115,22,0.14)',
                    }}
                  >
                    <span className="shrink-0 w-1.5 h-1.5 rounded-full"
                      style={{ background: w.severity === 'critical' ? '#ef4444' : '#f97316' }} />
                    <span className="text-[10px] text-slate-400 flex-1 truncate">{w.country}</span>
                    <span className="text-[10px] font-semibold tabular-nums"
                      style={{ color: w.severity === 'critical' ? '#f87171' : '#fb923c' }}>
                      {w.percentage.toFixed(1)}%
                    </span>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
