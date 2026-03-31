'use client';
// TriageRunner — runs top pending decisions sequentially through the chat agent
// Dispatches prebuiltQuery for each decision via sourceiq:analyze-country event.
// ChatInterface.sendRef catches and auto-submits each one.
// After all dispatched, shows a static Sourcing Action Plan from the decision data.

import { useState, useCallback } from 'react';
import type { AgentDecision } from '../../src/types/index';

interface Props {
  decisions: AgentDecision[];  // only the still-pending ones (not deferred/dismissed)
}

const MAX_TRIAGE = 3;

export default function TriageRunner({ decisions }: Props) {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [ranDecisions, setRanDecisions] = useState<AgentDecision[]>([]);

  const top = decisions.slice(0, MAX_TRIAGE);

  const runTriage = useCallback(async () => {
    if (top.length === 0) return;
    setPhase('running');
    setCurrentIdx(0);
    const ran: AgentDecision[] = [];

    for (let i = 0; i < top.length; i++) {
      setCurrentIdx(i);
      const d = top[i]!;
      ran.push(d);
      window.dispatchEvent(
        new CustomEvent('sourceiq:analyze-country', { detail: d.prebuiltQuery }),
      );
      // Wait 1800ms between dispatches so the chat interface starts processing
      // before the next query arrives (prevents queue stomping)
      if (i < top.length - 1) {
        await new Promise(r => setTimeout(r, 1800));
      }
    }

    setRanDecisions(ran);
    setPhase('done');
  }, [top]);

  if (top.length === 0) return null;

  const totalImpact = top.reduce((s, d) => s + (d.estimatedImpactUSD ?? 0), 0);
  const criticalCount = top.filter(d => d.severity === 'critical').length;

  return (
    <div className="mb-3">
      {/* ── Run button / progress ── */}
      {phase === 'idle' && (
        <button
          onClick={runTriage}
          className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-xl
                     border border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20
                     text-[12px] font-semibold text-blue-300 transition-all group"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:scale-110 transition-transform">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          Run Triage — analyze top {top.length} decision{top.length !== 1 ? 's' : ''}
          {totalImpact > 0 && (
            <span className="text-emerald-400 font-bold">${totalImpact.toLocaleString()} at stake</span>
          )}
        </button>
      )}

      {phase === 'running' && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[12px] font-semibold text-blue-300">
              Running triage… ({currentIdx + 1}/{top.length})
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {top.map((d, i) => (
              <div key={d.id} className={`flex items-center gap-2 text-[11px] ${
                i < currentIdx ? 'text-emerald-400' :
                i === currentIdx ? 'text-blue-300' : 'text-slate-600'
              }`}>
                {i < currentIdx ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : i === currentIdx ? (
                  <span className="w-2.5 h-2.5 rounded-full border border-blue-400 border-t-transparent animate-spin inline-block" />
                ) : (
                  <span className="w-2.5 h-2.5 rounded-full border border-slate-700 inline-block" />
                )}
                <span className="truncate">{d.headline}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {phase === 'done' && ranDecisions.length > 0 && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
          {/* Header */}
          <div className="flex items-center gap-2 mb-2.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
              <polyline points="9 11 12 14 22 4"/>
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
            </svg>
            <span className="text-[12px] font-semibold text-emerald-300">Sourcing Action Plan</span>
            <span className="ml-auto text-[10px] text-slate-500">{ranDecisions.length} analyses sent to chat</span>
          </div>

          {/* Impact summary */}
          {totalImpact > 0 && (
            <div className="mb-2 text-[11px] text-slate-400">
              Total estimated impact:&nbsp;
              <span className="font-bold text-emerald-300">${totalImpact.toLocaleString()}/yr</span>
              {criticalCount > 0 && (
                <span className="ml-2 text-red-400">{criticalCount} critical risk{criticalCount > 1 ? 's' : ''} flagged</span>
              )}
            </div>
          )}

          {/* Ranked action list */}
          <div className="flex flex-col gap-1.5">
            {ranDecisions.map((d, i) => (
              <div key={d.id} className="flex items-start gap-2">
                <span className="flex-shrink-0 w-4 h-4 rounded-full bg-slate-800 border border-slate-700
                                 flex items-center justify-center text-[9px] font-bold text-slate-400 mt-0.5">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-slate-200 font-medium leading-snug">{d.headline}</p>
                  {d.estimatedImpactUSD !== undefined && d.estimatedImpactUSD > 0 && (
                    <p className="text-[10px] text-slate-500">
                      {d.type === 'risk' ? '~' : ''}${d.estimatedImpactUSD.toLocaleString()}
                      {d.type === 'savings' ? '/yr savings' : ' at risk'}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-2.5 text-[10px] text-slate-600">
            Full analysis results are in the chat above. Review each response and decide on sourcing changes.
          </p>
        </div>
      )}
    </div>
  );
}
