import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from '@/lib/config';
import { getScene, updateScene } from '@/lib/store';
import { canWrite, sessionUser } from '@/lib/authz';
import { workerDir } from '@/lib/worker';

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 500 * 1024 * 1024);

/**
 * POST /api/scenes/:sceneId/upload — accept the source video.
 * Validates format/size, then reuses the worker's real `probe` logic for
 * codec/duration checks. Original preserved under STORAGE_DIR/uploads.
 * (Production path for large files: signed direct-to-storage URL — Stage 8.)
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
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to upload to this scene.' }, { status: user ? 403 : 401 });
  }

  const form = await req.formData();
  const file = form.get('video');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing video file (field "video")' }, { status: 400 });
  }
  const ext = file.name.toLowerCase().endsWith('.mov') ? '.mov'
    : file.name.toLowerCase().endsWith('.mp4') ? '.mp4' : null;
  if (!ext) {
    return NextResponse.json(
      { error: `Unsupported format: ${file.name}. MVP accepts .mp4/.mov.` },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File too large: ${file.size} bytes (limit ${MAX_BYTES}).` },
      { status: 413 },
    );
  }

  const sceneDir = join(STORAGE_DIR, 'uploads', scene.id);
  mkdirSync(sceneDir, { recursive: true });
  const dest = join(sceneDir, `original${ext}`);
  writeFileSync(dest, Buffer.from(await file.arrayBuffer()));

  // Real validation via the worker (ffprobe codec/duration/overlap estimates).
  try {
    execFileSync('python3', ['-m', 'worker', 'probe', dest], {
      cwd: workerDir(),
      stdio: 'pipe',
      env: { ...process.env, STORAGE_DIR },
    });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().slice(0, 300)
      ?? 'probe failed';
    return NextResponse.json(
      { error: `Video rejected by probe: ${stderr}` },
      { status: 422 },
    );
  }

  const updated = updateScene(scene.id, {
    sourceVideo: { storagePath: dest, originalName: file.name, sizeBytes: file.size },
  });
  return NextResponse.json({ sceneId: updated.id, sourceVideo: updated.sourceVideo });
}
