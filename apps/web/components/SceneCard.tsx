'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { WorldSceneEntry } from '@/lib/worlds';
import { STATUS_LABELS, jobToStatus } from '@/lib/project-status';

function fmtDate(iso: string): string {
  try {
    return new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * One scene card: thumbnail, status, content stats, progress, and
 * owner actions (rename inline, delete with confirm). All mutations
 * hit the gated scene API; failures surface inline.
 */
export default function SceneCard({
  entry,
  onDeleted,
  onRenamed,
}: {
  entry: WorldSceneEntry;
  onDeleted: (id: string) => void;
  onRenamed: (id: string, name: string) => void;
}) {
  const status = jobToStatus(entry.job);
  const failed = entry.job?.status === 'failed';
  const progress = typeof entry.job?.progress === 'number' ? entry.job.progress : null;
  const working = progress !== null && status !== 'ready' && status !== 'failed' && status !== 'cancelled';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pill =
    status === 'ready'
      ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
      : status === 'failed' || status === 'needs-attention'
        ? 'border-amber-800 bg-amber-950/40 text-amber-300'
        : status === 'cancelled'
          ? 'border-neutral-700 text-neutral-400'
          : 'border-neutral-700 bg-neutral-900 text-neutral-300';

  const stats: string[] = [];
  if (entry.objects > 0) stats.push(`${entry.objects} object${entry.objects === 1 ? '' : 's'}`);
  if (entry.views > 0) stats.push(`${entry.views} view${entry.views === 1 ? '' : 's'}`);
  if (entry.coveragePct !== null) stats.push(`${entry.coveragePct}% coverage`);

  async function saveName() {
    const name = draft.trim();
    if (!name || name === entry.name) {
      setEditing(false);
      setDraft(entry.name);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(entry.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Rename failed (${res.status})`);
      }
      onRenamed(entry.id, name);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed');
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Delete failed (${res.status})`);
      }
      onDeleted(entry.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="group overflow-hidden rounded-xl border border-white/10 bg-[#111113] transition-colors hover:border-white/25">
      <Link href={`/scenes/${entry.id}`} className="block">
        <div className="relative">
          {entry.thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={entry.thumb} alt={`Capture frame from ${entry.name}`} className="aspect-[16/10] w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex aspect-[16/10] w-full items-center justify-center bg-gradient-to-br from-neutral-800 via-[#1a1611] to-black">
              <span className="font-display text-5xl text-neutral-700">
                {(entry.name.trim()[0] ?? '·').toUpperCase()}
              </span>
            </div>
          )}
          <span className="absolute left-3 top-3">
            <span className={`rounded-full border px-2.5 py-0.5 text-xs ${pill}`}>
              {STATUS_LABELS[status]}
            </span>
          </span>
          {entry.visibility === 'public' && (
            <span className="absolute right-3 top-3 rounded-full border border-white/20 bg-black/60 px-2.5 py-0.5 text-xs text-neutral-200">
              Public
            </span>
          )}
        </div>
      </Link>
      <div className="px-4 pb-4 pt-3">
        {editing ? (
          <span className="flex items-center gap-2">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveName();
                if (e.key === 'Escape') {
                  setEditing(false);
                  setDraft(entry.name);
                }
              }}
              disabled={busy}
              maxLength={200}
              className="min-w-0 flex-1 rounded-md border border-neutral-600 bg-neutral-900 px-2 py-1 text-sm"
            />
            <button type="button" onClick={() => void saveName()} disabled={busy} className="rounded-md bg-white px-2 py-1 text-xs font-medium text-black disabled:opacity-50">
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(entry.name);
              }}
              disabled={busy}
              className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Link href={`/scenes/${entry.id}`} className="block min-w-0 flex-1 truncate text-sm font-medium group-hover:text-white">
              {entry.name}
            </Link>
            <button
              type="button"
              title="Rename scene"
              onClick={() => {
                setDraft(entry.name);
                setEditing(true);
              }}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-500 opacity-0 transition-opacity hover:bg-neutral-800 hover:text-white group-hover:opacity-100"
            >
              ✎
            </button>
            {confirmDelete ? (
              <span className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={() => void doDelete()} disabled={busy} className="rounded bg-red-900 px-1.5 py-0.5 text-xs font-medium text-red-100 disabled:opacity-50">
                  {busy ? '…' : 'Delete?'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy}
                  className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-300"
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                title="Delete scene"
                onClick={() => setConfirmDelete(true)}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-500 opacity-0 transition-opacity hover:bg-neutral-800 hover:text-red-300 group-hover:opacity-100"
              >
                🗑
              </button>
            )}
          </span>
        )}
        <p className="mt-0.5 text-xs text-neutral-500">
          {stats.length > 0 ? stats.join(' · ') : fmtDate(entry.createdAt)}
          {stats.length > 0 && ` · ${fmtDate(entry.createdAt)}`}
        </p>
        {entry.job && stats.length > 0 && (
          <p className="mt-0.5 text-xs text-neutral-600">
            job {entry.job.status}
            {failed && entry.job?.errorCode ? ` · ${entry.job.errorCode.slice(0, 32)}` : ''}
          </p>
        )}
        {failed && stats.length === 0 && entry.job?.errorCode && (
          <p className="mt-0.5 text-xs text-neutral-600">
            job {entry.job.status} · {entry.job.errorCode.slice(0, 32)}
          </p>
        )}
        {working && (
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-neutral-800" title={`Reconstruction ${progress}%`}>
            <div className="h-full rounded-full bg-[#e2a63b] transition-all" style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
          </div>
        )}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-3">
          {status === 'ready' && entry.job ? (
            <Link href={`/scenes/${entry.id}`} className="inline-block rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black">
              Explore world
            </Link>
          ) : (
            <Link href={`/scenes/${entry.id}`} className="inline-block rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-400">
              {failed ? 'View details' : 'View progress'}
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
