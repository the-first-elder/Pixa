import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from '@/lib/config';
import { getScene, updateScene } from '@/lib/store';
import { getSession } from '@/lib/uploads';
import { canWrite, sessionUser } from '@/lib/authz';

/**
 * POST /api/scenes/:sceneId/attach — make a completed chunked upload the
 * scene's source video. Body: { uploadId }. The upload was already probed
 * at /complete; this only re-points the scene at it (no bytes move through
 * this request). Lets camera uploads use the resumable chunked path
 * instead of one fragile multipart shot.
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
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to attach a video.' }, { status: user ? 403 : 401 });
  }
  let uploadId = '';
  try {
    const body = (await req.json()) as { uploadId?: unknown };
    if (typeof body?.uploadId === 'string') uploadId = body.uploadId;
  } catch { /* stays empty */ }
  if (!uploadId) return NextResponse.json({ error: 'Missing uploadId' }, { status: 400 });
  const s = getSession(uploadId);
  if (!s) return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
  if (s.ownerId != null && user && s.ownerId !== user.uid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (s.status !== 'complete' || !s.finalPath) {
    return NextResponse.json({ error: `Upload is ${s.status}, not complete` }, { status: 409 });
  }
  // The completed file must live under this store's uploads (never trust a
  // client-supplied path — the session record is the only source).
  const uploadsRoot = join(STORAGE_DIR, 'uploads');
  if (!s.finalPath.startsWith(uploadsRoot) || !existsSync(s.finalPath)) {
    return NextResponse.json({ error: 'Uploaded file missing on server' }, { status: 409 });
  }
  const updated = updateScene(scene.id, {
    sourceVideo: {
      storagePath: s.finalPath,
      originalName: s.filename,
      sizeBytes: s.size,
    },
  });
  return NextResponse.json({ sceneId: updated.id, sourceVideo: updated.sourceVideo });
}
