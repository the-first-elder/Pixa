import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import { getJob } from '@/lib/store';
import { workerDir } from '@/lib/worker';
import { STORAGE_DIR } from '@/lib/config';

/** POST /api/jobs/:jobId/cancel — stop a running job's trainer, mark CANCELLED. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.status === 'ready' || job.status === 'failed') {
    return NextResponse.json({ jobId, status: job.status, note: 'already terminal' });
  }
  try {
    execFileSync('python3', ['-m', 'worker', 'cancel', jobId], {
      cwd: workerDir(),
      stdio: 'pipe',
      env: { ...process.env, STORAGE_DIR },
      timeout: 30000,
    });
  } catch (e) {
    const detail = (e as { stderr?: Buffer }).stderr?.toString().slice(0, 200);
    return NextResponse.json({ error: `Cancel failed: ${detail ?? 'unknown'}` }, { status: 500 });
  }
  const updated = getJob(jobId);
  return NextResponse.json({ jobId, status: updated?.status ?? 'unknown' });
}
