import { NextResponse } from 'next/server';
import { getJob } from '@/lib/store';

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
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
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
