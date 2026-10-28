import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from '@/lib/config';
import { completeSession, getSession } from '@/lib/uploads';
import { canWrite, sessionUser } from '@/lib/authz';
import { workerDir } from '@/lib/worker';

/**
 * POST /api/uploads/:id/complete — validate + finalize.
 * Requires every chunk; verifies total size; probes the video with the real
 * worker logic (rejects invalid media); moves the file out of temp storage.
 * Streams for hashing — the assembled video is never loaded into memory.
 * A failed upload never enters the pipeline (no scene/job is created here).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
  const user = await sessionUser();
  if (!canWrite(s, user?.uid ?? null)) {
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to complete this upload.' }, { status: user ? 403 : 401 });
  }
  if (s.status !== 'active') {
    return NextResponse.json({ error: `Upload is ${s.status}, not active` }, { status: 409 });
  }
  const missing = s.received
    .map((ok, i) => (ok ? -1 : i))
    .filter((i) => i >= 0);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Incomplete upload: ${missing.length} chunk(s) missing`, missing },
      { status: 409 },
    );
  }
  if (!existsSync(s.tmpPath) || statSync(s.tmpPath).size !== s.size) {
    return NextResponse.json({ error: 'Assembled file size mismatch — re-upload missing chunks' }, { status: 422 });
  }
  // Integrity hash (streamed) + real media validation.
  const sha256 = await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    const rs = createReadStream(s.tmpPath);
    rs.on('data', (c) => h.update(c as Buffer));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
  try {
    execFileSync(
      'python3',
      ['-m', 'worker', 'probe', s.tmpPath, '--ext', s.filename.toLowerCase().endsWith('.mov') ? '.mov' : '.mp4'],
      {
        cwd: workerDir(),
        stdio: 'pipe',
        env: { ...process.env, STORAGE_DIR },
      },
    );
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString().slice(0, 300) ?? 'probe failed';
    return NextResponse.json({ error: `Uploaded file rejected: ${stderr}` }, { status: 422 });
  }
  const ext = s.filename.toLowerCase().endsWith('.mov') ? '.mov' : '.mp4';
  const destDir = join(STORAGE_DIR, 'uploads', `upload_${s.id}`);
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, `original${ext}`);
  renameSync(s.tmpPath, dest);
  const done = completeSession(id, dest);
  return NextResponse.json({
    uploadId: id,
    status: done.status,
    path: dest,
    size: s.size,
    sha256,
  });
}
