'use client';
// SignalConvergenceStrip — replaces RiskRadarStrip + inline ConvergenceCards overlay
// Live convergence pills in a cockpit strip. Click any country to expand full detail.
// MUST be loaded via dynamic(() => import(...), { ssr: false }) — uses EventSource.

import { useEffect, useRef, useState } from 'react';
import type { ConvergenceCard } from '../../src/types/index';

const SEV_PILL: Record<string, string> = {
  critical: 'border-red-700/70    bg-red-950/50    text-red-300',
  high:     'border-orange-700/60 bg-orange-950/40 text-orange-300',
  medium:   'border-yellow-700/50 bg-yellow-950/30 text-yellow-300',
};
const SEV_DOT: Record<string, string> = {
  critical: 'bg-red-400',
  high:     'bg-orange-400',
  medium:   'bg-yellow-400',
};
const SEV_BADGE: Record<string, string> = {
  critical: 'bg-red-900/80 text-red-200 border border-red-700/60',
  high:     'bg-orange-900/80 text-orange-200 border border-orange-700/60',
  medium:   'bg-yellow-900/80 text-yellow-200 border border-yellow-700/60',
};

function dispatch(event: string, detail: string) {
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

interface DetailPanelProps {
  card: ConvergenceCard;
  onClose: () => void;
}

function DetailPanel({ card, onClose }: DetailPanelProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const badge = SEV_BADGE[card.severity] ?? SEV_BADGE.medium;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`Signal convergence detail: ${card.country}`}
      className="absolute bottom-full left-0 right-0 z-[1002] mb-px
        bg-slate-900/98 border border-slate-700/70 shadow-[var(--sq-shadow-float)]
        backdrop-blur-md animate-fadeIn"
    >
      <div className="px-4 py-3 flex flex-col sm:flex-row items-start gap-4">
        {/* Left: title + signals */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badge}`}>
              {card.severity.toUpperCase()} · {card.score}
            </span>
            <span className="text-sm font-semibold text-slate-100">{card.title}</span>
          </div>

          {/* Signal chips */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {card.signals.map(sig => (
              <span key={sig}
                className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 border border-slate-700/60 text-slate-300">
                {sig}
              </span>
            ))}
          </div>

          {/* Impact estimate if available */}
          {card.impactEstimateUSD !== undefined && card.impactEstimateUSD > 0 && (
            <div className="text-[11px] text-slate-400">
              Est. portfolio impact:&nbsp;
              <span className="font-semibold text-amber-300">
                ${card.impactEstimateUSD.toLocaleString()}/yr
              </span>
            </div>
          )}
        </div>

        {/* Right: actions */}
        <div className="flex flex-row sm:flex-col gap-1.5 shrink-0 w-full sm:w-auto">
          <button
            onClick={() => { dispatch('sourceiq:analyze-country', `Analyze sourcing risk for ${card.country} — convergence score ${card.score}`); onClose(); }}
            className="text-[11px] font-semibold bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          >
            Deep analysis →
          </button>
          <button
            onClick={() => { dispatch('sourceiq:whatif-country', card.country); onClose(); }}
            className="text-[11px] text-slate-400 hover:text-slate-200 border border-slate-700 hover:border-slate-500 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          >
            Simulate reroute →
          </button>
        </div>

        {/* Close */}
        <button
          onClick={onClose}
          aria-label="Close detail panel"
          className="text-slate-500 hover:text-slate-300 text-lg leading-none mt-0.5 transition-colors"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export default function SignalConvergenceStrip() {
  const [cards, setCards] = useState<ConvergenceCard[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

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

  if (cards.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-slate-900 border-b border-slate-800 shrink-0 text-xs text-slate-600">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-700 animate-pulse" />
        Convergence monitor initializing…
      </div>
    );
  }

  const criticalCount = cards.filter(c => c.severity === 'critical').length;
  const expandedCard  = cards.find(c => c.country === expanded) ?? null;

  return (
    <div className="relative shrink-0" role="region" aria-label="Signal Convergence Monitor">
      {/* ── Strip row ── */}
      <div className="flex items-stretch bg-slate-900 border-b border-slate-800 overflow-x-auto">

        {/* Label column */}
        <div className="flex flex-col justify-center px-3 py-2 border-r border-slate-800 shrink-0 min-w-[110px]">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${criticalCount > 0 ? 'bg-orange-400 animate-pulse' : 'bg-slate-500'}`}
              aria-hidden="true"
            />
            <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
              Convergence
            </span>
          </div>
          <div className="mt-0.5 text-[9px] tabular-nums text-slate-500">
            {cards.length} signal{cards.length !== 1 ? 's' : ''} active
          </div>
        </div>

        {/* Country pills */}
        <div className="flex items-center gap-2 px-3 py-2 flex-1 min-w-0 overflow-x-auto">
          {cards.map(card => {
            const isOpen = expanded === card.country;
            return (
              <button
                key={card.country}
                onClick={() => setExpanded(isOpen ? null : card.country)}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
                title={`${card.country} · ${card.severity} · score ${card.score} — click for details`}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded border shrink-0
                  transition-all hover:brightness-125 focus:outline-none focus:ring-1 focus:ring-blue-500
                  ${SEV_PILL[card.severity] ?? SEV_PILL.medium}
                  ${isOpen ? 'ring-1 ring-blue-500 brightness-125' : ''}`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${SEV_DOT[card.severity] ?? 'bg-slate-400'}
                    ${card.severity === 'critical' ? 'animate-pulse' : ''}`}
                  aria-hidden="true"
                />
                <span className="text-[11px] font-semibold">{card.country}</span>
                <span className="text-[10px] tabular-nums opacity-75">{card.score}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Expanded detail panel — drops below strip, above map ── */}
      {expandedCard && (
        <DetailPanel card={expandedCard} onClose={() => setExpanded(null)} />
      )}
    </div>
  );
}
