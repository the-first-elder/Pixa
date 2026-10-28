import { NextResponse } from 'next/server';
import { getJob, getScene } from '@/lib/store';
import { canRead, sessionUser } from '@/lib/authz';

/**
 * GET /api/jobs/:jobId — processing status.
 * Progress comes from actual job-stage transitions, never a fabricated timer.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  const user = await sessionUser();
  // Owner check on the job, falling back to its scene (worker-created jobs
  // may predate ownership). 404 either way to avoid ID enumeration.
  const scene = job ? getScene(job.sceneId) : null;
  const allowed = job != null && (canRead(job, user?.uid ?? null) || (scene != null && canRead(scene, user?.uid ?? null)));
  if (!allowed || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    startedAt: job.startedAt,
    ...(job.waitingForTrainer ? { waitingForTrainer: true as const, waitingSince: job.waitingSince ?? null } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode, errorMessage: job.errorMessage } : {}),
    transitions: job.transitions,
  });
}
