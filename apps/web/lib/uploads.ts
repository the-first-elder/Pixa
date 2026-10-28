/**
 * Resumable upload sessions (server-only). Chunks are written at file offsets
 * (random access, out-of-order safe); nothing larger than one chunk is ever
 * buffered. Sessions + bitmap persist in uploads.json, so resumes survive
 * restarts. Temp data lives under STORAGE_DIR/uploads-tmp (never public).
 */
import 'server-only';
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORAGE_DIR } from './config';

export type UploadStatus = 'active' | 'complete' | 'cancelled';

export interface UploadSession {
  id: string;
  filename: string;
  size: number;
  mime: string;
  chunkSize: number;
  chunks: number;
  received: boolean[];
  receivedBytes: number;
  status: UploadStatus;
  createdAt: string;
  updatedAt: string;
  tmpPath: string;
  finalPath: string | null;
  ownerId?: string | null;
}

export const DEFAULT_CHUNK = 8 * 1024 * 1024;
export const MAX_LONG_BYTES = Number(process.env.WL_MAX_LONG_BYTES ?? 4 * 1024 * 1024 * 1024);
export const RETENTION_H = Number(process.env.WL_UPLOAD_RETENTION_H ?? 24);

function dir(): string {
  mkdirSync(STORAGE_DIR, { recursive: true });
  return STORAGE_DIR;
}

function load(): Record<string, UploadSession> {
  try {
    return JSON.parse(readFileSync(join(dir(), 'uploads.json'), 'utf8')) as Record<string, UploadSession>;
  } catch {
    return {};
  }
}

function save(all: Record<string, UploadSession>): void {
  const tmp = join(tmpdir(), `wl-up-${Date.now()}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, join(dir(), 'uploads.json'));
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function safeExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]{2,4})$/);
  const ext = m ? m[1] : '';
  return ['mp4', 'mov', 'm4v'].includes(ext) ? `.${ext}` : '.mp4';
}

export function createSession(input: { filename: string; size: number; mime?: string; chunkSize?: number; ownerId?: string | null }): UploadSession {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new Error('size must be a positive byte count');
  }
  if (input.size > MAX_LONG_BYTES) {
    throw new Error(`File too large: ${input.size} bytes (limit ${MAX_LONG_BYTES})`);
  }
  const chunkSize = Math.min(
    64 * 1024 * 1024,
    Math.max(1 * 1024 * 1024, Math.floor(input.chunkSize ?? DEFAULT_CHUNK)),
  );
  const chunks = Math.ceil(input.size / chunkSize);
  const all = load();
  const session: UploadSession = {
    id: newId('upload'),
    filename: String(input.filename ?? 'upload').slice(0, 200),
    size: input.size,
    mime: typeof input.mime === 'string' ? input.mime.slice(0, 100) : 'application/octet-stream',
    chunkSize,
    chunks,
    received: Array(chunks).fill(false),
    receivedBytes: 0,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
    tmpPath: join(dir(), 'uploads-tmp', `${newId('parts')}.part`),
    finalPath: null,
    ownerId: input.ownerId ?? null,
  };
  mkdirSync(join(dir(), 'uploads-tmp'), { recursive: true });
  // Pre-allocate the temp file so out-of-order writes land at offsets.
  const fd = openSync(session.tmpPath, 'w');
  try {
    ftruncateSync(fd, input.size);
  } finally {
    closeSync(fd);
  }
  all[session.id] = session;
  save(all);
  sweepOld(all);
  return session;
}

export function getSession(id: string): UploadSession | null {
  return load()[id] ?? null;
}

export function markReceived(id: string, index: number, bytes: number): UploadSession {
  const all = load();
  const s = all[id];
  if (!s) throw new Error('Unknown upload session');
  if (s.status !== 'active') throw new Error(`Upload is ${s.status}, not active`);
  if (!s.received[index]) {
    s.received[index] = true;
    s.receivedBytes += bytes;
  }
  s.updatedAt = now();
  save(all);
  return s;
}

export function completeSession(id: string, finalPath: string): UploadSession {
  const all = load();
  const s = all[id];
  if (!s) throw new Error('Unknown upload session');
  s.status = 'complete';
  s.finalPath = finalPath;
  s.updatedAt = now();
  save(all);
  return s;
}

export function cancelSession(id: string): UploadSession | null {
  const all = load();
  const s = all[id];
  if (!s) return null;
  s.status = 'cancelled';
  s.updatedAt = now();
  save(all);
  return s;
}

/** Delete temp data for old/cancelled sessions. Runs opportunistically. */
export function sweepOld(all?: Record<string, UploadSession>): string[] {
  const sessions = all ?? load();
  const cutoff = Date.now() - RETENTION_H * 3600 * 1000;
  const removed: string[] = [];
  for (const [id, s] of Object.entries(sessions)) {
    const stale = new Date(s.updatedAt).getTime() < cutoff;
    if (s.status === 'cancelled' || (s.status === 'active' && stale) || (s.status === 'complete' && stale)) {
      try {
        if (s.status !== 'complete' && existsSync(s.tmpPath)) unlinkSync(s.tmpPath);
        if (s.status === 'complete' && stale && existsSync(s.tmpPath)) unlinkSync(s.tmpPath);
      } catch {
        // Best effort.
      }
      if (s.status !== 'complete') {
        delete sessions[id];
        removed.push(id);
      }
    }
  }
  save(sessions);
  return removed;
}
