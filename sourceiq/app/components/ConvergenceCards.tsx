'use client';
// ConvergenceCards — real-time multi-domain threat convergence alerts
// Receives live data via SSE from /api/risk-stream (event: 'convergence')

import { useEffect, useState } from 'react';
import type { ConvergenceCard } from '../../src/types/index';

const SEV: Record<string, { bg: string; border: string; badge: string; dot: string }> = {
  critical: { bg: 'bg-red-100 dark:bg-red-950/60',    border: 'border-red-300 dark:border-red-700',    badge: 'bg-red-700 text-red-100',    dot: 'bg-red-400' },
  high:     { bg: 'bg-orange-100 dark:bg-orange-950/60', border: 'border-orange-300 dark:border-orange-700', badge: 'bg-orange-700 text-orange-100', dot: 'bg-orange-400' },
  medium:   { bg: 'bg-yellow-100 dark:bg-yellow-950/60', border: 'border-yellow-300 dark:border-yellow-700', badge: 'bg-yellow-700 text-yellow-100', dot: 'bg-yellow-400' },
};

export default function ConvergenceCards() {
  const handleAnalyze = (query: string) => {
    window.dispatchEvent(
      new CustomEvent('sourceiq:analyze-country', { detail: query }),
    );
  };
  const [cards, setCards] = useState<ConvergenceCard[]>([]);

  useEffect(() => {
    const es = new EventSource('/api/risk-stream');
    es.addEventListener('convergence', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as ConvergenceCard[];
        if (Array.isArray(data)) setCards(data);
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, []);

  if (cards.length === 0) return null;

  return (
    <section
      aria-label="Signal Convergence Alerts"
      aria-live="polite"
      aria-atomic="false"
      className="px-3 py-2 space-y-2"
    >
      <div className="flex items-center gap-2 mb-1" aria-hidden="true">
        <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
        <span className="text-[10px] font-semibold text-orange-400 uppercase tracking-widest">
          Signal Convergence Detected
        </span>
      </div>

      {cards.map((card) => {
        const s = SEV[card.severity] ?? SEV.medium;
        return (
          <div
            key={card.country}
            role="article"
            aria-label={`${card.severity} convergence alert for ${card.country}, score ${card.score}`}
            className={`rounded-lg border p-2.5 ${s.bg} ${s.border} transition-all`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} aria-hidden="true" />
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{card.title}</span>
              </div>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${s.badge}`}>
                <span className="sr-only">Severity: </span>{card.severity.toUpperCase()} · {card.score}
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap gap-1" aria-label="Active signal dimensions">
              {card.signals.map(sig => (
                <span key={sig} className="text-[10px] bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-1.5 py-0.5 rounded">
                  {sig}
                </span>
              ))}
            </div>

            <button
              onClick={() => handleAnalyze(`Analyze sourcing risk for ${card.country} — convergence score ${card.score}`)}
              aria-label={`Deep analysis for ${card.country}`}
              className="mt-1.5 text-[10px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 rounded"
            >
              Deep analysis →
            </button>
          </div>
        );
      })}
    </section>
  );
}
