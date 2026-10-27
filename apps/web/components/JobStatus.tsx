'use client';

import { useEffect, useState } from 'react';

interface JobState {
  jobId: string;
  status: string;
  progress: number | null;
  errorCode?: string;
  errorMessage?: string;
}

/** Polls GET /api/jobs/:jobId until a terminal state. Survives refresh (server-side job records). */
export default function JobStatus({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) throw new Error(`Job lookup failed (${res.status})`);
        const data = (await res.json()) as JobState;
        if (!cancelled) setJob(data);
        if (data.status !== 'ready' && data.status !== 'failed' && !cancelled) {
          setTimeout(poll, 2000);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Polling failed');
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (error) return <p className="text-sm text-red-400">Status error: {error}</p>;
  if (!job) return <p className="text-sm text-neutral-500">Loading job status…</p>;

  return (
    <div className="rounded-md border border-neutral-800 px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-neutral-400">Job {job.jobId}</span>
        <span className="font-medium">{job.status}</span>
      </div>
      {job.progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full bg-white transition-all"
            style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }}
          />
        </div>
      )}
      {job.status === 'failed' && (
        <p className="mt-2 text-red-400">
          {job.errorCode}: {job.errorMessage}
        </p>
      )}
    </div>
  );
}
