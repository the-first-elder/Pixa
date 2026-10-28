import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { getRecording } from '@/lib/recordings';
import { canWrite, sessionUser } from '@/lib/authz';
import { STORAGE_DIR } from '@/lib/config';
import { workerDir } from '@/lib/worker';

/**
 * POST /api/recordings/:id/split — user-correct a boundary.
 * Body: { segment, at } → runs worker split-segment, returns updated manifest.
 * POST /api/recordings/:id/merge — Body: { segA, segB }.
 */
function runWorker(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('python3', ['-m', 'worker', ...args], {
      cwd: workerDir(),
      stdio: 'pipe',
      env: { ...process.env, STORAGE_DIR },
      timeout: 60000,
    }).toString();
    return { ok: true, out };
  } catch (e) {
    const detail = (e as { stderr?: Buffer }).stderr?.toString().slice(0, 300) ?? 'worker failed';
    return { ok: false, out: detail };
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; op: string }> },
) {
  const { id, op } = await params;
  const rec = getRecording(id);
  if (!rec) return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  const user = await sessionUser();
  if (!canWrite(rec, user?.uid ?? null)) {
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to edit this recording.' }, { status: user ? 403 : 401 });
  }
  let body: { segment?: unknown; at?: unknown; segA?: unknown; segB?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  let result: { ok: boolean; out: string };
  if (op === 'split') {
    if (typeof body.segment !== 'string' || typeof body.at !== 'number') {
      return NextResponse.json({ error: 'segment (string) and at (number seconds) required' }, { status: 400 });
    }
    result = runWorker(['split-segment', '--recording', id, '--segment', body.segment, '--at', String(body.at)]);
  } else if (op === 'merge') {
    if (typeof body.segA !== 'string' || typeof body.segB !== 'string') {
      return NextResponse.json({ error: 'segA and segB (strings) required' }, { status: 400 });
    }
    result = runWorker(['merge-segments', '--recording', id, '--seg-a', body.segA, '--seg-b', body.segB]);
  } else {
    return NextResponse.json({ error: 'Unknown op (split|merge)' }, { status: 404 });
  }
  if (!result.ok) return NextResponse.json({ error: result.out }, { status: 422 });
  const updated = getRecording(id);
  return NextResponse.json({ recordingId: id, segments: updated?.manifest?.segments ?? [] });
}
