// app/api/trace/[id]/route.ts — GET /api/trace/:requestId
// Returns all TraceRecord spans for a given request ID.
// Used by the TracePanel component to show the full call tree.

import { NextRequest, NextResponse } from 'next/server';
import { getTracesByRequestId } from '../../../../src/lib/tracingClient';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const { id } = params;
  if (!id) return NextResponse.json({ error: 'Missing trace ID' }, { status: 400 });

  const spans = getTracesByRequestId(id);
  return NextResponse.json({ requestId: id, spans });
}
