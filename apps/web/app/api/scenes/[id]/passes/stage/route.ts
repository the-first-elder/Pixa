import { NextResponse } from 'next/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from '@/lib/config';
import { getScene } from '@/lib/store';
import { canWrite, sessionUser } from '@/lib/authz';

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 500 * 1024 * 1024);

/**
 * POST /api/scenes/:sceneId/passes/stage — stage ONE capture pass.
 * Multipart: { pass: File, index: string }. Each pass lands on its own, so
 * a dropped connection retries one pass, never the whole set (phones on
 * flaky uplinks). Re-staging the same index overwrites (idempotent retry).
 * Join happens in POST /passes/finalize.
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
    console.warn(`[passes] stage denied scene=${id} reason=${user ? 'not-owner' : 'anonymous'}`);
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to upload to this scene.' }, { status: user ? 403 : 401 });
  }
  const form = await req.formData();
  const file = form.get('pass');
  const indexRaw = form.get('index');
  const index = typeof indexRaw === 'string' ? Number.parseInt(indexRaw, 10) : NaN;
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing pass file (field "pass")' }, { status: 400 });
  }
  if (!Number.isInteger(index) || index < 0 || index > 9) {
    return NextResponse.json({ error: 'Pass index must be an integer 0..9' }, { status: 400 });
  }
  const n = file.name.toLowerCase();
  const ext = n.endsWith('.mov') ? '.mov' : n.endsWith('.webm') ? '.webm'
    : n.endsWith('.mp4') ? '.mp4' : null;
  if (!ext) {
    return NextResponse.json({ error: `Unsupported format: ${file.name}. Accepts .mp4/.mov/.webm` }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `Pass too large: ${file.size} bytes (limit ${MAX_BYTES}). Record shorter passes.` }, { status: 413 });
  }
  const dir = join(STORAGE_DIR, 'uploads', scene.id, 'passes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pass-${index}${ext}`), Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ index, size: file.size, staged: true });
}
