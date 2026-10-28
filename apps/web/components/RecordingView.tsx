'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface Segment {
  id: string;
  start: number;
  end: number;
  origin: string;
  boundary_confidence: string;
  status: string;
  jobId?: string;
  sceneId?: string;
  warnings: string[];
}

interface RecordingData {
  id: string;
  name: string;
  manifest: { duration: number; segments: Segment[] } | null;
  computedStatus: string;
}

function fmtT(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Recording workspace: analysis + per-segment states, retry, open scenes. */
export default function RecordingView({ recordingId }: { recordingId: string }) {
  const [rec, setRec] = useState<RecordingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/recordings/${recordingId}`);
      if (!res.ok) throw new Error(`Recording lookup failed (${res.status})`);
      setRec((await res.json()) as RecordingData);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    }
  }

  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId]);

  async function process(seg: string) {
    setBusy(seg);
    setError(null);
    try {
      const res = await fetch(`/api/recordings/${recordingId}/segments/${seg}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: 'spirula', iterations: 7000 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Start failed (${res.status})`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Start failed');
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!rec) return <p className="text-sm text-neutral-500">Loading recording…</p>;
  const segs = rec.manifest?.segments ?? [];

  return (
    <div>
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">{rec.name}</h1>
        <span className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300">
          {rec.computedStatus}
        </span>
      </div>
      {!rec.manifest && <p className="mt-4 text-sm text-neutral-500">Analyzing recording… segments appear here.</p>}
      {rec.manifest && (
        <p className="mt-2 text-sm text-neutral-500">
          {fmtT(rec.manifest.duration)} · {segs.length} segment(s) · boundaries auto-suggested, review before processing
        </p>
      )}
      <div className="mt-6 space-y-3">
        {segs.map((s) => (
          <div key={s.id} className="flex gap-4 rounded-md border border-neutral-800 p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/recordings/${recordingId}/thumbs/${s.id}`}
              alt={`Segment ${s.id} thumbnail`}
              className="h-20 w-32 rounded object-cover bg-neutral-900"
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{s.id}</span>
                <span className="text-xs text-neutral-500">
                  {fmtT(s.start)}–{fmtT(s.end)} · {s.origin} · confidence {s.boundary_confidence}
                </span>
                <span className="ml-auto rounded border border-neutral-700 px-2 py-0.5 text-xs">{s.status}</span>
              </div>
              {s.warnings.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-amber-300">
                  {s.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex gap-2">
                {s.sceneId && s.status === 'ready' ? (
                  <Link href={`/scenes/${s.sceneId}`} className="rounded bg-white px-3 py-1 text-xs font-medium text-black">
                    Open scene
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled={busy === s.id}
                    onClick={() => process(s.id)}
                    className="rounded bg-white px-3 py-1 text-xs font-medium text-black disabled:opacity-50"
                  >
                    {s.status === 'failed' ? 'Retry segment' : busy === s.id ? 'Starting…' : 'Reconstruct segment'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
