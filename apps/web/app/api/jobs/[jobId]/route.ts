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
  // Opportunistic notification sweep: a returning user polling a finished
  // job gets its completion notification created (idempotent).
  if (user) {
    const { ensureNotifications } = await import('@/lib/notifications');
    ensureNotifications(user.uid);
  }
  // Opportunistic email re-drive: jobs that finished while the worker lacked
  // mail credentials (or Brevo was unreachable) never got their completion
  // mail and nothing would retry. One detached catch-up pass; at-most-once
  // is enforced worker-side by the stamp-before-send + mkdir lock.
  if (user && (job.status === 'ready' || job.status === 'failed') && !job.emailNotified?.[job.status]) {
    try {
      const { spawnWorker } = await import('@/lib/worker');
      spawnWorker(['redrive-emails']);
    } catch {
      // Email must never break status polling.
    }
  }
  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    startedAt: job.startedAt,
    detail: job.detail ?? null,
    ...(job.waitingForTrainer ? { waitingForTrainer: true as const, waitingSince: job.waitingSince ?? null } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode, errorMessage: job.errorMessage } : {}),
    transitions: job.transitions,
  });
}
