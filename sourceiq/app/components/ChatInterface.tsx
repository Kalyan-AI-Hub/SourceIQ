'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { AgentResponse, RiskAlert } from '../../src/types/index';
import CostComparisonChart from './CostComparisonChart';
import SKUTable from './SKUTable';

interface Message {
  role: 'user' | 'assistant';
  content: AgentResponse | string;
  /** Partial answer text while streaming */
  streamingText?: string;
  /** Current pipeline step label (shown before first token arrives) */
  statusText?: string;
}

// ── Sub-components ────────────────────────────────────────────────────

interface TraceSpan {
  traceId: string;
  requestId: string;
  agent: string;
  method: string;
  durationMs: number;
  timestamp: string;
  status: 'ok' | 'error';
  errorMessage?: string;
}

function TraceCollapse({ tracingId, durationMs }: { tracingId: string; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const [spans, setSpans] = useState<TraceSpan[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleOpen = async () => {
    const next = !open;
    setOpen(next);
    if (next && spans === null) {
      setLoading(true);
      try {
        const res = await fetch(`/api/trace/${tracingId}`);
        const data = await res.json() as { spans: TraceSpan[] };
        setSpans(data.spans ?? []);
      } catch {
        setSpans([]);
      } finally {
        setLoading(false);
      }
    }
  };

  const totalMs = spans?.reduce((sum, s) => sum + s.durationMs, 0) ?? durationMs;

  return (
    <div className="mt-2 border-t border-slate-700/50 pt-1.5">
      <button
        onClick={handleOpen}
        className="text-[11px] text-slate-500 hover:text-slate-300 flex items-center gap-1.5 transition-colors"
      >
        <span className="font-mono">{open ? '▾' : '▸'}</span>
        <span>Trace</span>
        <span className="font-mono text-slate-600">{tracingId.slice(0, 8)}…</span>
        {totalMs !== undefined && (
          <span className="ml-1 text-slate-600">{totalMs}ms total</span>
        )}
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-slate-700/60 bg-slate-950/80 overflow-hidden">
          {/* Request ID header */}
          <div className="px-3 py-2 border-b border-slate-700/50 flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Request ID</span>
            <span className="font-mono text-[11px] text-slate-400 select-all">{tracingId}</span>
          </div>

          {loading && (
            <div className="px-3 py-3 text-[11px] text-slate-500 font-mono">Loading spans…</div>
          )}

          {!loading && spans !== null && spans.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-slate-500 font-mono">No spans recorded for this request.</div>
          )}

          {!loading && spans !== null && spans.length > 0 && (
            <>
              {/* Column headers */}
              <div className="grid grid-cols-[1fr_56px] sm:grid-cols-[1fr_100px_72px_56px] gap-2 px-3 py-1.5 bg-slate-900/60 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                <span>Agent · Method</span>
                <span className="hidden sm:block">Timestamp</span>
                <span className="hidden sm:block text-right">Duration</span>
                <span className="text-right">Status</span>
              </div>

              {/* Span rows */}
              <div className="divide-y divide-slate-800/60">
                {spans.map((span) => {
                  const time = new Date(span.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  const barWidth = totalMs ? Math.max(4, Math.round((span.durationMs / totalMs) * 100)) : 0;
                  return (
                    <div key={span.traceId} className="px-3 py-2">
                      <div className="grid grid-cols-[1fr_56px] sm:grid-cols-[1fr_100px_72px_56px] gap-2 items-center">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-semibold text-slate-300 truncate">{span.agent}</span>
                            <span className="text-[10px] text-slate-600">·</span>
                            <span className="text-[10px] font-mono text-slate-500 truncate">{span.method}</span>
                          </div>
                          {/* Mini timeline bar */}
                          <div className="mt-1 h-1 rounded-full bg-slate-800 w-full overflow-hidden">
                            <div
                              className={`h-1 rounded-full ${span.status === 'error' ? 'bg-red-500' : 'bg-cyan-600'}`}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                        </div>
                        <span className="hidden sm:block font-mono text-[10px] text-slate-500">{time}</span>
                        <span className={`hidden sm:block font-mono text-[11px] text-right ${span.durationMs > 10000 ? 'text-amber-400' : 'text-slate-400'}`}>
                          {span.durationMs}ms
                        </span>
                        <span className={`text-[10px] font-semibold text-right ${span.status === 'error' ? 'text-red-400' : 'text-emerald-500'}`}>
                          {span.status === 'error' ? 'ERR' : 'OK'}
                        </span>
                      </div>
                      {span.errorMessage && (
                        <div className="mt-1 text-[10px] font-mono text-red-400 truncate">{span.errorMessage}</div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Summary footer */}
              <div className="px-3 py-2 border-t border-slate-800/60 flex items-center gap-3 text-[10px] text-slate-500">
                <span>{spans.length} span{spans.length !== 1 ? 's' : ''}</span>
                <span>·</span>
                <span>{spans.filter(s => s.status === 'error').length} error{spans.filter(s => s.status === 'error').length !== 1 ? 's' : ''}</span>
                <span>·</span>
                <span>{totalMs !== undefined ? `${totalMs}ms` : '—'} wall time</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Cycling status messages — each pipeline stage has a rotating set of phrases ──
// Resets when the parent statusText prop changes (new SSE status event received).
const STATUS_PHASES: Record<string, string[]> = {
  'Connecting…':                         ['Connecting to SourceIQ…', 'Opening pipeline…'],
  'Classifying query…':                  ['Classifying query…', 'Identifying analysis type…', 'Routing to specialist agent…', 'Reading supply chain signals…'],
  'Searching inventory…':                ['Searching inventory…', 'Running semantic vector search…', 'Matching SKUs to your query…', 'Scanning inventory database…'],
  'Checking tariff rates…':              ['Checking tariff rates…', 'Querying tariff database…', 'Comparing HS code rates…', 'Calculating landed costs…'],
  'Assessing geopolitical risk…':        ['Assessing geopolitical risk…', 'Scanning live news feeds…', 'Checking State Dept advisories…', 'Computing SRI scores…'],
  'Building sourcing recommendations…':  ['Building sourcing recommendations…', 'Running cost comparison…', 'Computing annual savings…', 'Ranking alternatives…'],
  'Generating response…':                ['Generating response…', 'Synthesizing intelligence…', 'Writing your sourcing brief…'],
  'Running parallel multi-agent analysis…': ['Running parallel multi-agent analysis…', 'Inventory + tariff + risk agents in parallel…', 'Correlating multi-source signals…', 'Building full picture…'],
  'Fetching live news alerts…':          ['Fetching live news alerts…', 'Scanning BBC, Reuters, Al Jazeera…', 'Processing conflict signals…'],
  'Querying market intelligence…':       ['Querying market intelligence…', 'Checking commodity prices…', 'Analysing FX rates…'],
  'Classifying with AI…':               ['Classifying with AI…', 'Running intent classifier…', 'Choosing the right agent…'],
};
const FALLBACK_PHASES = ['Processing your request…', 'Analysing supply chain data…', 'Consulting intelligence sources…', 'Running agent pipeline…', 'Almost there…'];

function CyclingStatus({ statusText }: { statusText: string }) {
  const phases = useMemo(
    () => STATUS_PHASES[statusText] ?? [statusText, ...FALLBACK_PHASES],
    [statusText],
  );
  const [idx, setIdx] = useState(0);

  // Reset index when the parent stage changes
  useEffect(() => { setIdx(0); }, [statusText]);

  // Cycle every 2.5s
  useEffect(() => {
    if (phases.length <= 1) return;
    const id = setInterval(() => setIdx(i => (i + 1) % phases.length), 2500);
    return () => clearInterval(id);
  }, [phases]);

  return (
    <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 py-0.5 min-w-[180px]">
      {/* Three bouncing dots */}
      <span className="flex gap-0.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
      {/* Fade-transition label */}
      <span key={idx} className="text-xs italic animate-fadeIn">
        {phases[idx]}
      </span>
    </div>
  );
}

/** Shimmer skeleton shown while waiting for first token */
function MessageSkeleton() {
  return (
    <div className="flex justify-start" role="status" aria-label="SourceIQ is analyzing your query">
      <div className="max-w-[85%] space-y-2.5 animate-pulse">
        <div className="bg-slate-200 dark:bg-slate-800 rounded-2xl px-4 py-3 border border-slate-300 dark:border-slate-700 space-y-2">
          <div className="h-3 bg-slate-300 dark:bg-slate-700 rounded-full w-3/4" />
          <div className="h-3 bg-slate-300 dark:bg-slate-700 rounded-full w-full" />
          <div className="h-3 bg-slate-300 dark:bg-slate-700 rounded-full w-5/6" />
          <div className="h-3 bg-slate-300 dark:bg-slate-700 rounded-full w-2/3" />
        </div>
      </div>
    </div>
  );
}

/** Render basic markdown: **bold**, bullet lists, numbered lists */
function FormattedText({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Bold: **text** → <strong>
    const formatted = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Bullet list
    if (/^\s*[-•]\s/.test(line)) {
      elements.push(
        <li key={i} className="ml-4 list-disc" dangerouslySetInnerHTML={{ __html: formatted.replace(/^\s*[-•]\s*/, '') }} />,
      );
    // Numbered list
    } else if (/^\s*\d+[.)]\s/.test(line)) {
      elements.push(
        <li key={i} className="ml-4 list-decimal" dangerouslySetInnerHTML={{ __html: formatted.replace(/^\s*\d+[.)]\s*/, '') }} />,
      );
    } else if (line.trim() === '') {
      elements.push(<br key={i} />);
    } else {
      elements.push(
        <span key={i}>
          <span dangerouslySetInnerHTML={{ __html: formatted }} />
          {i < lines.length - 1 && <br />}
        </span>,
      );
    }
  }

  return (
    <span>
      {elements}
      {streaming && <span className="inline-block w-1.5 h-4 bg-blue-400 animate-pulse ml-0.5 align-text-bottom rounded-sm" />}
    </span>
  );
}

const SAMPLE_PROMPTS = [
  'What are the top cost saving opportunities across my inventory?',
  'Which electronics do I source from China?',
  'What is current tariff rate for India?',
  'Is Vietnam safe to source from?',
];


function formatCompactCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function averageRisk(response: AgentResponse): number | null {
  if (!response.recommendations?.length) return null;
  const total = response.recommendations.reduce((sum, rec) => sum + rec.riskScore, 0);
  return Math.round(total / response.recommendations.length);
}

interface InventoryFallbackItem {
  sku: string;
  description: string;
  country: string | null;
  unitCost: string | null;
  volume: string | null;
}

function parseInventoryFallback(answer: string): { sourceCountry: string | null; items: InventoryFallbackItem[] } {
  const sourceCountry = answer.match(/items sourced from\s+([^:\n.]+)/i)?.[1]?.trim() ?? null;
  const items = answer
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+[.)]\s+/.test(line))
    .map((line) => {
      const normalized = line.replace(/^\d+[.)]\s+/, '');
      const [skuPart = '', descriptionPart = '', countryPart = '', costPart = '', volumePart = ''] = normalized.split('|').map((part) => part.trim());
      return {
        sku: skuPart,
        description: descriptionPart,
        country: countryPart || null,
        unitCost: costPart || null,
        volume: volumePart || null,
      };
    });

  // Derive source market from items if not found in text — show actual country when all items share one
  let derivedCountry = sourceCountry;
  if (!derivedCountry && items.length > 0) {
    const countries = new Set(items.map(i => i.country).filter(Boolean));
    if (countries.size === 1) {
      derivedCountry = [...countries][0] ?? null;
    }
  }

  return { sourceCountry: derivedCountry, items };
}

function detectResponseMode(response: AgentResponse): 'recommendation' | 'inventory' | 'risk' | 'general' {
  if (response.recommendations?.length) return 'recommendation';
  if (parseInventoryFallback(response.answer).items.length > 0) return 'inventory';
  if (response.riskAlerts?.length || /risk brief|sourcing risk|critical|elevated|high risk/i.test(response.answer)) return 'risk';
  return 'general';
}

function ResponseActions({ response }: { response: AgentResponse }) {
  const best = response.recommendations?.[0];
  const inventory = parseInventoryFallback(response.answer);
  const country = best?.recommendedCountry ?? best?.currentCountry ?? inventory.sourceCountry;

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {best?.recommendedCountry && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('sourceiq:whatif-country', { detail: best.recommendedCountry }))}
          className="sq-action-btn"
        >
          Simulate {best.recommendedCountry}
        </button>
      )}
      {country && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('sourceiq:analyze-country', { detail: `Analyze sourcing risk for ${country}` }))}
          className="sq-action-btn"
        >
          {best ? 'Deep risk analysis' : `Assess ${country}`}
        </button>
      )}
    </div>
  );
}

function ExecutiveResponseCard({ response, isStreamingMsg }: { response: AgentResponse; isStreamingMsg?: boolean }) {
  const mode = detectResponseMode(response);
  const inventory = parseInventoryFallback(response.answer);
  // Only use a synthetic headline when we have something meaningfully different from the answer text.
  // For general/risk/browse responses, skip the headline to avoid showing the same content twice.
  const headline = response.recommendations?.length
    ? `${response.recommendations.length} sourcing move${response.recommendations.length > 1 ? 's' : ''} identified across the current portfolio.`
    : mode === 'inventory' && inventory.items.length
      ? `${inventory.items.length} inventory item${inventory.items.length === 1 ? '' : 's'} matched${inventory.sourceCountry ? ` in ${inventory.sourceCountry}` : ''}.`
    : null;
  const recs = response.recommendations ?? [];
  // For single-SKU comparisons (all recs share the same SKU), show best single alternative
  // savings — not sum of all hypothetical moves. For multi-SKU, sum is correct (portfolio upside).
  const distinctSkus = new Set(recs.map(r => r.sku));
  const totalSavings = distinctSkus.size <= 1 && recs.length > 1
    ? Math.max(...recs.map(r => r.annualSavingsUSD))
    : recs.reduce((sum, rec) => sum + Math.max(0, rec.annualSavingsUSD), 0);
  const avgRisk = averageRisk(response);
  const topRecommendation = response.recommendations?.[0];
  const evidence = [
    topRecommendation ? `${topRecommendation.currentCountry} -> ${topRecommendation.recommendedCountry} on ${topRecommendation.sku}` : null,
    mode === 'inventory' && inventory.items.length ? `${inventory.items.length} inventory record${inventory.items.length === 1 ? '' : 's'} returned` : null,
    response.riskAlerts?.length ? `${response.riskAlerts.length} live risk alert${response.riskAlerts.length > 1 ? 's' : ''}` : null,
    response.toolsUsed?.length ? `${response.toolsUsed.length} MCP tool${response.toolsUsed.length > 1 ? 's' : ''} invoked` : null,
    mode === 'recommendation' ? '📐 Costs computed deterministically' : null,
    mode === 'risk' ? '🤖 AI-synthesized risk analysis' : null,
    mode === 'inventory' && !response.answer?.includes('AI summarization offline') ? '🤖 AI-synthesized summary' : null,
  ].filter(Boolean) as string[];

  const metrics = mode === 'recommendation'
    ? [
        {
          label: 'Savings Identified',
          value: formatCompactCurrency(totalSavings),
          valueClass: 'text-emerald-300',
          subtitle: distinctSkus.size <= 1 && recs.length > 1 ? 'Best alternative savings' : 'Annual portfolio upside',
        },
        {
          label: 'Average Risk',
          value: String(avgRisk ?? 'N/A'),
          valueClass: avgRisk !== null && avgRisk >= 70 ? 'text-red-300' : avgRisk !== null && avgRisk >= 40 ? 'text-amber-300' : 'text-emerald-300',
          subtitle: 'Decision risk score',
        },
      ]
    : mode === 'inventory'
      ? [
          {
            label: 'Items Found',
            value: String(inventory.items.length),
            valueClass: 'text-cyan-300',
            subtitle: 'Catalog rows matched',
          },
          {
            label: 'Source Market',
            value: inventory.sourceCountry ?? 'Mixed',
            valueClass: 'text-slate-100 text-[18px] leading-5',
            subtitle: 'Detected in inventory output',
          },
        ]
      : mode === 'risk'
        ? [
            {
              label: 'Active Alerts',
              value: String(response.riskAlerts?.length ?? 0),
              valueClass: (response.riskAlerts?.length ?? 0) > 0 ? 'text-red-300' : 'text-emerald-300',
              subtitle: 'Signals affecting this market',
            },
          ]
        : [];

  return (
    <div className="sq-panel px-4 py-4 text-slate-800 dark:text-slate-100">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="sq-label">Decision</span>
        <span className="sq-chip">{response.source === 'local' ? 'On-device inference' : 'Cloud inference'}</span>
      </div>

      <div className={metrics.length > 0 ? 'grid gap-3 grid-cols-[minmax(0,1.45fr)_minmax(180px,0.55fr)]' : 'block'}>
        <div className="sq-subcard">
          <div className="sq-label mb-2">Executive Summary</div>
          {headline && <h3 className="text-[15px] font-semibold leading-6 text-slate-900 dark:text-slate-50 mb-2 text-balance">{headline}</h3>}
          {mode === 'inventory' && inventory.items.length > 0 ? (
            <div className="space-y-3">
              <p className="text-sm leading-6 text-slate-700 dark:text-slate-300">
                {response.answer.includes('AI summarization offline')
                  ? 'The local model is offline, so SourceIQ is showing a deterministic inventory extract instead of a narrative summary.'
                  : response.answer.split('\n').filter(l => !/^\d+[.)]\s+/.test(l)).join(' ').trim() || 'SourceIQ matched inventory records for this request.'}
              </p>
              <div className="rounded-2xl border border-slate-200/60 dark:border-slate-700/60 overflow-hidden">
                <div className="grid grid-cols-[minmax(0,92px)_minmax(0,1fr)_90px] gap-3 bg-slate-100/80 dark:bg-slate-800/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500 dark:text-slate-400">
                  <span>SKU</span>
                  <span>Item</span>
                  <span className="text-right">Unit Cost</span>
                </div>
                <div className="divide-y divide-slate-200/50 dark:divide-slate-700/50">
                  {inventory.items.slice(0, 10).map((item) => (
                    <div key={`${item.sku}-${item.description}`} className="grid grid-cols-[minmax(0,92px)_minmax(0,1fr)_90px] gap-3 px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300">
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate">{item.sku}</span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-900 dark:text-slate-100">{item.description || 'Inventory match'}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{item.country ?? inventory.sourceCountry ?? 'Market not specified'}{item.volume ? ` • ${item.volume}` : ''}</div>
                      </div>
                      <span className="text-right text-[11px] font-semibold text-cyan-300">{item.unitCost ?? 'N/A'}</span>
                    </div>
                  ))}
                </div>
              </div>
              {inventory.items.length > 10 && (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Showing the first 10 matches. Ask a narrower question to isolate a product family or market.</p>
              )}
            </div>
          ) : (
            <div className="text-sm leading-6 text-slate-700 dark:text-slate-300">
              <FormattedText text={response.answer} streaming={isStreamingMsg} />
            </div>
          )}
          <ResponseActions response={response} />
        </div>

        {mode === 'risk' && (response.riskAlerts?.length ?? 0) > 0 ? (
          <div className="sq-subcard flex flex-col gap-2 min-w-[180px]">
            <div className="flex items-center justify-between gap-2">
              <span className="sq-metric-label">Active Alerts</span>
              <span className="text-xs font-bold text-red-300">{response.riskAlerts!.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {response.riskAlerts!.slice(0, 5).map((alert, i) => {
                const dotColor = alert.severity === 'critical' ? '#f87171' : alert.severity === 'high' ? '#fb923c' : '#94a3b8';
                return (
                  <div key={i} className="flex items-start gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1" style={{ background: dotColor }} />
                    <span className="text-[11px] text-slate-300 leading-snug">{alert.message}</span>
                  </div>
                );
              })}
              {response.riskAlerts!.length > 5 && (
                <span className="text-[10px] text-slate-500">+{response.riskAlerts!.length - 5} more signals</span>
              )}
            </div>
          </div>
        ) : metrics.length > 0 ? (
          <div className="grid gap-3 grid-cols-1">
            {metrics.map((metric) => (
              <div key={metric.label} className="sq-metric">
                <span className="sq-metric-label">{metric.label}</span>
                <span className={`sq-metric-value ${metric.valueClass}`}>{metric.value}</span>
                <span className="sq-metric-subtle">{metric.subtitle}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {evidence.length > 0 && (
        <div className="sq-subcard mt-3">
          <div className="sq-label mb-2">Evidence</div>
          <div className="flex flex-wrap gap-2">
            {evidence.map((item) => (
              <span key={item} className="sq-chip">{item}</span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 pt-2 border-t border-slate-200/50 dark:border-slate-700/40 flex items-center gap-1.5 flex-wrap">
        {response.answer?.includes('AI summarization offline') ? (
          <span className="sq-badge-fallback">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block" /> Fallback data
          </span>
        ) : response.answer?.startsWith('Error:') ? null
        : /^(i'?m sorry|i cannot|i can'?t|i am sorry|i can only|i'?m a supply chain|i'?m sourceiq)\b/i.test(response.answer ?? '') ? null
        : response.answer ? (
          <span className="sq-badge-ai">
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="3" opacity=".5"/><circle cx="4" cy="4" r="1.5"/></svg>
            AI analyzed
          </span>
        ) : null}
        {response.tracingAgent && <span className="sq-chip">{response.tracingAgent}</span>}
        {response.toolsUsed && response.toolsUsed.length > 0 && (
          <span className="sq-chip" aria-label="MCP tools used">⬡ {response.toolsUsed.length} MCP tool{response.toolsUsed.length > 1 ? 's' : ''}</span>
        )}
      </div>
      {response.tracingId && <TraceCollapse tracingId={response.tracingId} durationMs={response.tracingDurationMs} />}
    </div>
  );
}

/** Voice input button — uses Web Speech API */
function VoiceButton({ onTranscript, disabled }: { onTranscript: (text: string) => void; disabled: boolean }) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  // Detect support only on the client so server and first client render both return null,
  // preventing the hydration mismatch.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setSupported(!!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition));
  }, []);

  const toggle = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (e: any) => {
      const transcript = e.results[0]?.[0]?.transcript ?? '';
      if (transcript) onTranscript(transcript);
      setListening(false);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognition.start();
    setListening(true);
  }, [listening, onTranscript]);

  if (!supported) return null;

  return (
    <button
      onClick={toggle}
      disabled={disabled}
      aria-label={listening ? 'Stop voice input' : 'Start voice input'}
      title={listening ? 'Listening… click to stop' : 'Voice input'}
      className={`rounded-full p-2 text-sm transition-all ${
        listening
          ? 'bg-red-500 text-white animate-pulse ring-2 ring-red-400 ring-offset-1 ring-offset-white dark:ring-offset-slate-950'
          : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-40'
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
    </button>
  );
}

// ── Main Chat Component ───────────────────────────────────────────────

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Ref so the event listener always calls the latest send() without stale closure
  const sendRef = useRef<(q: string) => void>(() => {});

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Listen for map "Analyze" events — auto-submit immediately
  useEffect(() => {
    const handler = (e: CustomEvent<string>) => {
      if (e.detail) sendRef.current(e.detail);
    };
    window.addEventListener('sourceiq:analyze-country', handler as EventListener);
    return () => window.removeEventListener('sourceiq:analyze-country', handler as EventListener);
  }, []);

  // Keep ref in sync so the event listener always has the latest send()
  sendRef.current = (q: string) => { void send(q); };

  async function send(queryOverride?: string) {
    const query = (queryOverride ?? input).trim();
    if (!query || isLoading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: query }]);
    window.dispatchEvent(new CustomEvent('sourceiq:decision-brief-pending', { detail: { query } }));
    setIsLoading(true);
    setIsStreaming(true);

    // Add a placeholder assistant message — statusText shows dots immediately while SSE connects
    setMessages(prev => [...prev, { role: 'assistant', content: '' as unknown as AgentResponse, streamingText: '', statusText: 'Connecting…' }]);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? `Server error ${res.status}`);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let fullResponse: AgentResponse | null = null;

      if (reader) {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              const eventType = line.slice(7).trim();
              // Next line should be data:
              const dataLine = lines[lines.indexOf(line) + 1];
              if (dataLine?.startsWith('data: ')) {
                const data = dataLine.slice(6);
                if (eventType === 'status') {
                  const msg = JSON.parse(data) as string;
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') {
                      updated[updated.length - 1] = { ...last, statusText: msg };
                    }
                    return updated;
                  });
                } else if (eventType === 'token') {
                  const word = JSON.parse(data) as string;
                  accumulated += word;
                  // Update the streaming message in place; clear statusText once tokens arrive
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') {
                      updated[updated.length - 1] = { ...last, streamingText: accumulated, statusText: undefined };
                    }
                    return updated;
                  });
                } else if (eventType === 'metadata') {
                  fullResponse = JSON.parse(data) as AgentResponse;
                }
              }
            }
          }
        }
      }

      // Replace streaming placeholder with full response
      const finalResponse = fullResponse ?? { answer: accumulated || 'No response', source: 'local' as const };
      window.dispatchEvent(new CustomEvent('sourceiq:decision-brief', { detail: { query, response: finalResponse } }));
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: finalResponse };
        return updated;
      });
    } catch {
      const errorResponse = { answer: 'Error: could not reach server.', source: 'local' } as AgentResponse;
      window.dispatchEvent(new CustomEvent('sourceiq:decision-brief', { detail: { query, response: errorResponse } }));
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: errorResponse,
        };
        return updated;
      });
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 border-r border-slate-200 dark:border-slate-800 transition-colors" role="main">
      {/* Header — removed; LeftPane provides the chat header */}

      {/* Messages — role="log" announces new messages to screen readers */}
      <div
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        aria-busy={isLoading}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
      >
        {messages.length === 0 && (
          <div className="text-center text-slate-500 mt-8 text-sm" aria-label="Welcome message">
            <p className="text-2xl mb-2" aria-hidden="true">🌐</p>
            <p className="text-slate-600 dark:text-slate-300 font-medium">Ask about sourcing costs, tariffs, or geopolitical risk</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Try one of these sample prompts:</p>
            <div className="mt-4 text-left max-w-md mx-auto space-y-2 px-2">
              {SAMPLE_PROMPTS.map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => void send(prompt)}
                  className="w-full text-left text-xs px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-slate-700 hover:border-blue-400 dark:hover:border-blue-500 transition-colors cursor-pointer"
                >
                  <span className="text-blue-500 dark:text-blue-400 mr-1.5">→</span>
                  {prompt}
                </button>
              ))}
            </div>
            <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">💡 Try voice input — click the microphone button</p>
          </div>
        )}

        {messages.map((msg, i) => {
          const isUser = msg.role === 'user';
          const response = typeof msg.content === 'string' ? null : (msg.content as AgentResponse | null);
          const isStreamingMsg = !!msg.streamingText && !response?.answer;
          const text = isStreamingMsg
            ? msg.streamingText!
            : typeof msg.content === 'string'
              ? msg.content
              : (msg.content as AgentResponse).answer;

          const showStatus = !isUser && !!msg.statusText && !msg.streamingText && !response?.answer;

          return (
            <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div className={`${isUser ? 'max-w-[88%] order-2' : 'w-full max-w-full order-1'}`}>

                <div
                  className={`text-sm ${
                    isUser
                      ? 'sq-panel px-4 py-3 border-blue-700/40 dark:border-blue-600/30'
                      : response?.answer?.startsWith('Error:')
                        ? 'rounded-xl border border-red-800/50 bg-red-950/20 text-slate-300 dark:text-slate-300 px-4 py-2.5'
                        : 'p-0 bg-transparent'
                  }`}
                  aria-label={isUser ? 'Your message' : 'SourceIQ response'}
                >
                  {showStatus ? (
                    <CyclingStatus statusText={msg.statusText!} />
                  ) : isUser ? (
                    <>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="sq-label" style={{ color: 'var(--sq-accent)' }}>Query</span>
                        <span className="sq-chip">User</span>
                      </div>
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100 whitespace-pre-wrap leading-6">{text}</p>
                    </>
                  ) : isStreamingMsg ? (
                    <ExecutiveResponseCard
                      response={{ answer: msg.streamingText ?? '', source: 'local' } as AgentResponse}
                      isStreamingMsg={true}
                    />
                  ) : response ? (
                    <ExecutiveResponseCard response={response} isStreamingMsg={false} />
                  ) : (
                    <FormattedText text={text ?? ''} streaming={false} />
                  )}
                </div>
                {response?.chartData && (
                  <div className="mt-2">
                    <CostComparisonChart chartData={response.chartData} />
                  </div>
                )}
                {response?.recommendations && response.recommendations.length > 0 && (
                  <div className="mt-2">
                    <SKUTable recommendations={response.recommendations} />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {isLoading && !isStreaming && (
          <MessageSkeleton />
        )}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {/* Input */}
      <div className="px-4 py-3 bg-slate-50 dark:bg-slate-900/60 border-t border-slate-200 dark:border-slate-800 transition-colors">
        <div className="flex gap-2 items-center" role="search">
          <label htmlFor="chat-input" className="sr-only">Ask about sourcing, tariffs, or geopolitical risk</label>
          <VoiceButton onTranscript={(t) => { setInput(t); }} disabled={isLoading} />
          <input
            id="chat-input"
            className="flex-1 rounded-full border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 px-4 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            placeholder="Ask about sourcing, tariffs, or risk…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void send()}
            disabled={isLoading}
            aria-disabled={isLoading}
            autoComplete="off"
          />
          <button
            onClick={() => void send()}
            disabled={isLoading || !input.trim()}
            aria-disabled={isLoading || !input.trim()}
            aria-label="Send message"
            className="rounded-full bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-40 hover:bg-blue-500 transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
