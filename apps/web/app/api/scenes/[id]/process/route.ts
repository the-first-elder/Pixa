import { NextRequest, NextResponse } from 'next/server';
import { createJob, getScene, waitingTrainerCount } from '@/lib/store';
import { canWrite, sessionUser } from '@/lib/authz';
import { spawnWorker } from '@/lib/worker';

/** Max queued-behind-trainer jobs. Beyond this, fail fast instead of piling up. */
const MAX_QUEUE = 3;

/**
 * POST /api/scenes/:sceneId/process — create a reconstruction job and launch
 * the worker detached. Returns immediately; poll GET /api/jobs/:jobId.
 * Body: { "backend"?: "local"|"kiri"|"runpod", "asset"?, "poses"? }
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
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to start reconstruction.' }, { status: user ? 403 : 401 });
  }
  const video = (scene.sourceVideo as { storagePath?: string } | null)?.storagePath;
  if (!video) {
    return NextResponse.json(
      { error: 'No source video uploaded for this scene yet.' },
      { status: 409 },
    );
  }

  let backend = 'local';
  let asset: string | undefined;
  let poses: string | undefined;
  let allowPartial = false;
  let iterations = 30000;
  try {
    const body = await req.json();
    if (typeof body?.backend === 'string') backend = body.backend;
    if (typeof body?.asset === 'string') asset = body.asset;
    if (typeof body?.poses === 'string') poses = body.poses;
    if (body?.allowPartial === true) allowPartial = true;
    if (typeof body?.iterations === 'number' && Number.isFinite(body.iterations)) {
      iterations = Math.min(50000, Math.max(1000, Math.round(body.iterations)));
    }
  } catch {
    // Defaults stand.
  }
  if (!['local', 'kiri', 'runpod', 'spirula'].includes(backend)) {
    return NextResponse.json({ error: `Unknown backend: ${backend}` }, { status: 400 });
  }

  if (backend === 'spirula' && waitingTrainerCount() >= MAX_QUEUE) {
    return NextResponse.json(
      { error: `Trainer queue is full (${MAX_QUEUE} waiting). Wait for a slot or cancel a queued job before submitting.` },
      { status: 429 },
    );
  }
  const job = createJob(scene.id, 'reconstruction', scene.ownerId ?? user?.uid ?? null);
  const args = ['run-job', job.id, '--video', video, '--backend', backend,
    '--iterations', String(iterations)];
  if (asset) args.push('--asset', asset);
  if (poses) args.push('--poses', poses);
  if (allowPartial) args.push('--allow-partial');
  spawnWorker(args);
  return NextResponse.json({ jobId: job.id, status: 'queued' }, { status: 202 });
}
