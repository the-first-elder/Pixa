/**
 * Resumable chunked upload client (browser). Splits a file into 8MB chunks
 * uploaded by 3 parallel workers; the server bitmap makes any interruption
 * resumable — a retry re-asks what arrived and sends only the missing
 * chunks. Sessions are remembered per (name,size) in-memory so a retry
 * after a dropped connection resumes instead of restarting.
 *
 * Throws an Error with `.status` set on HTTP failures (401 = sign-in).
 */

const CHUNK = 8 * 1024 * 1024;
const sessions = new Map<string, string>();

export class UploadHttpError extends Error {
  status?: number;
}

function httpError(status: number, message: string): UploadHttpError {
  const e = new UploadHttpError(message) as UploadHttpError;
  e.status = status;
  return e;
}

async function bodyError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return httpError(res.status, body?.error ?? `${fallback} (${res.status})`);
}

export interface ChunkedUploadResult {
  uploadId: string;
  path: string;
}

export async function uploadChunked(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<ChunkedUploadResult> {
  const key = `${file.name}|${file.size}`;
  let uploadId = sessions.get(key);
  let chunkSize = CHUNK;
  let chunks = Math.max(1, Math.ceil(file.size / CHUNK));
  let received: boolean[] = [];
  if (uploadId) {
    const st = await fetch(`/api/uploads/${uploadId}`);
    if (st.ok) {
      const data = (await st.json()) as { chunkSize: number; chunks: number; received: boolean[]; status: string };
      if (data.status === 'complete') {
        // Already finished in a previous attempt; just re-finalize below.
        chunkSize = data.chunkSize;
        chunks = data.chunks;
        received = data.received.map(() => true);
      } else {
        chunkSize = data.chunkSize;
        chunks = data.chunks;
        received = data.received;
      }
    } else {
      uploadId = undefined; // session gone — start fresh
    }
  }
  if (!uploadId) {
    const create = await fetch('/api/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size, mime: file.type, chunkSize: CHUNK }),
    });
    if (!create.ok) throw await bodyError(create, 'Upload session failed');
    const data = (await create.json()) as { uploadId: string; chunkSize: number; chunks: number };
    uploadId = data.uploadId;
    chunkSize = data.chunkSize;
    chunks = data.chunks;
    received = Array(chunks).fill(false);
    sessions.set(key, uploadId);
  }
  const pending: number[] = [];
  for (let i = 0; i < chunks; i++) if (!received[i]) pending.push(i);
  let receivedBytes = received.reduce(
    (a, r, i) => a + (r ? Math.min(chunkSize, file.size - i * chunkSize) : 0), 0,
  );
  const report = () => onProgress?.(Math.round((receivedBytes / file.size) * 100));
  report();
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const i = pending[cursor++];
      const blob = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const put = await fetch(`/api/uploads/${uploadId}/chunks/${i}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob,
          });
          if (!put.ok) throw await bodyError(put, `Chunk ${i} failed`);
          lastError = null;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error('Chunk upload failed');
          if ((lastError as UploadHttpError).status === 401) throw lastError;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (lastError) throw lastError;
      receivedBytes += blob.size;
      report();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const done = await fetch(`/api/uploads/${uploadId}/complete`, { method: 'POST' });
  if (!done.ok) throw await bodyError(done, 'Finalize failed');
  const { path } = (await done.json()) as { path: string };
  sessions.delete(key);
  onProgress?.(100);
  return { uploadId, path };
}
