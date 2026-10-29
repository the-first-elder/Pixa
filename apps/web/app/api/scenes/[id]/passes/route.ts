import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORAGE_DIR } from '@/lib/config';
import { getScene, updateScene } from '@/lib/store';
import { canWrite, sessionUser } from '@/lib/authz';
import { workerDir } from '@/lib/worker';

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 500 * 1024 * 1024);
const MAX_PASSES = 10;

/**
 * POST /api/scenes/:sceneId/passes — join guided-capture passes into ONE video.
 * Body: multipart fields pass-0..pass-9 in order (each .mp4/.mov). The worker
 * concatenates them (stream copy when codecs match, one re-encode otherwise)
 * and the result becomes the scene's source video, as if one longer capture.
 * Same size cap as single uploads; failures name the offending pass.
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
    // Ops log: auth denials are otherwise invisible (no request logging in
    // prod). No identities logged — just which side of the gate failed.
    console.warn(
      `[passes] denied scene=${id} reason=${user ? (scene.ownerId ? 'not-owner' : 'no-owner-record') : 'anonymous'}`,
    );
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to upload to this scene.' }, { status: user ? 403 : 401 });
  }

  const form = await req.formData();
  const files: File[] = [];
  for (let i = 0; i < MAX_PASSES; i++) {
    const f = form.get(`pass-${i}`);
    if (f instanceof File) files.push(f);
    else break; // dense prefix: pass-0..pass-(n-1), nothing after a gap
  }
  if (files.length < 2) {
    return NextResponse.json({ error: 'Join needs at least 2 passes (fields pass-0, pass-1, …).' }, { status: 400 });
  }
  const total = files.reduce((a, f) => a + f.size, 0);
  if (total > MAX_BYTES) {
    return NextResponse.json({ error: `Passes total ${total} bytes (limit ${MAX_BYTES}). Record shorter passes.` }, { status: 413 });
  }
  const exts: string[] = [];
  for (const [i, f] of files.entries()) {
    const n = f.name.toLowerCase();
    const ext = n.endsWith('.mov') ? '.mov' : n.endsWith('.webm') ? '.webm'
      : n.endsWith('.mp4') ? '.mp4' : null;
    if (!ext) {
      return NextResponse.json({ error: `Pass ${i + 1} unsupported format: ${f.name}. Accepts .mp4/.mov/.webm` }, { status: 415 });
    }
    exts.push(ext);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'pixa-passes'));
  try {
    const inputs = await Promise.all(files.map(async (f, i) => {
      const p = join(tmp, `pass-${i}${exts[i]}`);
      writeFileSync(p, Buffer.from(await f.arrayBuffer()));
      return p;
    }));
    const sceneDir = join(STORAGE_DIR, 'uploads', scene.id);
    mkdirSync(sceneDir, { recursive: true });
    const dest = join(sceneDir, 'original.mp4');
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
      sourceVideo: { storagePath: dest, originalName: `${files.length} passes joined`, sizeBytes: total },
    });
    return NextResponse.json({
      sceneId: updated.id,
      passes: meta.passes ?? files.length,
      reencoded: meta.reencoded ?? false,
      probe: { duration: meta.duration ?? null, qualityWarning: meta.qualityWarning ?? null },
    });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().slice(0, 300)
      ?? (e instanceof Error ? e.message : 'join failed');
    return NextResponse.json({ error: `Pass join failed: ${stderr}` }, { status: 422 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
