'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { stashFile } from '@/lib/file-stash';
import SignInModal from './SignInModal';
import UploadBar from './UploadBar';

const CHUNK = 8 * 1024 * 1024;
const BIG_FILE = 50 * 1024 * 1024;

/**
 * Resumable chunked upload. Used automatically for files over 50 MB (the
 * direct form upload stays for small files). Survives refresh mid-upload:
 * the server bitmap shows what's already there.
 */
export default function ChunkedUpload({ file, name }: { file: File; name: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const stopRef = useRef(false);

  async function start(resumeId?: string) {
    setError(null);
    setPhase('uploading');
    stopRef.current = false;
    try {
      let uploadId = resumeId;
      let chunkSize = CHUNK;
      let chunks = Math.ceil(file.size / CHUNK);
      let received: boolean[] = [];
      if (!uploadId) {
        const create = await fetch('/api/uploads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, size: file.size, mime: file.type, chunkSize: CHUNK }),
        });
        if (create.status === 401) {
          setPhase('idle');
          const ok = await stashFile('capture-pending', file);
          if (!ok) {
            setError('Please sign in, then select your video again.');
            return { paused: false as const, uploadId: undefined as string | undefined };
          }
          setSignInOpen(true);
          return { paused: false as const, uploadId: undefined as string | undefined };
        }
        if (!create.ok) {
          const body = (await create.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Upload session failed (${create.status})`);
        }
        const data = (await create.json()) as { uploadId: string; chunkSize: number; chunks: number };
        uploadId = data.uploadId;
        chunkSize = data.chunkSize;
        chunks = data.chunks;
      } else {
        const st = await fetch(`/api/uploads/${uploadId}`);
        if (!st.ok) throw new Error('Upload session gone — restart the upload');
        const data = (await st.json()) as { chunkSize: number; chunks: number; received: boolean[] };
        chunkSize = data.chunkSize;
        chunks = data.chunks;
        received = data.received;
      }
      for (let i = 0; i < chunks; i++) {
        if (stopRef.current) {
          setPhase('idle');
          return { paused: true as const, uploadId };
        }
        if (received[i]) continue;
        const start = i * chunkSize;
        const blob = file.slice(start, Math.min(file.size, start + chunkSize));
        const put = await fetch(`/api/uploads/${uploadId}/chunks/${i}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        });
        if (!put.ok) {
          const body = (await put.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Chunk ${i} failed (${put.status})`);
        }
        const st = (await put.json()) as { receivedBytes: number };
        setProgress(Math.round((st.receivedBytes / file.size) * 100));
      }
      const done = await fetch(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
      if (!done.ok) {
        const body = (await done.json().catch(() => null)) as { error?: string; missing?: number[] } | null;
        throw new Error(body?.error ?? `Finalize failed (${done.status})`);
      }
      const { path } = (await done.json()) as { path: string };
      // Register as a recording (long-video flow): analysis segments it.
      const rec = await fetch('/api/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || file.name, videoPath: path }),
      });
      if (!rec.ok) {
        const body = (await rec.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Recording failed (${rec.status})`);
      }
      const { recordingId } = (await rec.json()) as { recordingId: string };
      setPhase('done');
      router.push(`/recordings/${recordingId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setPhase('error');
    }
    return { paused: false as const, uploadId: undefined as string | undefined };
  }

  return (
    <div className="mt-2">
      {phase === 'idle' && (
        <button
          type="button"
          onClick={() => start()}
          className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black"
        >
          Upload resumable ({Math.round(file.size / 1048576)} MB)
        </button>
      )}
      {phase === 'uploading' && (
        <div>
          <UploadBar progress={progress} />
          <div className="mt-2 flex items-center gap-3">
            <p className="text-sm text-neutral-500">Uploading… {progress}% (refresh-safe)</p>
            <button type="button" onClick={() => { stopRef.current = true; }} className="text-xs text-neutral-400 underline">
              Pause
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} callbackUrl="/capture" />
    </div>
  );
}

export { BIG_FILE };
