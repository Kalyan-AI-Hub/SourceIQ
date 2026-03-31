'use client';

import { useState, useEffect } from 'react';
import type { MorningBrief as MorningBriefData, MorningBriefItem } from '../../src/types/index';
import DecisionQueue from './DecisionQueue';

interface Props {
  onPrefillChat?: (text: string) => void;
  embedded?: boolean;
}

function AlertCard({
  item,
  type,
  onPrefillChat,
}: {
  item: MorningBriefItem;
  type: 'alert' | 'savings';
  onPrefillChat?: (q: string) => void;
}) {
  const isAlert = type === 'alert';
  const borderColor =
    item.severity === 'critical' ? 'rgba(239,68,68,0.40)' :
    item.severity === 'high'     ? 'rgba(249,115,22,0.40)' :
                                   'rgba(71,85,105,0.40)';
  const bgColor =
    item.severity === 'critical' ? 'rgba(239,68,68,0.08)' :
    item.severity === 'high'     ? 'rgba(249,115,22,0.08)' :
                                   'rgba(30,41,59,0.50)';
  const dotColor =
    item.severity === 'critical' ? '#f87171' :
    item.severity === 'high'     ? '#fb923c' :
                                   '#94a3b8';

  return (
    <div
      className="rounded-lg border px-3 py-2.5 flex items-start justify-between gap-3"
      style={{ borderColor, background: bgColor }}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor }} />
          <span className="text-xs font-semibold text-slate-100 truncate">
            {isAlert ? item.affectedCountry : item.sku}
          </span>
          <span className="text-[10px] text-slate-500 shrink-0">
            {isAlert ? item.severity : item.affectedCountry}
          </span>
        </div>
        <p className="text-xs text-slate-300 leading-snug">{item.headline}</p>
        {item.recommendedAction && (
          <p className="text-[11px] text-slate-500 leading-snug">{item.recommendedAction}</p>
        )}
      </div>
      <div className="shrink-0 flex flex-col items-end gap-1.5">
        {!isAlert && item.potentialSavingsUSD != null && (
          <span className="text-xs font-bold text-emerald-400">
            +${item.potentialSavingsUSD.toLocaleString()}
          </span>
        )}
        {onPrefillChat && (
          <button
            onClick={() => {
              const query = isAlert
                ? `Analyze sourcing risk for ${item.affectedCountry} — what are the best alternative countries?`
                : `Analyze switching ${item.sku} from ${item.affectedCountry} — show tariff comparison and savings`;
              onPrefillChat(query);
            }}
            className="sq-action-btn"
          >
            Analyze →
          </button>
        )}
      </div>
    </div>
  );
}

export default function MorningBrief({ onPrefillChat, embedded = false }: Props) {
  const [brief, setBrief] = useState<MorningBriefData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBrief = (forceRefresh = false) => {
    setLoading(true);
    const url = forceRefresh ? `/api/morning-brief?bust=${Date.now()}` : '/api/morning-brief';
    fetch(url)
      .then(r => r.json())
      .then(d => setBrief(d as MorningBriefData))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(() => fetchBrief(false), 6000);
    return () => clearTimeout(t);
  }, []);

  const metrics = brief
    ? [
        {
          label: 'SKUs at Risk',
          value: String(brief.totalAffectedSkus),
          tone: brief.totalAffectedSkus > 0 ? 'text-amber-300' : 'text-emerald-300',
          subtitle: 'Inventory items flagged today',
        },
        {
          label: 'Savings Opportunity',
          value: `$${brief.totalPotentialSavingsUSD.toLocaleString()}`,
          tone: 'text-emerald-300',
          subtitle: 'Annual upside identified',
        },
        {
          label: 'Risk Alerts',
          value: String(brief.criticalAlerts.length),
          tone: brief.criticalAlerts.length > 0 ? 'text-red-300' : 'text-emerald-300',
          subtitle: 'Critical + high signals',
        },
      ]
    : [];

  if (loading) {
    return (
      <section className={`sq-panel px-4 py-4 ${embedded ? '' : 'mx-3 mt-3'}`}>
        <div className="flex items-center gap-2 mb-3">
          <span className="sq-label">Morning Brief</span>
          <span className="sq-chip">Generating…</span>
        </div>
        <div className="space-y-2 animate-pulse">
          <div className="h-2.5 bg-slate-800 rounded w-full" />
          <div className="h-2.5 bg-slate-800 rounded w-4/5" />
          <div className="h-2.5 bg-slate-800 rounded w-3/5" />
        </div>
      </section>
    );
  }

  if (!brief) return null;

  return (
    <>
    <section
      className={`sq-panel px-4 py-4 ${embedded ? '' : 'mx-3 mt-3'}`}
      aria-label="Morning brief"
    >
      {/* ── Header ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="sq-label">Morning Brief</span>
          <span className="sq-chip">
            <span className="w-1 h-1 rounded-full bg-green-400 inline-block animate-pulse" />
            Live
          </span>
          {brief.criticalAlerts.length > 0 && (
            <span
              className="sq-chip"
              style={{
                borderColor: 'rgba(239,68,68,0.35)',
                background: 'rgba(239,68,68,0.10)',
                color: '#f87171',
              }}
            >
              {brief.criticalAlerts.length} alert{brief.criticalAlerts.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {brief.generatedAt && (
            <span className="text-[10px] text-slate-500">
              {new Date(brief.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => fetchBrief(true)}
            disabled={loading}
            title="Refresh brief"
            aria-label="Refresh morning brief"
            className="text-slate-500 hover:text-slate-300 disabled:opacity-40 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Delta banner — what changed since last brief ── */}
      {brief.delta?.hasDelta && (brief.delta.newAlerts.length > 0 || brief.delta.resolved.length > 0 || brief.delta.escalated.length > 0 || brief.delta.deEscalated.length > 0 || brief.delta.newOpportunities.length > 0) && (
        <div className="sq-subcard mb-3 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="sq-label" style={{ color: '#fbbf24' }}>Changes since last brief</span>
            {brief.delta.previousGeneratedAt && (
              <span className="text-[10px] text-slate-600 ml-auto">
                vs {new Date(brief.delta.previousGeneratedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          {brief.delta.newAlerts.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">NEW RISK</span>
              {brief.delta.newAlerts.map(c => (
                <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/50 border border-red-700/40 text-red-300">{c}</span>
              ))}
            </div>
          )}
          {brief.delta.escalated.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-bold text-orange-400 uppercase tracking-wider">ESCALATED</span>
              {brief.delta.escalated.map(e => (
                <span key={e.country} className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/40 border border-orange-700/40 text-orange-300">
                  {e.country} {e.from}→{e.to}
                </span>
              ))}
            </div>
          )}
          {brief.delta.resolved.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">RESOLVED</span>
              {brief.delta.resolved.map(c => (
                <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-700/40 text-emerald-300">{c}</span>
              ))}
            </div>
          )}
          {brief.delta.deEscalated.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">IMPROVING</span>
              {brief.delta.deEscalated.map(e => (
                <span key={e.country} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-700/40 text-blue-300">
                  {e.country} {e.from}→{e.to}
                </span>
              ))}
            </div>
          )}
          {brief.delta.newOpportunities.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">NEW SAVINGS</span>
              {brief.delta.newOpportunities.slice(0, 4).map(sku => (
                <span key={sku} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-700/40 text-emerald-300">{sku}</span>
              ))}
              {brief.delta.newOpportunities.length > 4 && (
                <span className="text-[10px] text-slate-500">+{brief.delta.newOpportunities.length - 4} more</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── AI Summary ─────────────────────────────────── */}
      {brief.aiSummary && (
        <div className="sq-subcard mb-4">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            <span className="sq-label" style={{ color: '#60a5fa' }}>AI Summary</span>
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">{brief.aiSummary}</p>
        </div>
      )}

      {/* ── Key metric tiles ───────────────────────────── */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3 mb-4">
        {metrics.map(m => (
          <div key={m.label} className="sq-metric">
            <span className="sq-metric-label">{m.label}</span>
            <span className={`sq-metric-value ${m.tone}`}>{m.value}</span>
            <span className="sq-metric-subtle">{m.subtitle}</span>
          </div>
        ))}
      </div>

      {/* ── Decision Queue — agentic action items (ranked by urgency) ── */}
      {brief.decisions && brief.decisions.length > 0 && (
        <div className="mb-4 -mx-4 px-0">
          <div className="border-t border-b border-slate-800/60 py-3 px-4 mb-1">
            <DecisionQueue decisions={brief.decisions} embedded />
          </div>
        </div>
      )}

      {/* ── Risk Alerts — supporting intelligence for the decisions above ── */}
      {brief.criticalAlerts.length > 0 && (
        <div className="mb-3">
          <div className="sq-label mb-2">Risk Signals</div>
          <div className="flex flex-col gap-2">
            {brief.criticalAlerts.map((item, i) => (
              <AlertCard key={i} item={item} type="alert" onPrefillChat={onPrefillChat} />
            ))}
          </div>
        </div>
      )}

      {brief.criticalAlerts.length === 0 && (!brief.decisions || brief.decisions.length === 0) && (
        <p className="text-xs text-slate-500 py-4 text-center">No alerts today. Supply chain looks stable.</p>
      )}
    </section>
    </>
  );
}
