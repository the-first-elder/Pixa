import { NextRequest, NextResponse } from 'next/server';
import { getScene, getScale } from '@/lib/store';
import { canRead, canWrite, sessionUser } from '@/lib/authz';
import { calibrateSceneScale } from '@/lib/scale';

/** GET /api/scenes/:sceneId/scale — current calibration (null = uncalibrated). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  const user = await sessionUser();
  if (!scene || !canRead(scene, user?.uid ?? null)) {
    return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  }
  return NextResponse.json({ scale: getScale(id) });
}

/**
 * POST /api/scenes/:sceneId/scale — calibrate from a known reference.
 * Body: { "referenceLabel": "door", "dimension": "height"|"width", "knownMeters": 2.1 }
 * The ONLY path from reconstruction units to meters.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  if (!scene) return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  const user = await sessionUser();
  if (!canWrite(scene, user?.uid ?? null)) {
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to calibrate this scene.' }, { status: user ? 403 : 401 });
  }
  let body: { referenceLabel?: unknown; dimension?: unknown; knownMeters?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.referenceLabel !== 'string' || !body.referenceLabel.trim()) {
    return NextResponse.json({ error: 'referenceLabel (string) required' }, { status: 400 });
  }
  if (body.dimension !== 'height' && body.dimension !== 'width') {
    return NextResponse.json({ error: 'dimension must be "height" or "width"' }, { status: 400 });
  }
  if (typeof body.knownMeters !== 'number' || !(body.knownMeters > 0) || body.knownMeters > 100) {
    return NextResponse.json({ error: 'knownMeters must be a positive real-world size' }, { status: 400 });
  }
  try {
    const scale = calibrateSceneScale(id, body.referenceLabel.trim(), body.dimension, body.knownMeters);
    return NextResponse.json({ scale });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 300) : 'Calibration failed' },
      { status: 422 },
    );
  }
}
