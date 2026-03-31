// src/lib/tracingClient.ts — wraps any IFoundryClient to add tracing (UUID + timing)
// Usage: const foundry = withTracing(createFoundryLocalClient(), 'orchestrator');
// Logs: [TRACE] <id> | <agent> | <method> | <durationMs>ms

import type { IFoundryClient } from '../adapters/interfaces';

export interface TraceRecord {
  traceId: string;       // span-level ID (unique per LLM call)
  requestId: string;     // request-level ID (groups all spans for one user query)
  agent: string;
  method: string;
  durationMs: number;
  timestamp: string;
  status: 'ok' | 'error';
  errorMessage?: string;
}

// ── Global trace store (process-singleton via globalThis) ─────────────────────
// Capped at 500 records. Survives Next.js dev-mode route bundle re-evaluation.
declare global {
  // eslint-disable-next-line no-var
  var __sourceIQTraces: TraceRecord[];
}
if (!globalThis.__sourceIQTraces) globalThis.__sourceIQTraces = [];
const traceStore = globalThis.__sourceIQTraces;

/** Return all spans for a given requestId */
export function getTracesByRequestId(requestId: string): TraceRecord[] {
  return traceStore.filter(r => r.requestId === requestId);
}

/** Return the most recently completed span */
export function getLastTrace(): TraceRecord | undefined {
  return traceStore[traceStore.length - 1];
}

export function clearTraces(): void { traceStore.length = 0; }

/** Record an arbitrary span — used for non-LLM steps (graph nodes, keyword routing). */
export function recordSpan(
  agent: string,
  method: string,
  durationMs: number,
  status: 'ok' | 'error' = 'ok',
  errorMessage?: string,
): void {
  const record: TraceRecord = {
    traceId: crypto.randomUUID(),
    requestId: globalThis.__sourceIQActiveRequestId || 'unscoped',
    agent,
    method,
    durationMs,
    timestamp: new Date().toISOString(),
    status,
    errorMessage,
  };
  traceStore.push(record);
  if (traceStore.length > 500) traceStore.shift();
  console.log(`[TRACE] ${record.traceId} | ${record.requestId.slice(0, 8)} | ${agent} | ${method} | ${durationMs}ms`);
}

// ── Current active requestId ──────────────────────────────────────────────────
// Stored in globalThis so it survives Next.js module re-evaluation between requests.
declare global {
  // eslint-disable-next-line no-var
  var __sourceIQActiveRequestId: string;
}
if (!globalThis.__sourceIQActiveRequestId) globalThis.__sourceIQActiveRequestId = '';
export function setActiveRequestId(id: string): void { globalThis.__sourceIQActiveRequestId = id; }
export function getActiveRequestId(): string { return globalThis.__sourceIQActiveRequestId; }

export function withTracing(
  client: IFoundryClient,
  agentName: string,
): IFoundryClient & { lastTracingId: () => string | undefined } {
  let lastId: string | undefined;

  async function traced<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const traceId = crypto.randomUUID();
    const requestId = globalThis.__sourceIQActiveRequestId || 'unscoped';
    lastId = traceId;
    const start = Date.now();
    let status: 'ok' | 'error' = 'ok';
    let errorMessage: string | undefined;
    try {
      return await fn();
    } catch (err) {
      status = 'error';
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const durationMs = Date.now() - start;
      const record: TraceRecord = {
        traceId, requestId, agent: agentName, method,
        durationMs, timestamp: new Date().toISOString(),
        status, errorMessage,
      };
      traceStore.push(record);
      if (traceStore.length > 500) traceStore.shift();
      console.log(`[TRACE] ${traceId} | ${requestId.slice(0, 8)} | ${agentName} | ${method} | ${durationMs}ms${status === 'error' ? ' ERROR' : ''}`);
    }
  }

  return {
    generateEmbedding: (text) => traced('generateEmbedding', () => client.generateEmbedding(text)),
    chat: (messages, systemPrompt, maxTokens) => traced('chat', () => client.chat(messages, systemPrompt, maxTokens)),
    classifyText: (text, labels) => traced('classifyText', () => client.classifyText(text, labels)),
    lastTracingId: () => lastId,
  };
}
