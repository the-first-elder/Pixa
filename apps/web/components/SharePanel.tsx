'use client';

import { useEffect, useState } from 'react';

interface Viewpoint {
  id: string;
  label: string;
}

/**
 * Share panel: visibility toggle + starting-viewpoint link.
 * Links carry ?v=<viewpointId> so recipients open on the intended view.
 * Visibility is explicit; scenes default to private.
 */
export default function SharePanel({ sceneId }: { sceneId: string }) {
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [viewpoints, setViewpoints] = useState<Viewpoint[]>([]);
  const [start, setStart] = useState('');
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scenes/${encodeURIComponent(sceneId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        if (d.scene?.visibility === 'public' || d.scene?.visibility === 'private') {
          setVisibility(d.scene.visibility);
        }
        const vps = (d.manifest?.viewpoints ?? []) as Viewpoint[];
        setViewpoints(vps);
        if (vps.length > 0 && !start) setStart(vps[0].id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId]);

  async function toggle() {
    setNotice(null);
    const next = visibility === 'public' ? 'private' : 'public';
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) throw new Error(`Update failed (${res.status})`);
      setVisibility(next);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Update failed');
    }
  }

  function link(): string {
    const base = window.location.origin;
    const v = start ? `?v=${encodeURIComponent(start)}` : '';
    return `${base}/scenes/${encodeURIComponent(sceneId)}${v}`;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice('Clipboard unavailable — copy the URL manually');
    }
  }

  return (
    <div className="rounded-md border border-neutral-800 px-4 py-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-neutral-400">
          Sharing: <span className="font-medium text-neutral-200">{visibility}</span>
        </span>
        <button
          type="button"
          onClick={toggle}
          className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300"
        >
          Make {visibility === 'public' ? 'private' : 'public'}
        </button>
      </div>
      {viewpoints.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor={`share-start-${sceneId}`} className="text-xs text-neutral-500">
            Start at
          </label>
          <select
            id={`share-start-${sceneId}`}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
          >
            {viewpoints.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={copy}
            className="rounded bg-white px-3 py-1 text-xs font-medium text-black"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
      {notice && <p className="mt-2 text-xs text-red-400">{notice}</p>}
    </div>
  );
}
