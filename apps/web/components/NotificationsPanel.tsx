'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

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

/** Notification list with read acknowledgment. Fetches fresh on mount. */
export default function NotificationsPanel() {
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/notifications')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setItems(d.notifications as Item[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function mark(id: string) {
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) ?? null);
  }

  if (items === null) return null;
  if (items.length === 0) return null;

  return (
    <section id="notifications" className="mt-10 scroll-mt-20">
      <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">
        Notifications
      </h2>
      <div className="mt-4 space-y-3">
        {items.map((n) => (
          <div
            key={n.id}
            className={`rounded-xl border px-5 py-4 ${n.readAt ? 'border-white/10 bg-[#111113]' : 'border-[#e2a63b]/40 bg-[#141210]'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{n.title}</p>
                <p className="mt-1 text-sm text-neutral-400">{n.message}</p>
                <p className="mt-1 text-xs text-neutral-500">
                  {n.projectName}
                  {n.detail ? ` · ${n.detail}` : ''}
                </p>
              </div>
              {!n.readAt && (
                <button
                  type="button"
                  onClick={() => mark(n.id)}
                  className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-400"
                >
                  Mark read
                </button>
              )}
            </div>
            <Link
              href={n.projectKind === 'scene' ? `/scenes/${n.projectId}` : `/recordings/${n.projectId}`}
              className="mt-2 inline-block text-xs text-[#e2a63b] underline underline-offset-4"
            >
              {n.kind === 'scene-failed' ? 'View project' : 'Explore world'}
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
