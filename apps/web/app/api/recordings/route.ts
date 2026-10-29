import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { createRecording } from '@/lib/recordings';
import { ensureUser } from '@/lib/users';
import { canCreate, sessionUser } from '@/lib/authz';
import { clientKey, rateLimit } from '@/lib/ratelimit';
import { STORAGE_DIR } from '@/lib/config';
import { workerDir } from '@/lib/worker';

/**
 * POST /api/recordings — register a completed upload as a recording and start
 * analysis detached. Body: { name, videoPath } (path from upload complete).
 */
export async function POST(req: NextRequest) {
  const user = await sessionUser();
  const uid = user?.uid ?? null;
  if (!canCreate(uid)) {
    return NextResponse.json({ error: 'Sign in to create a recording.' }, { status: 401 });
  }
  // Owner row must exist before any record references it (see ensureUser).
  ensureUser(user);
  if (!rateLimit(`recordings:${clientKey(req, uid)}`, 10, 60_000)) {
    return NextResponse.json({ error: 'Too many recordings — slow down.' }, { status: 429 });
  }
  let body: { name?: unknown; videoPath?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name (string) required' }, { status: 400 });
  }
  if (typeof body.videoPath !== 'string' || !body.videoPath) {
    return NextResponse.json({ error: 'videoPath (string) required' }, { status: 400 });
  }
  let rec: { id: string };
  try {
    rec = createRecording(body.name.trim().slice(0, 200), body.videoPath, uid);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Cannot register recording' },
      { status: 400 },
    );
  }
  const child = spawn(
    'python3',
    ['-m', 'worker', 'analyze', body.videoPath, '--recording-id', rec.id],
    { cwd: workerDir(), detached: true, stdio: 'ignore', env: { ...process.env, STORAGE_DIR } },
  );
  child.unref();
  return NextResponse.json({ recordingId: rec.id, status: 'analyzing' }, { status: 202 });
}
