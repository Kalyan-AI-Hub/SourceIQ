// app/api/risk-stream/route.ts — GET /api/risk-stream
// Server-Sent Events endpoint. Sends a full snapshot on connect, then
// pushes a fresh snapshot every time the RiskPoller updates any country.
// Clients reconnect automatically if the connection drops (SSE spec).

import { initializeApp, riskStore } from '../../../src/lib/startup';
import { riskEmitter } from '../../../src/lib/riskEvents';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  await initializeApp();

  const encoder = new TextEncoder();

  // Per-connection state captured in closure
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let updateListener: (() => void) | null = null;
  let convergenceListener: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Controller closed — cleanup handled by cancel()
        }
      };

      // 1. Full snapshot immediately on connect
      riskStore.getHeatmapData().then(data => send('snapshot', data));

      // 2a. Push fresh snapshot on every SRI update
      updateListener = () => {
        riskStore.getHeatmapData().then(data => send('update', data));
      };
      riskEmitter.on('update', updateListener);

      // 2b. Push convergence cards when they change
      convergenceListener = () => {
        riskStore.getConvergenceCards().then(cards => send('convergence', cards));
      };
      riskEmitter.on('convergence', convergenceListener);

      // 2c. Send initial convergence snapshot on connect
      riskStore.getConvergenceCards().then(cards => {
        if (cards.length > 0) send('convergence', cards);
      });

      // 3. Heartbeat every 25 s to survive proxy idle timeouts
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      }, 25_000);
    },

    cancel() {
      if (heartbeatTimer)       clearInterval(heartbeatTimer);
      if (updateListener)       riskEmitter.off('update',      updateListener);
      if (convergenceListener)  riskEmitter.off('convergence', convergenceListener);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering if behind proxy
    },
  });
}
