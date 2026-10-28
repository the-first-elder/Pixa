import { NextRequest, NextResponse } from 'next/server';
import { getScene } from '@/lib/store';
import { authEnabled, canRead, sessionUser } from '@/lib/authz';
import { runQuery } from '@/lib/assistant';

/**
 * POST /api/scenes/:sceneId/query — natural-language request → validated
 * scene actions + grounded answer (PRD §§ 23.6, 24).
 * Body: { "message": "Show me all the chairs.", "sessionId"? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  const user = await sessionUser();
  if (!scene || !canRead(scene, user?.uid ?? null)) {
    return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  }
  // AI queries cost API money per call: require a session when auth is on,
  // even for public scenes. Viewer navigation stays free and anonymous.
  if (authEnabled() && !user) {
    return NextResponse.json({ error: 'Sign in to ask questions about this scene.' }, { status: 401 });
  }

  let message = '';
  let sessionId: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.message === 'string') message = body.message;
    if (typeof body?.sessionId === 'string') sessionId = body.sessionId;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!message.trim()) {
    return NextResponse.json({ error: 'Empty message' }, { status: 400 });
  }
  if (message.length > 2000) {
    return NextResponse.json({ error: 'Message too long (max 2000 chars)' }, { status: 413 });
  }

  try {
    const outcome = await runQuery(id, message.trim(), sessionId);
    return NextResponse.json({
      response: outcome.response,
      actions: outcome.actions.map((a) => ({
        actionId: a.actionId,
        type: a.action,
        status: a.status,
        ...(a.targetId ? { targetId: a.targetId } : {}),
        ...(a.entityIds ? { entityIds: a.entityIds } : {}),
        ...(a.positions ? { positions: a.positions } : {}),
        ...(a.stops ? { stops: a.stops } : {}),
        ...(a.result ? { result: a.result } : {}),
        ...(a.camera ? { camera: a.camera } : {}),
        ...(a.evidence ? { evidence: a.evidence } : {}),
        ...(a.message ? { message: a.message } : {}),
      })),
      sessionId: outcome.sessionId,
    });
  } catch (e) {
    // Model failure must not take the scene viewer down (PRD §27.3):
    // direct scene controls keep working; the error is explicit.
    const detail = e instanceof Error ? e.message.slice(0, 300) : 'unknown';
    return NextResponse.json(
      {
        response: 'AI interpretation is unavailable right now. You can still navigate the scene manually.',
        actions: [],
        error: `assistant_unavailable: ${detail}`,
      },
      { status: 502 },
    );
  }
}
