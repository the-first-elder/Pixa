'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import ChunkedUpload, { BIG_FILE } from '@/components/ChunkedUpload';
import { stashFile, unstashFile } from '@/lib/file-stash';

/**
 * Capture flow (PRD §6.2): name → select video → create scene → upload with
 * continuous progress → start processing → scene page. Every failure surfaces
 * the server's message; nothing proceeds silently.
 */
export default function UploadForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<'idle' | 'creating' | 'uploading' | 'starting' | 'error'>('idle');
  const [backend, setBackend] = useState('spirula');
  const [quality, setQuality] = useState('fast');
  const [allowPartial, setAllowPartial] = useState(false);
  const [progress, setProgress] = useState(0);

  const iterations = quality === 'full' ? 30000 : quality === 'balanced' ? 15000 : 7000;
  const [error, setError] = useState<string | null>(null);
  const [bigFile, setBigFile] = useState<File | null>(null);
  const [restored, setRestored] = useState(false);

  // After a sign-in redirect, restore the stashed file (one-shot).
  useEffect(() => {
    let cancelled = false;
    unstashFile('capture-pending').then((file) => {
      if (cancelled || !file || !fileRef.current) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      fileRef.current.files = dt.files;
      if (file.size > BIG_FILE) setBigFile(file);
      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Stash the file, then send the user to sign in (returns here after). */
  async function sendToSignIn(file: File) {
    const ok = await stashFile('capture-pending', file);
    if (!ok) {
      setError('Please sign in, then select your video again.');
      setPhase('error');
      return;
    }
    router.push('/signin?callbackUrl=/capture');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Select a video file first (.mp4 or .mov).');
      setPhase('error');
      return;
    }
    setError(null);
    try {
      setPhase('creating');
      const createRes = await fetch('/api/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'Untitled scene' }),
      });
      if (createRes.status === 401) {
        setPhase('idle');
        await sendToSignIn(file);
        return;
      }
      if (!createRes.ok) throw new Error(`Scene creation failed (${createRes.status})`);
      const { sceneId } = (await createRes.json()) as { sceneId: string };

      setPhase('uploading');
      setProgress(0);
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/scenes/${sceneId}/upload`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else {
            try {
              const body = JSON.parse(xhr.responseText) as { error?: string };
              reject(new Error(body.error ?? `Upload failed (${xhr.status})`));
            } catch {
              reject(new Error(`Upload failed (${xhr.status})`));
            }
          }
        };
        xhr.onerror = () => reject(new Error('Upload connection failed'));
        const form = new FormData();
        form.append('video', file);
        xhr.send(form);
      });

      setPhase('starting');
      const procRes = await fetch(`/api/scenes/${sceneId}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend, allowPartial, iterations }),
      });
      if (!procRes.ok) {
        const body = (await procRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Processing start failed (${procRes.status})`);
      }
      router.push(`/scenes/${sceneId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setPhase('error');
    }
  }

  const busy = phase === 'creating' || phase === 'uploading' || phase === 'starting';

  return (
    <form onSubmit={submit} className="mt-8 space-y-4">
      <div>
        <label htmlFor="scene-name" className="text-sm text-neutral-400">Scene name</label>
        <input
          id="scene-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Main workshop"
          className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label htmlFor="video" className="text-sm text-neutral-400">Video (.mp4 / .mov, short indoor capture)</label>
        <input
          id="video"
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,.mp4,.mov"
          className="mt-1 w-full text-sm"
          onChange={() => {
            const f = fileRef.current?.files?.[0] ?? null;
            setBigFile(f && f.size > BIG_FILE ? f : null);
          }}
        />
      </div>
      {bigFile && (
        <ChunkedUpload key={bigFile.name + bigFile.size} file={bigFile} name={name} />
      )}
      {restored && (
        <p className="rounded-md border border-white/10 bg-[#111113] px-3 py-2 text-xs text-neutral-300">
          Your selected video was restored after signing in — press Upload and reconstruct to continue.
        </p>
      )}
      {phase === 'uploading' && (
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
          <div className="h-full bg-white transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
      <div>
        <label htmlFor="backend" className="text-sm text-neutral-400">Reconstruction backend</label>
        <select
          id="backend"
          value={backend}
          onChange={(e) => setBackend(e.target.value)}
          className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          <option value="spirula">Spirula — free, on this machine (recommended)</option>
          <option value="local">Local FFmpeg+COLMAP — needs colmap binary</option>
          <option value="kiri">KIRI hosted API — spends credits (needs key)</option>
          <option value="runpod">RunPod cloud GPU — needs pod + asset</option>
        </select>
      </div>
      <div>
        <label htmlFor="quality" className="text-sm text-neutral-400">Quality (training time)</label>
        <select
          id="quality"
          value={quality}
          onChange={(e) => setQuality(e.target.value)}
          className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          <option value="fast">Fast preview — ~7k iterations, minutes (good for drafts)</option>
          <option value="balanced">Balanced — ~15k iterations</option>
          <option value="full">Full — 30k iterations, best quality (slow)</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <input
          id="allow-partial"
          type="checkbox"
          checked={allowPartial}
          onChange={(e) => setAllowPartial(e.target.checked)}
        />
        <label htmlFor="allow-partial" className="text-sm text-neutral-400">
          Train a labeled partial preview if coverage is incomplete
        </label>
      </div>
      {phase !== 'idle' && phase !== 'error' && (
        <p className="text-sm text-neutral-500">
          {phase === 'creating' && 'Creating scene…'}
          {phase === 'uploading' && `Uploading… ${progress}%`}
          {phase === 'starting' && 'Starting reconstruction…'}
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
      >
        Upload and reconstruct
      </button>
    </form>
  );
}
