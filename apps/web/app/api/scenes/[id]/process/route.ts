import { NextRequest, NextResponse } from 'next/server';
import { createJob, getScene } from '@/lib/store';
import { spawnWorker } from '@/lib/worker';

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
  try {
    const body = await req.json();
    if (typeof body?.backend === 'string') backend = body.backend;
    if (typeof body?.asset === 'string') asset = body.asset;
    if (typeof body?.poses === 'string') poses = body.poses;
    if (body?.allowPartial === true) allowPartial = true;
  } catch {
    // Defaults stand.
  }
  if (!['local', 'kiri', 'runpod', 'spirula'].includes(backend)) {
    return NextResponse.json({ error: `Unknown backend: ${backend}` }, { status: 400 });
  }

  const job = createJob(scene.id, 'reconstruction');
  const args = ['run-job', job.id, '--video', video, '--backend', backend];
  if (asset) args.push('--asset', asset);
  if (poses) args.push('--poses', poses);
  if (allowPartial) args.push('--allow-partial');
  spawnWorker(args);
  return NextResponse.json({ jobId: job.id, status: 'queued' }, { status: 202 });
}
