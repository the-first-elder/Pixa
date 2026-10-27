import { NextRequest, NextResponse } from 'next/server';
import { confirmAction } from '@/lib/store';

/**
 * POST /api/scenes/:sceneId/actions — renderer reports actual execution.
 * Body: { "actionId": "...", "executed": true|false, "status"?, "executionResult"? }
 * This is what distinguishes what the AI requested from what really happened.
 */
export async function POST(req: NextRequest) {
  let body: {
    actionId?: unknown;
    executed?: unknown;
    status?: unknown;
    executionResult?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.actionId !== 'string' || typeof body.executed !== 'boolean') {
    return NextResponse.json(
      { error: 'Required: actionId (string), executed (boolean)' },
      { status: 400 },
    );
  }
  const updated = confirmAction(body.actionId, {
    executed: body.executed,
    status: typeof body.status === 'string' ? body.status : body.executed ? 'success' : 'execution_failed',
    executionResult:
      body.executionResult !== undefined && body.executionResult !== null &&
      typeof body.executionResult === 'object'
        ? (body.executionResult as Record<string, unknown>)
        : {},
  });
  if (!updated) return NextResponse.json({ error: 'Action not found' }, { status: 404 });
  return NextResponse.json({ actionId: updated.id, executed: updated.executed, status: updated.status });
}
