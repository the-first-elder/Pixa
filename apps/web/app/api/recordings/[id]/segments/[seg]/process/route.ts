import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { getRecording } from '@/lib/recordings';
import { STORAGE_DIR } from '@/lib/config';
import { workerDir } from '@/lib/worker';

/**
 * POST /api/recordings/:id/segments/:seg/process — reconstruct one segment
 * through the real pipeline (detached). Body: { backend?, iterations?,
 * allowPartial? }. Segments queue naturally behind the single trainer slot.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; seg: string }> },
) {
  const { id, seg } = await params;
  const rec = getRecording(id);
  if (!rec) return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  const segment = rec.manifest?.segments.find((s) => s.id === seg);
  if (!segment) return NextResponse.json({ error: 'Segment not found' }, { status: 404 });
  if (segment.sceneId && segment.status === 'ready') {
    return NextResponse.json({ error: 'Segment already reconstructed', sceneId: segment.sceneId }, { status: 409 });
  }
  let backend = 'spirula';
  let iterations = 30000;
  let allowPartial = false;
  try {
    const body = await req.json();
    if (typeof body?.backend === 'string') backend = body.backend;
    if (typeof body?.iterations === 'number' && Number.isFinite(body.iterations)) {
      iterations = Math.min(50000, Math.max(1000, Math.round(body.iterations)));
    }
    if (body?.allowPartial === true) allowPartial = true;
  } catch {
    // Defaults stand.
  }
  if (!['local', 'kiri', 'runpod', 'spirula'].includes(backend)) {
    return NextResponse.json({ error: `Unknown backend: ${backend}` }, { status: 400 });
  }
  const args = ['process-segment', '--recording', id, '--segment', seg, '--backend', backend, '--iterations', String(iterations)];
  if (allowPartial) args.push('--allow-partial');
  const child = spawn('python3', ['-m', 'worker', ...args], {
    cwd: workerDir(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, STORAGE_DIR },
  });
  child.unref();
  return NextResponse.json({ recordingId: id, segment: seg, status: 'queued' }, { status: 202 });
}
