// app/api/query/route.ts — POST /api/query → orchestrator → AgentResponse
// Supports two modes:
//   1. Accept: text/event-stream → SSE streaming (token-by-token answer)
//   2. Default → JSON (backward-compatible)
// RULE 1: only imports from startup.ts — never directly from agents or adapters.
import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, orchestrator } from '../../../src/lib/startup';
import { getLastTrace, setActiveRequestId } from '../../../src/lib/tracingClient';

export async function POST(req: NextRequest): Promise<NextResponse | Response> {
  try {
    await initializeApp();
    const body = await req.json() as { query?: string };
    const query = body.query?.trim();
    if (!query) return NextResponse.json({ error: 'Missing query' }, { status: 400 });

    // Generate a request-scoped ID so all agent spans in this query are grouped together
    const requestId = crypto.randomUUID();
    setActiveRequestId(requestId);

    const wantsStream = req.headers.get('accept')?.includes('text/event-stream');

    // ── Streaming mode: open stream immediately, emit status events during processing ──
    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (event: string, data: unknown) =>
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

          try {
            // Pass a live status emitter so orchestrator nodes report progress in real-time
            const response = await orchestrator.route(query, (msg) => emit('status', msg));

            // Attach request-scoped trace ID — used by /api/trace/[id] to fetch all spans
            const trace = getLastTrace();
            response.tracingId = requestId;
            response.tracingAgent = trace?.agent;
            response.tracingDurationMs = trace?.durationMs;

            // Signal transition from status to content
            emit('status', 'Streaming response…');

            // Stream answer word-by-word for typewriter effect
            const words = response.answer.split(/(\s+)/);
            for (const word of words) {
              emit('token', word);
              await new Promise(r => setTimeout(r, 18));
            }

            // Send full metadata (recommendations, charts, alerts, tracing)
            emit('metadata', response);
            emit('done', {});
          } catch (err) {
            emit('error', { error: String(err) });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // ── JSON mode (backward-compatible) ───────────────────────────────────
    const response = await orchestrator.route(query);
    const trace = getLastTrace();
    response.tracingId = requestId;
    response.tracingAgent = trace?.agent;
    response.tracingDurationMs = trace?.durationMs;
    return NextResponse.json(response);
  } catch (err) {
    console.error('[/api/query]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
