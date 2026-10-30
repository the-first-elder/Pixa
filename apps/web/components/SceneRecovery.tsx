'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import UploadBar from './UploadBar';

/**
 * Recovery actions for a scene that cannot be explored yet: failed job,
 * no job, or no video. Without this the page is a dead end — the user
 * could only abandon the scene. Actions: re-run reconstruction, replace
 * the source video, or delete the scene.
 */
export default function SceneRecovery({
  sceneId,
  hasVideo,
  failed,
}: {
  sceneId: string;
  hasVideo: boolean;
  failed: boolean;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function reprocess() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: 'spirula' }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Reprocess failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reprocess failed');
    } finally {
      setBusy(false);
    }
  }

  async function replaceVideo(file: File) {
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/scenes/${encodeURIComponent(sceneId)}/upload`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setProgress(100);
            resolve();
          } else {
            let message = `Upload failed (${xhr.status})`;
            try {
              const body = JSON.parse(xhr.responseText) as { error?: string };
              if (body.error) message = body.error;
            } catch { /* keep generic */ }
            reject(new Error(message));
          }
        };
        xhr.onerror = () => reject(new Error('Upload connection failed'));
        const form = new FormData();
        form.append('video', file);
        xhr.send(form);
      });
      await reprocess();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Replace failed');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Delete failed (${res.status})`);
      }
      router.push('/worlds');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-amber-800 bg-amber-950/30 px-4 py-3">
      <p className="text-sm text-amber-200">
        {failed
          ? 'This reconstruction did not finish. You are not stuck — pick a next step:'
          : hasVideo
            ? 'This scene has a video but no reconstruction yet:'
            : 'This scene has no video yet:'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {hasVideo && (
          <button
            type="button"
            onClick={reprocess}
            disabled={busy}
            className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50"
          >
            Re-run reconstruction
          </button>
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="rounded-md border border-neutral-600 px-3 py-1.5 text-xs text-neutral-200 disabled:opacity-50"
        >
          {hasVideo ? 'Replace video' : 'Upload a video'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
          className="hidden"
          onChange={() => {
            const f = fileRef.current?.files?.[0];
            if (f) void replaceVideo(f);
          }}
        />
        {confirmDelete ? (
          <span className="flex items-center gap-1">
            <button type="button" onClick={doDelete} disabled={busy} className="rounded bg-red-900 px-2 py-1.5 text-xs font-medium text-red-100 disabled:opacity-50">
              Delete forever?
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy} className="rounded border border-neutral-600 px-2 py-1.5 text-xs text-neutral-300">
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 disabled:opacity-50"
          >
            Delete scene
          </button>
        )}
      </div>
      {progress !== null && (
        <div className="mt-2">
          <UploadBar progress={progress} />
          <p className="mt-1 text-xs text-neutral-400">Uploading… {progress}%</p>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <p className="mt-2 text-xs text-neutral-500">
        Better results: 1080p+ original footage, slow overlapping walkthrough, every corner covered.
        Reconstruction can take a while — you will be emailed when it is ready.
      </p>
    </div>
  );
}
