import { NextResponse } from 'next/server';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from '@/lib/config';
import { getScene } from '@/lib/store';
import { getSession } from '@/lib/uploads';
import { canWrite, sessionUser } from '@/lib/authz';

/**
 * POST /api/scenes/:sceneId/passes/stage-upload — stage a completed chunked
 * upload as pass N. Body: { uploadId, index }. The bytes already arrived
 * (resumably, via /api/uploads); this copies the session's file into the
 * scene's passes dir. Re-staging an index overwrites (idempotent retry).
 * Join happens in /passes/finalize.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  if (!scene) return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  const user = await sessionUser();
  if (!canWrite(scene, user?.uid ?? null)) {
    console.warn(`[passes] stage-upload denied scene=${id} reason=${user ? 'not-owner' : 'anonymous'}`);
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to upload to this scene.' }, { status: user ? 403 : 401 });
  }
  let uploadId = '';
  let index = NaN;
  try {
    const body = (await req.json()) as { uploadId?: unknown; index?: unknown };
    if (typeof body?.uploadId === 'string') uploadId = body.uploadId;
    if (typeof body?.index === 'number') index = body.index;
  } catch { /* stays invalid */ }
  if (!uploadId) return NextResponse.json({ error: 'Missing uploadId' }, { status: 400 });
  if (!Number.isInteger(index) || index < 0 || index > 9) {
    return NextResponse.json({ error: 'Pass index must be an integer 0..9' }, { status: 400 });
  }
  const s = getSession(uploadId);
  if (!s) return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
  if (s.ownerId != null && user && s.ownerId !== user.uid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (s.status !== 'complete' || !s.finalPath) {
    return NextResponse.json({ error: `Upload is ${s.status}, not complete` }, { status: 409 });
  }
  const n = s.filename.toLowerCase();
  const ext = n.endsWith('.mov') ? '.mov' : n.endsWith('.webm') ? '.webm' : '.mp4';
  const dir = join(STORAGE_DIR, 'uploads', scene.id, 'passes');
  mkdirSync(dir, { recursive: true });
  copyFileSync(s.finalPath, join(dir, `pass-${index}${ext}`));
  return NextResponse.json({ index, size: s.size, staged: true });
}
