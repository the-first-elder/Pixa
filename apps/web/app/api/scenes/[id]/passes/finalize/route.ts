import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from '@/lib/config';
import { getScene, updateScene } from '@/lib/store';
import { canWrite, sessionUser } from '@/lib/authz';
import { workerDir } from '@/lib/worker';

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 500 * 1024 * 1024);

/**
 * POST /api/scenes/:sceneId/passes/finalize — join staged passes into one video.
 * Body: { count: number }. Requires pass-0..pass-(count-1) staged (see
 * /passes/stage); a missing pass is a 409 naming it, so the client re-stages
 * only that one. On success the joined file becomes the scene's source video
 * and the staged parts are removed.
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
    console.warn(`[passes] finalize denied scene=${id} reason=${user ? 'not-owner' : 'anonymous'}`);
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to upload to this scene.' }, { status: user ? 403 : 401 });
  }
  let count = 0;
  try {
    const body = (await req.json()) as { count?: unknown };
    if (typeof body?.count === 'number') count = Math.round(body.count);
  } catch {
    /* count stays 0 */
  }
  if (!Number.isInteger(count) || count < 2 || count > 10) {
    return NextResponse.json({ error: 'Join needs 2..10 staged passes ({ count }).' }, { status: 400 });
  }
  const dir = join(STORAGE_DIR, 'uploads', scene.id, 'passes');
  const staged = existsSync(dir) ? readdirSync(dir) : [];
  const inputs: string[] = [];
  for (let i = 0; i < count; i++) {
    const found = staged.find((f) => f.startsWith(`pass-${i}.`));
    if (!found) {
      return NextResponse.json({ error: `Pass ${i + 1} is not staged yet — upload it, then finalize.` }, { status: 409 });
    }
    inputs.push(join(dir, found));
  }
  const total = inputs.reduce((a, p) => a + statSync(p).size, 0);
  if (total > MAX_BYTES) {
    return NextResponse.json({ error: `Passes total ${total} bytes (limit ${MAX_BYTES}). Record shorter passes.` }, { status: 413 });
  }
  const sceneDir = join(STORAGE_DIR, 'uploads', scene.id);
  mkdirSync(sceneDir, { recursive: true });
  const dest = join(sceneDir, 'original.mp4');
  try {
    const out = execFileSync('python3', ['-m', 'worker', 'join', ...inputs, '--out', dest], {
      cwd: workerDir(),
      stdio: 'pipe',
      env: { ...process.env, STORAGE_DIR },
    });
    let meta: { duration?: number; passes?: number; reencoded?: boolean; qualityWarning?: string | null };
    try {
      meta = JSON.parse(out.toString());
    } catch {
      throw new Error('Join produced unreadable output');
    }
    const updated = updateScene(scene.id, {
      sourceVideo: { storagePath: dest, originalName: `${count} passes joined`, sizeBytes: total },
    });
    rmSync(dir, { recursive: true, force: true });
    return NextResponse.json({
      sceneId: updated.id,
      passes: meta.passes ?? count,
      reencoded: meta.reencoded ?? false,
      probe: { duration: meta.duration ?? null, qualityWarning: meta.qualityWarning ?? null },
    });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().slice(0, 300)
      ?? (e instanceof Error ? e.message : 'join failed');
    return NextResponse.json({ error: `Pass join failed: ${stderr}` }, { status: 422 });
  }
}
