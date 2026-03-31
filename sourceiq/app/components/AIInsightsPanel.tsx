'use client';
// AIInsightsPanel — World Brief + Decision Brief
// World Brief: LLM-generated from live SRI data, refreshes every hour
// Decision Brief: auto-populated from the last chat response via sourceiq:decision-brief event

import { useState, useEffect, useCallback } from 'react';
import type { WorldBrief } from '../../src/types/index';
import MorningBriefPanel from './MorningBrief';

interface Props {
  onAnalyze: (query: string) => void;
}

export default function AIInsightsPanel({ onAnalyze }: Props) {
  const [brief, setBrief] = useState<WorldBrief | null>(null);
  const [briefLoading, setBriefLoading] = useState(true);

  const fetchBrief = useCallback(async () => {
    try {
      const res = await fetch('/api/world-brief');
      if (res.ok) setBrief(await res.json() as WorldBrief);
    } catch { /* ignore */ } finally {
      setBriefLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBrief();
    const timer = setInterval(fetchBrief, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* ── World Brief ─────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-slate-200 dark:border-slate-800 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="sq-label">AI Insights — World Brief</span>
          <div className="flex items-center gap-2">
            <span className="sq-badge-ai"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="3" opacity=".5"/><circle cx="4" cy="4" r="1.5"/></svg>AI generated</span>
            <span className="sq-chip" style={{ borderColor: 'rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.07)', color: '#4ade80' }}>
              <span className="w-1 h-1 rounded-full bg-green-400 animate-pulse inline-block" />
              LIVE
            </span>
          </div>
        </div>

        {briefLoading && (
          <div className="space-y-1.5">
            <div className="h-2.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse w-full" />
            <div className="h-2.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse w-4/5" />
            <div className="h-2.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse w-3/5" />
          </div>
        )}

        {brief && !briefLoading && (
          <>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{brief.summary}</p>

            {brief.headlines && brief.headlines.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="sq-label mb-1">Live Headlines</div>
                {brief.headlines.slice(0, 4).map((h, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-orange-400 mt-1.5 flex-shrink-0" />
                    {h.url ? (
                      <a href={h.url} target="_blank" rel="noopener noreferrer"
                        className="text-[10px] text-slate-500 dark:text-slate-400 hover:text-slate-200 leading-snug line-clamp-2 transition-colors">
                        {h.headline}
                        <span className="ml-1 text-slate-600">({h.source})</span>
                      </a>
                    ) : (
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug line-clamp-2">
                        {h.headline}
                        <span className="ml-1 text-slate-600">({h.source})</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-1 mt-2 flex-wrap">
              {brief.topRiskCountries.slice(0, 4).map(c => (
                <button key={c} onClick={() => onAnalyze(`Analyze sourcing risk for ${c}`)}
                  className="sq-chip hover:brightness-110 transition-all cursor-pointer">
                  {c} →
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Morning Brief ────────────────────────────────── */}
      <div className="flex-1 p-3 min-h-0">
        <MorningBriefPanel onPrefillChat={onAnalyze} embedded />
      </div>
    </div>
  );
}
