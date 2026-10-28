/**
 * Recordings store (server-only). Mirrors worker/store.py recordings schema:
 * a long recording holds a segment manifest; each segment links to its scene
 * + job once processed. Shared coordinate systems are NEVER assumed across
 * scenes — connections are explicit links, not alignment claims.
 */
import 'server-only';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORAGE_DIR } from './config';

export interface Segment {
  id: string;
  start: number;
  end: number;
  origin: string;
  boundary_confidence: string;
  status: string;
  jobId?: string;
  sceneId?: string;
  thumbnail?: string | null;
  warnings: string[];
}

export interface Recording {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  manifest: {
    video: string;
    duration: number;
    width?: number;
    height?: number;
    segments: Segment[];
  } | null;
  connections: unknown[];
}

function load(): Record<string, Recording> {
  try {
    return JSON.parse(readFileSync(join(STORAGE_DIR, 'recordings.json'), 'utf8')) as Record<string, Recording>;
  } catch {
    return {};
  }
}

function save(all: Record<string, Recording>): void {
  mkdirSync(STORAGE_DIR, { recursive: true });
  const tmp = join(tmpdir(), `wl-rec-${Date.now()}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, join(STORAGE_DIR, 'recordings.json'));
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Register an upload as a recording (analysis runs detached afterwards). */
export function createRecording(name: string, videoPath: string): Recording {
  if (!videoPath.startsWith(STORAGE_DIR)) {
    throw new Error('videoPath must live under the configured storage directory');
  }
  const all = load();
  const rec: Recording = {
    id: `rec_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    name,
    status: 'analyzing',
    createdAt: now(),
    manifest: null,
    connections: [],
  };
  (rec as Recording & { sourceVideo?: string }).sourceVideo = videoPath;
  all[rec.id] = rec;
  save(all);
  return rec;
}

export function getRecording(id: string): Recording | null {
  return load()[id] ?? null;
}

export function recordingStatus(rec: Recording): string {
  const segs = rec.manifest?.segments ?? [];
  if (segs.length === 0) return rec.status;
  const states = segs.map((s) => s.status);
  if (states.every((s) => s === 'ready')) return 'ready';
  if (states.some((s) => s === 'failed')) return 'partial';
  if (states.some((s) => !['ready', 'failed', 'proposed'].includes(s))) return 'processing';
  return 'analyzed';
}
