'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Item {
  id: string;
  kind: string;
  projectId: string;
  projectKind: string;
  projectName: string;
  title: string;
  message: string;
  detail?: string | null;
  createdAt: string;
  readAt: string | null;
}

function timeAgo(iso: string): string {
  const t = new Date(iso.endsWith('Z') ? iso : `${iso}Z`).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function kindIcon(kind: string): { glyph: string; label: string } {
  if (kind === 'scene-failed') return { glyph: '⚠', label: 'Failed' };
  if (kind === 'recording-settled') return { glyph: '◐', label: 'Partially ready' };
  return { glyph: '✓', label: 'Ready' };
}

/**
 * Notifications bell + modal. The bell carries a live unread badge (refreshed
 * on open, on focus, and every minute); the modal is the single place to
 * read, acknowledge, and jump to the finished work. Escape or backdrop click
 * closes; opening the modal never marks anything read by itself.
 */
export default function NotificationsBell() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/notifications');
      if (r.status === 401) {
        setAuthed(false);
        return;
      }
      if (!r.ok) {
        setError(true);
        return;
      }
      const d = await r.json();
      setAuthed(true);
      setError(false);
      setItems(d.notifications as Item[]);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  // Open reads fresh; close re-syncs the badge. Escape closes. Body scroll
  // locks while open; focus lands on the close button.
  useEffect(() => {
    if (!open) return;
    refresh();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      refresh();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  async function mark(id: string) {
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) ?? null);
  }

  async function markAll() {
    const r = await fetch('/api/notifications/read', { method: 'POST' }).catch(() => null);
    if (r && r.ok) {
      const now = new Date().toISOString();
      setItems((prev) => prev?.map((n) => ({ ...n, readAt: n.readAt ?? now })) ?? null);
    }
  }

  if (authed === false) return null;
  const unread = (items ?? []).filter((n) => !n.readAt).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-400 hover:text-white"
        title={unread > 0 ? `${unread} unread notification(s)` : 'Notifications'}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#e2a63b] px-1 text-[10px] font-medium text-black">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[10vh] backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#111113] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <h2 className="text-base font-medium text-[#f5f1e8]">Notifications</h2>
                {unread > 0 && (
                  <span className="rounded-full bg-[#e2a63b]/15 px-2 py-0.5 text-xs text-[#e2a63b]">
                    {unread} new
                  </span>
                )}
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-1 text-lg leading-none text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Close notifications"
              >
                ×
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-3">
              {items === null && !error && (
                <div className="space-y-2.5 p-2" aria-label="Loading notifications">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="animate-pulse rounded-xl border border-white/5 bg-white/[0.03] px-4 py-4">
                      <div className="h-3.5 w-2/3 rounded bg-white/10" />
                      <div className="mt-2 h-3 w-1/2 rounded bg-white/[0.07]" />
                    </div>
                  ))}
                </div>
              )}
              {error && items === null && (
                <p className="px-4 py-8 text-center text-sm text-neutral-400">
                  Couldn’t load notifications. Close and try again.
                </p>
              )}
              {items !== null && items.length === 0 && (
                <div className="px-4 py-10 text-center">
                  <p className="text-3xl" aria-hidden>🎉</p>
                  <p className="mt-3 text-sm font-medium text-[#f5f1e8]">You’re all caught up</p>
                  <p className="mt-1 text-sm text-neutral-400">
                    Finished reconstructions will land here — and in your inbox.
                  </p>
                </div>
              )}
              {items !== null && items.length > 0 && (
                <ul className="space-y-2">
                  {items.map((n) => {
                    const icon = kindIcon(n.kind);
                    const href = n.projectKind === 'scene' ? `/scenes/${n.projectId}` : `/recordings/${n.projectId}`;
                    return (
                      <li
                        key={n.id}
                        className={`rounded-xl border px-4 py-3.5 transition-colors ${
                          n.readAt ? 'border-white/[0.07] bg-transparent' : 'border-[#e2a63b]/30 bg-[#e2a63b]/[0.05]'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm ${
                              n.kind === 'scene-failed'
                                ? 'bg-amber-500/15 text-amber-300'
                                : n.kind === 'recording-settled'
                                  ? 'bg-sky-500/15 text-sky-300'
                                  : 'bg-emerald-500/15 text-emerald-300'
                            }`}
                            title={icon.label}
                            aria-label={icon.label}
                          >
                            {icon.glyph}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <p className="truncate text-sm font-medium text-[#f5f1e8]">{n.title}</p>
                              <span className="shrink-0 text-xs text-neutral-500">{timeAgo(n.createdAt)}</span>
                            </div>
                            <p className="mt-0.5 text-sm leading-snug text-neutral-400">{n.message}</p>
                            <p className="mt-1 truncate text-xs text-neutral-500">
                              {n.projectName}
                              {n.detail ? ` · ${n.detail}` : ''}
                            </p>
                            <div className="mt-2 flex items-center gap-4">
                              <Link
                                href={href}
                                onClick={() => {
                                  if (!n.readAt) mark(n.id);
                                  setOpen(false);
                                }}
                                className="text-xs font-medium text-[#e2a63b] underline underline-offset-4 hover:text-[#f0bc5e]"
                              >
                                {n.kind === 'scene-failed' ? 'View project →' : 'Explore world →'}
                              </Link>
                              {!n.readAt && (
                                <button
                                  type="button"
                                  onClick={() => mark(n.id)}
                                  className="text-xs text-neutral-500 underline-offset-4 hover:text-neutral-300 hover:underline"
                                >
                                  Dismiss
                                </button>
                              )}
                            </div>
                          </div>
                          {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#e2a63b]" aria-label="Unread" />}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {items !== null && unread > 0 && (
              <div className="border-t border-white/10 px-5 py-3">
                <button
                  type="button"
                  onClick={markAll}
                  className="text-xs font-medium text-neutral-300 underline-offset-4 hover:text-white hover:underline"
                >
                  Mark all as read
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
