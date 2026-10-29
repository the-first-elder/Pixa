'use client';

import { useEffect, useRef, useState } from 'react';

interface JobState {
  jobId: string;
  status: string;
  progress: number | null;
  errorCode?: string;
  errorMessage?: string;
  waitingForTrainer?: boolean;
  startedAt?: string;
  detail?: { step?: number; total?: number; etaSeconds?: number; source?: string } | null;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}h ${m}m`
    : m > 0
      ? `${m}m ${String(sec).padStart(2, '0')}s`
      : `${sec}s`;
}

/**
 * Polls GET /api/jobs/:jobId until a terminal state. Survives refresh
 * (server-side job records). Shows a prominent countdown while work remains
 * and tells the owner they'll be emailed — because renders take a while and
 * nobody should have to baby-sit the page.
 */
export default function JobStatus({
  jobId,
  startedAt,
  notifyEmail,
}: {
  jobId: string;
  startedAt?: string;
  /** Owner email for the "we'll notify you" line; omit when unknown/signed out. */
  notifyEmail?: string | null;
}) {
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(startedAt ? new Date(startedAt).getTime() : null);
  // All hooks above all early returns — hook order must never change.
  const active = !job || (job.status !== 'ready' && job.status !== 'failed');

  useEffect(() => {
    let cancelled = false;
    let reloaded = false;
    async function poll() {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) throw new Error(`Job lookup failed (${res.status})`);
        const data = (await res.json()) as JobState;
        if (!cancelled) {
          setJob(data);
          if (!startRef.current && data.startedAt) {
            startRef.current = new Date(data.startedAt).getTime();
          }
        }
        if (data.status === 'ready' && !reloaded) {
          // The viewer mounted before the asset existed — reload once so the
          // manifest, viewer, and panels pick up the finished reconstruction.
          reloaded = true;
          setTimeout(() => {
            if (!cancelled) window.location.reload();
          }, 1200);
          return;
        }
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

  // Ticking elapsed timer while the job is active.
  useEffect(() => {
    if (!active) return;
    setElapsed(startRef.current ? Date.now() - startRef.current : 0);
    const t = window.setInterval(() => {
      if (startRef.current) setElapsed(Date.now() - startRef.current);
    }, 1000);
    return () => window.clearInterval(t);
  }, [active, jobId]);

  if (error) return <p className="text-sm text-red-400">Status error: {error}</p>;
  if (!job) return <p className="text-sm text-neutral-500">Loading job status…</p>;
  const displayStart = startRef.current ?? (job.startedAt ? new Date(job.startedAt).getTime() : null);

  async function cancel() {
    try {
      const res = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      const data = (await res.json()) as { status?: string };
      if (data.status) setJob({ ...job!, status: data.status });
    } catch {
      // Poll loop will surface the true state.
    }
  }

  return (
    <div className="rounded-md border border-neutral-800 px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-neutral-400">Job {job.jobId}</span>
        <span className="flex items-center gap-2">
          <span className="font-medium">{job.status}</span>
          {active && displayStart && (
            <span className="text-xs tabular-nums text-neutral-500" title="Elapsed processing time">
              {fmtElapsed(elapsed)}
            </span>
          )}
          {active && (
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300"
              title="Stop this job's training"
            >
              Cancel
            </button>
          )}
        </span>
      </div>
      {job.progress !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full bg-white transition-all"
            style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }}
          />
        </div>
      )}
      {active && typeof job.detail?.etaSeconds === 'number' && job.detail.etaSeconds > 0 ? (
        <p className="mt-2 text-base font-medium tabular-nums text-white">
          ≈ {fmtElapsed(job.detail.etaSeconds * 1000)} left
        </p>
      ) : (
        active && (
          <p className="mt-2 text-sm tabular-nums text-neutral-300">
            Running {fmtElapsed(elapsed)}{' '}
            <span className="text-neutral-500">· estimating remaining time…</span>
          </p>
        )
      )}
      {active && (
        <p className="mt-2 rounded-md border border-[#e2a63b]/40 bg-[#e2a63b]/10 px-3 py-2 text-xs text-neutral-200">
          Rendering can take a while — feel free to leave this page.
          {notifyEmail ? (
            <> We&rsquo;ll email <span className="font-medium text-white">{notifyEmail}</span> the moment it&rsquo;s ready.</>
          ) : (
            <> You&rsquo;ll get an in-app notification when it&rsquo;s ready — sign in to also get an email.</>
          )}
        </p>
      )}
      {job.waitingForTrainer && job.status !== 'ready' && job.status !== 'failed' && (
        <p className="mt-2 text-amber-400">
          Queued behind the running training — starts automatically when the trainer frees up.
        </p>
      )}
      {active && job.detail?.step != null && job.detail?.total != null && (
        <p className="mt-1 text-xs text-neutral-500">
          Step {job.detail.step.toLocaleString()} / {job.detail.total.toLocaleString()}
          {typeof job.detail.etaSeconds === 'number' && job.detail.etaSeconds > 0 && (
            <span title="Estimated by the trainer from current speed; fluctuates"> (trainer estimate)</span>
          )}
        </p>
      )}
      {job.status === 'failed' && (
        <p className="mt-2 text-red-400">
          {job.errorCode}: {job.errorMessage}
        </p>
      )}
    </div>
  );
}
