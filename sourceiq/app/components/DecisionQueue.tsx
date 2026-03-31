'use client';
// DecisionQueue — agentic decision triage panel
//
// The Morning Brief agent pre-ranks decisions by urgency (risk × revenue impact).
// Each card shows what the agent found + why it matters now.
// User controls the next action:
//   Approve  → auto-submits the pre-built analysis query to the chat agent
//   Defer    → moves the card to the bottom of the queue (re-evaluate later)
//   Dismiss  → removes the card from this session
//
// This is the core agentic loop: Agent proposes → Human approves → Agent acts.

import { useState, useCallback, useEffect, useRef } from 'react';
import type { AgentDecision } from '../../src/types/index';
import TriageRunner from './TriageRunner';

async function notifyProcurement(decision: AgentDecision): Promise<{ sent: boolean; simulated?: boolean }> {
  try {
    const res = await fetch('/api/notify-procurement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, approvedAt: new Date().toISOString() }),
    });
    return res.ok ? await res.json() as { sent: boolean; simulated?: boolean } : { sent: false };
  } catch {
    return { sent: false };
  }
}

interface Props {
  decisions: AgentDecision[];
  embedded?: boolean;
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  risk: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  savings: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="1" x2="12" y2="23"/>
      <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
    </svg>
  ),
  diversification: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
    </svg>
  ),
};

const SEV_COLORS = {
  critical: {
    border: 'rgba(239,68,68,0.35)',
    bg: 'rgba(239,68,68,0.07)',
    icon: 'text-red-400',
    badge: 'bg-red-900/60 text-red-300 border-red-700/50',
    bar: 'bg-red-500',
    urgency: 'text-red-400',
  },
  high: {
    border: 'rgba(249,115,22,0.35)',
    bg: 'rgba(249,115,22,0.06)',
    icon: 'text-orange-400',
    badge: 'bg-orange-900/60 text-orange-300 border-orange-700/50',
    bar: 'bg-orange-500',
    urgency: 'text-orange-400',
  },
  medium: {
    border: 'rgba(71,85,105,0.40)',
    bg: 'rgba(30,41,59,0.50)',
    icon: 'text-slate-400',
    badge: 'bg-slate-800 text-slate-300 border-slate-700/50',
    bar: 'bg-slate-500',
    urgency: 'text-slate-400',
  },
};

function UrgencyBar({ score, color }: { score: number; color: string }) {
  return (
    <div className="w-full h-1 rounded-full bg-slate-800 overflow-hidden" aria-hidden="true">
      <div className={`h-1 rounded-full transition-all ${color}`} style={{ width: `${score}%` }} />
    </div>
  );
}

function DecisionCard({
  decision,
  index,
  onApprove,
  onDefer,
  onDismiss,
}: {
  decision: AgentDecision;
  index: number;
  onApprove: (d: AgentDecision) => void;
  onDefer: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [approving, setApproving] = useState(false);
  const colors = SEV_COLORS[decision.severity];

  const handleApprove = () => {
    setApproving(true);
    // Small delay so user sees "Submitting…" state before card leaves
    setTimeout(() => onApprove(decision), 300);
  };

  return (
    <div
      className="rounded-xl border px-3 py-3 transition-all"
      style={{ borderColor: colors.border, background: colors.bg }}
      role="article"
      aria-label={`Decision ${index + 1}: ${decision.headline}`}
    >
      {/* ── Top row: rank + type icon + headline + severity badge ── */}
      <div className="flex items-start gap-2.5 mb-2">
        {/* Rank number */}
        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-slate-800 border border-slate-700
                         flex items-center justify-center text-[10px] font-bold text-slate-400 mt-0.5">
          {index + 1}
        </span>

        {/* Type icon */}
        <span className={`flex-shrink-0 mt-0.5 ${colors.icon}`}>
          {TYPE_ICON[decision.type]}
        </span>

        {/* Text block */}
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-semibold text-slate-100 leading-snug mb-0.5">
            {decision.headline}
          </p>
          <p className="text-[11px] text-slate-400 leading-snug">
            {decision.rationale}
          </p>
        </div>

        {/* Severity badge */}
        <span className={`flex-shrink-0 text-[9px] font-bold uppercase tracking-wider
                          px-1.5 py-0.5 rounded border ${colors.badge}`}>
          {decision.severity}
        </span>
      </div>

      {/* ── Impact + urgency bar ── */}
      <div className="flex items-center gap-3 mb-2.5 px-0.5">
        {decision.estimatedImpactUSD !== undefined && decision.estimatedImpactUSD > 0 && (
          <span className="text-[11px] text-emerald-400 font-semibold tabular-nums whitespace-nowrap">
            {decision.type === 'risk' ? '~' : ''}${decision.estimatedImpactUSD.toLocaleString()}
            {decision.type === 'risk' ? ' at risk' : '/yr savings'}
          </span>
        )}
        <div className="flex-1 flex items-center gap-1.5">
          <UrgencyBar score={decision.urgencyScore} color={colors.bar} />
          <span className={`text-[9px] font-bold tabular-nums whitespace-nowrap ${colors.urgency}`}>
            {decision.urgencyScore}
          </span>
        </div>
      </div>

      {/* ── Action buttons ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleApprove}
          disabled={approving}
          className="flex-1 flex items-center justify-center gap-1.5 text-[11px] font-semibold
                     bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:opacity-60
                     text-white px-3 py-1.5 rounded-lg transition-colors"
          aria-label={`Approve: run analysis for ${decision.headline}`}
        >
          {approving ? (
            <>
              <span className="w-2.5 h-2.5 rounded-full border border-white/40 border-t-white animate-spin" />
              Submitting…
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Approve & Analyze
            </>
          )}
        </button>

        <button
          onClick={() => onDefer(decision.id)}
          className="text-[11px] text-slate-500 hover:text-slate-300 border border-slate-700
                     hover:border-slate-500 px-2.5 py-1.5 rounded-lg transition-colors"
          aria-label={`Defer decision: ${decision.headline}`}
          title="Move to bottom of queue — review later"
        >
          Defer
        </button>

        <button
          onClick={() => onDismiss(decision.id)}
          className="text-[11px] text-slate-600 hover:text-slate-400 transition-colors px-1"
          aria-label={`Dismiss decision: ${decision.headline}`}
          title="Dismiss from this session"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

    </div>
  );
}

interface EmailNotification {
  headline: string;
  status: 'sending' | 'sent' | 'failed';
  simulated?: boolean;
}

export default function DecisionQueue({ decisions: initialDecisions, embedded = false }: Props) {
  const [queue, setQueue] = useState<AgentDecision[]>(initialDecisions);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [emailNote, setEmailNote] = useState<EmailNotification | null>(null);
  const emailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-clear the notification after 5s
  useEffect(() => {
    if (emailNote?.status === 'sent' || emailNote?.status === 'failed') {
      emailTimerRef.current = setTimeout(() => setEmailNote(null), 5000);
    }
    return () => { if (emailTimerRef.current) clearTimeout(emailTimerRef.current); };
  }, [emailNote]);

  const handleApprove = useCallback((decision: AgentDecision) => {
    // Remove from queue and track approved
    setQueue(q => q.filter(d => d.id !== decision.id));
    setApproved(prev => new Set(prev).add(decision.id));
    // Dispatch pre-built query to chat agent
    window.dispatchEvent(
      new CustomEvent('sourceiq:analyze-country', { detail: decision.prebuiltQuery }),
    );
    // Notify procurement — show persistent banner (survives card unmount)
    setEmailNote({ headline: decision.headline, status: 'sending' });
    notifyProcurement(decision).then(result => {
      setEmailNote({
        headline: decision.headline,
        status: result.sent ? 'sent' : 'failed',
        simulated: result.simulated,
      });
    });
  }, []);

  const handleDefer = useCallback((id: string) => {
    setQueue(q => {
      const idx = q.findIndex(d => d.id === id);
      if (idx < 0) return q;
      const next = [...q];
      const [item] = next.splice(idx, 1);
      next.push(item!);
      return next;
    });
  }, []);

  const handleDismiss = useCallback((id: string) => {
    setQueue(q => q.filter(d => d.id !== id));
  }, []);

  if (initialDecisions.length === 0) return null;

  const approvedCount = approved.size;

  return (
    <section
      className={embedded ? '' : 'sq-panel mx-3 mb-3 px-4 py-4'}
      aria-label="Agent Decision Queue"
    >

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="sq-label">Decision Queue</span>
          {queue.length > 0 ? (
            <span className="sq-chip">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse inline-block" />
              {queue.length} pending
            </span>
          ) : (
            <span className="sq-chip">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
              All clear
            </span>
          )}
          {approvedCount > 0 && (
            <span className="text-[10px] text-emerald-400 font-semibold">
              {approvedCount} approved ✓
            </span>
          )}
        </div>

        {/* Urgency legend */}
        <div className="flex items-center gap-1 text-[9px] text-slate-600">
          <span>Urgency</span>
          <div className="flex items-center gap-0.5">
            <span className="w-8 h-1 rounded-full bg-gradient-to-r from-slate-700 to-red-500" />
            <span>100</span>
          </div>
        </div>
      </div>

      {/* ── Procurement email notification banner ── */}
      {emailNote && (
        <div className={`mb-3 rounded-lg px-3 py-2 flex items-center gap-2 border text-[11px] transition-all
          ${emailNote.status === 'sending' ? 'border-blue-700/50 bg-blue-950/40 text-blue-300' :
            emailNote.status === 'sent'    ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-300' :
                                            'border-slate-700/50 bg-slate-900/60 text-slate-400'}`}
        >
          {emailNote.status === 'sending' && (
            <span className="w-3 h-3 rounded-full border border-blue-400/40 border-t-blue-400 animate-spin shrink-0" />
          )}
          {emailNote.status === 'sent' && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
          {emailNote.status === 'failed' && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          )}
          <span className="truncate">
            {emailNote.status === 'sending' && `Notifying procurement about: ${emailNote.headline}…`}
            {emailNote.status === 'sent' && (
              <>Procurement notified{emailNote.simulated ? ' (logged — set SMTP_* in .env.local for real email)' : ''}: <strong className="font-semibold">{emailNote.headline}</strong></>
            )}
            {emailNote.status === 'failed' && `Email failed for: ${emailNote.headline} — check SMTP config`}
          </span>
        </div>
      )}

      {/* ── Auto-Triage runner — shown when 2+ decisions are pending ── */}
      {queue.length >= 2 && (
        <div className="mb-1">
          <TriageRunner decisions={queue} />
        </div>
      )}

      {/* ── Queue empty state ── */}
      {queue.length === 0 && (
        <div className="py-6 text-center">
          <p className="text-sm text-emerald-400 font-semibold mb-1">All decisions handled</p>
          <p className="text-[11px] text-slate-500">
            {approvedCount > 0
              ? `${approvedCount} analysis request${approvedCount > 1 ? 's' : ''} sent to the agent — check the chat.`
              : 'No pending decisions for this brief.'}
          </p>
        </div>
      )}

      {/* ── Decision cards ── */}
      {queue.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {queue.map((d, i) => (
            <DecisionCard
              key={d.id}
              decision={d}
              index={i}
              onApprove={handleApprove}
              onDefer={handleDefer}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      )}

      {/* ── Footer explanation ── */}
      {queue.length > 0 && (
        <p className="mt-3 text-[10px] text-slate-600 leading-relaxed">
          Ranked by urgency score (risk × revenue impact). <strong className="text-slate-500">Approve</strong> runs
          the full analysis in chat. <strong className="text-slate-500">Defer</strong> re-queues for later.
        </p>
      )}
    </section>
  );
}
