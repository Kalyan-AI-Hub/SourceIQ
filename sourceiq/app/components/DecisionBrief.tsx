'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentResponse } from '../../src/types/index';

interface DecisionBriefPayload {
  query: string;
  response: AgentResponse;
}

interface PendingDecisionBriefPayload {
  query: string;
}

interface BriefMetric {
  label: string;
  value: string;
  subtitle: string;
  tone?: string;
  wide?: boolean;
}

interface BriefModel {
  headline: string;
  summary: string;
  metrics: BriefMetric[];
  currentCountry: string | null;
  recommendedCountry: string | null;
  confidence: 'High' | 'Medium' | 'Low';
  toolCount: number;
  query: string;
}

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = clean.match(/.+?[.!?](\s|$)/);
  return (match?.[0] ?? clean).trim();
}

function parseInventoryFallback(answer: string): { sourceCountry: string | null; itemCount: number } {
  const sourceCountry = answer.match(/items sourced from\s+([^:\n.]+)/i)?.[1]?.trim() ?? null;
  const itemCount = answer
    .split('\n')
    .filter((line) => /^\s*\d+[.)]\s+/.test(line))
    .length;

  return { sourceCountry, itemCount };
}

function buildModel(payload: DecisionBriefPayload | null): BriefModel | null {
  if (!payload) return null;

  const { query, response } = payload;
  const best = response.recommendations?.[0];
  const recs = response.recommendations ?? [];
  const distinctSkus = new Set(recs.map(r => r.sku));
  const isSingleSku = distinctSkus.size <= 1 && recs.length > 1;
  const totalSavings = isSingleSku
    ? Math.max(...recs.map(r => r.annualSavingsUSD))
    : recs.reduce((sum, item) => sum + item.annualSavingsUSD, 0);
  const avgRisk = response.recommendations?.length
    ? Math.round((response.recommendations.reduce((sum, item) => sum + item.riskScore, 0)) / response.recommendations.length)
    : response.riskAlerts?.length
      ? Math.min(95, 30 + response.riskAlerts.length * 12)
      : null;
  const inventoryFallback = parseInventoryFallback(response.answer);
  const isInventoryLookup = !response.recommendations?.length && inventoryFallback.itemCount > 0;
  const isRiskBrief = !response.recommendations?.length && !isInventoryLookup && (!!response.riskAlerts?.length || /risk brief|sourcing risk|risk posture/i.test(`${query} ${response.answer}`));

  let headline = firstSentence(response.answer);
  if (best && totalSavings > 0) {
    headline = `Shift ${response.recommendations?.length ?? 1} SKU${(response.recommendations?.length ?? 1) > 1 ? 's' : ''} from ${best.currentCountry} to ${best.recommendedCountry} to unlock ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(totalSavings)} in annual savings.`;
  } else if (best) {
    headline = `${best.recommendedCountry} is the strongest alternative for ${best.sku}, balancing cost and risk better than ${best.currentCountry}.`;
  } else if (isInventoryLookup) {
    headline = `${inventoryFallback.itemCount} inventory item${inventoryFallback.itemCount === 1 ? '' : 's'} matched${inventoryFallback.sourceCountry ? ` in ${inventoryFallback.sourceCountry}` : ''}.`;
  } else if (isRiskBrief) {
    headline = response.answer.includes('AI summarization offline')
      ? 'Deterministic country risk brief generated while AI summarization is offline.'
      : firstSentence(response.answer);
  }

  const summary = response.recommendations?.length
    ? `${response.recommendations.length} recommendation${response.recommendations.length > 1 ? 's' : ''} grounded on tariff, inventory, and geopolitical signals.`
    : isInventoryLookup
      ? `${inventoryFallback.itemCount} catalog match${inventoryFallback.itemCount === 1 ? '' : 'es'} returned from SourceIQ inventory records${response.answer.includes('AI summarization offline') ? ' using fallback catalog formatting.' : '.'}`
    : isRiskBrief
      ? `${response.riskAlerts?.length ?? 0} active alert${(response.riskAlerts?.length ?? 0) === 1 ? '' : 's'} shaped this brief.`
    : response.riskAlerts?.length
      ? `${response.riskAlerts.length} active alert${response.riskAlerts.length > 1 ? 's' : ''} shaped this brief.`
      : `Response generated from live SourceIQ intelligence for: ${query}`;

  const confidence: 'High' | 'Medium' | 'Low' = response.recommendations?.length
    ? 'High'
    : response.toolsUsed?.length
      ? 'Medium'
      : 'Low';

  const metrics: BriefMetric[] = response.recommendations?.length
    ? [
        {
          label: 'Annual Upside',
          value: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(totalSavings),
          subtitle: isSingleSku ? 'Best alternative savings' : 'Portfolio-level savings identified',
          tone: 'text-emerald-300',
        },
        {
          label: 'Risk Posture',
          value: String(avgRisk ?? 'N/A'),
          subtitle: 'Average decision risk score',
          tone: avgRisk !== null && avgRisk >= 70 ? 'text-red-300' : avgRisk !== null && avgRisk >= 40 ? 'text-amber-300' : 'text-emerald-300',
        },
        {
          label: 'Shift Path',
          value: `${best?.currentCountry ?? 'Mixed'} → ${best?.recommendedCountry ?? 'Review'}`,
          subtitle: 'Current concentration versus best route',
          tone: 'text-slate-100 text-[18px] leading-5',
        },
        {
          label: 'Question',
          value: query,
          subtitle: 'Last executive brief generated',
          wide: true,
        },
      ]
    : isInventoryLookup
      ? [
          {
            label: 'Items Found',
            value: String(inventoryFallback.itemCount),
            subtitle: 'Matched inventory records',
            tone: 'text-cyan-300',
          },
          {
            label: 'Source Market',
            value: inventoryFallback.sourceCountry ?? 'Mixed',
            subtitle: 'Country found in catalog data',
            tone: 'text-slate-100 text-[18px] leading-5',
          },
          {
            label: 'Inference Mode',
            value: response.answer.includes('AI summarization offline') ? 'Fallback data' : 'Live lookup',
            subtitle: response.answer.includes('AI summarization offline') ? 'Raw inventory formatting shown' : 'AI formatted inventory brief',
            tone: response.answer.includes('AI summarization offline') ? 'text-amber-300 text-[18px] leading-5' : 'text-emerald-300 text-[18px] leading-5',
          },
          {
            label: 'Question',
            value: query,
            subtitle: 'Current inventory lookup',
            wide: true,
          },
        ]
      : isRiskBrief
        ? [
            {
              label: 'Risk Posture',
              value: String(avgRisk ?? 'N/A'),
              subtitle: 'Signal-based sourcing risk score',
              tone: avgRisk !== null && avgRisk >= 70 ? 'text-red-300' : avgRisk !== null && avgRisk >= 40 ? 'text-amber-300' : 'text-emerald-300',
            },
            {
              label: 'Active Alerts',
              value: String(response.riskAlerts?.length ?? 0),
              subtitle: 'Events shaping this country brief',
              tone: (response.riskAlerts?.length ?? 0) > 0 ? 'text-red-300' : 'text-emerald-300',
            },
            {
              label: 'Inference Mode',
              value: response.answer.includes('AI summarization offline') ? 'Deterministic brief' : 'AI summary',
              subtitle: response.answer.includes('AI summarization offline') ? 'Fallback activated for resiliency' : 'Narrative generated from live signals',
              tone: response.answer.includes('AI summarization offline') ? 'text-amber-300 text-[18px] leading-5' : 'text-emerald-300 text-[18px] leading-5',
            },
            {
              label: 'Question',
              value: query,
              subtitle: 'Last executive brief generated',
              wide: true,
            },
          ]
        : [
            {
              label: 'Tools Used',
              value: String(response.toolsUsed?.length ?? 0),
              subtitle: 'Live intelligence sources invoked',
              tone: 'text-cyan-300',
            },
            {
              label: 'Inference Mode',
              value: response.source === 'local' ? 'On-device' : 'Cloud',
              subtitle: 'Primary inference path',
              tone: 'text-slate-100 text-[18px] leading-5',
            },
            {
              label: 'Confidence',
              value: confidence,
              subtitle: 'Signal coverage for this answer',
              tone: confidence === 'High' ? 'text-emerald-300 text-[18px] leading-5' : confidence === 'Medium' ? 'text-amber-300 text-[18px] leading-5' : 'text-slate-100 text-[18px] leading-5',
            },
            {
              label: 'Question',
              value: query,
              subtitle: 'Latest executive brief generated',
              wide: true,
            },
          ];

  return {
    headline,
    summary,
    metrics,
    currentCountry: best?.currentCountry ?? null,
    recommendedCountry: best?.recommendedCountry ?? null,
    confidence,
    toolCount: response.toolsUsed?.length ?? 0,
    query,
  };
}

export default function DecisionBrief({ embedded = false }: { embedded?: boolean }) {
  const [payload, setPayload] = useState<DecisionBriefPayload | null>(null);
  const [pendingQuery, setPendingQuery] = useState<string | null>(null);

  useEffect(() => {
    const initial = window.sessionStorage.getItem('sourceiq:last-brief');
    if (initial) {
      try {
        setPayload(JSON.parse(initial) as DecisionBriefPayload);
      } catch {
        window.sessionStorage.removeItem('sourceiq:last-brief');
      }
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DecisionBriefPayload>).detail;
      if (detail?.response) {
        setPayload(detail);
        setPendingQuery(null);
        window.sessionStorage.setItem('sourceiq:last-brief', JSON.stringify(detail));
      }
    };

    const pendingHandler = (event: Event) => {
      const detail = (event as CustomEvent<PendingDecisionBriefPayload>).detail;
      if (detail?.query) setPendingQuery(detail.query);
    };

    window.addEventListener('sourceiq:decision-brief', handler as EventListener);
    window.addEventListener('sourceiq:decision-brief-pending', pendingHandler as EventListener);
    return () => {
      window.removeEventListener('sourceiq:decision-brief', handler as EventListener);
      window.removeEventListener('sourceiq:decision-brief-pending', pendingHandler as EventListener);
    };
  }, []);

  const brief = useMemo(() => buildModel(payload), [payload]);

  const isPendingNewQuery = !!pendingQuery && pendingQuery !== brief?.query;

  if (!brief && !pendingQuery) {
    return (
      <section className={`sq-panel px-4 py-3 text-sm ${embedded ? '' : 'mx-3 mt-3'}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-700 dark:text-slate-200 font-medium">Ask a sourcing question to generate an executive recommendation.</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">SourceIQ will surface action, savings, and risk posture in one place.</p>
          </div>
          <span className="sq-chip">Awaiting query</span>
        </div>
      </section>
    );
  }

  if (isPendingNewQuery) {
    return (
      <section className="sq-panel mx-3 mt-3 px-4 py-4" aria-label="Decision brief loading state">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="sq-label">Decision Brief</span>
              <span className="sq-chip">Preparing</span>
            </div>
            <h2 className="text-[15px] leading-6 font-semibold text-slate-900 dark:text-slate-50 max-w-4xl text-balance line-clamp-2">{pendingQuery}</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 max-w-3xl">SourceIQ is refreshing the executive brief with current inventory, tariff, and geopolitical context.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 min-w-0 lg:min-w-[420px]">
            <div className="sq-metric">
              <span className="sq-metric-label">Status</span>
              <span className="sq-metric-value text-cyan-300">Live</span>
              <span className="sq-metric-subtle">Running the latest query now</span>
            </div>
            <div className="sq-metric">
              <span className="sq-metric-label">Brief State</span>
              <span className="sq-metric-value text-amber-300 text-[18px] leading-5">Updating</span>
              <span className="sq-metric-subtle">Previous brief held until response completes</span>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (!brief) return null;

  return (
    <section className={`sq-panel px-4 py-4 ${embedded ? '' : 'mx-3 mt-3'}`} aria-label="Decision brief">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="sq-label">Decision Brief</span>
            <span className="sq-chip">Confidence {brief.confidence}</span>
            {brief.toolCount > 0 && <span className="sq-chip">{brief.toolCount} live tools</span>}
          </div>
          <h2 className="text-[15px] leading-6 font-semibold text-slate-900 dark:text-slate-50 max-w-4xl text-balance">{brief.headline}</h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 max-w-3xl">{brief.summary}</p>
        </div>

        <div className="flex flex-wrap gap-2 shrink-0">
          {brief.recommendedCountry && (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('sourceiq:whatif-country', { detail: brief.recommendedCountry }))}
              className="sq-action-btn"
            >
              Simulate {brief.recommendedCountry}
            </button>
          )}
          {(brief.recommendedCountry ?? brief.currentCountry) && (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('sourceiq:analyze-country', { detail: `Analyze sourcing risk for ${brief.recommendedCountry ?? brief.currentCountry}` }))}
              className="sq-action-btn"
            >
              Open country brief
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-3 mt-4 sm:grid-cols-2 xl:grid-cols-3">
        {brief.metrics.map((metric) => (
          <div key={metric.label} className={`sq-metric min-w-0 ${metric.wide ? 'sm:col-span-2 xl:col-span-3' : ''}`}>
            <span className="sq-metric-label">{metric.label}</span>
            <span className={`sq-metric-value ${metric.tone ?? 'text-slate-100'} ${metric.wide ? 'text-base leading-6' : ''}`}>{metric.value}</span>
            <span className="sq-metric-subtle">{metric.subtitle}</span>
          </div>
        ))}
      </div>
    </section>
  );
}