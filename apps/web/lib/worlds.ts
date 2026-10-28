/**
 * My Worlds listing (server-only). Returns the caller's scenes + recordings:
 * own records plus legacy pre-auth records (consistent with canRead).
 * Each entry carries its latest job/segment state for honest status display.
 */
import 'server-only';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from './config';
import { latestJobForScene, type ProcessingJob, type Scene } from './store';
import { getRecording, type Recording } from './recordings';

function load<T>(name: string): Record<string, T> {
  try {
    return JSON.parse(readFileSync(join(STORAGE_DIR, name), 'utf8')) as Record<string, T>;
  } catch {
    return {};
  }
}

function mine<T extends { ownerId?: string | null }>(rec: T, uid: string | null): boolean {
  if (!uid) return true; // single-user mode: everything is yours
  return rec.ownerId == null || rec.ownerId === uid; // own + legacy
}

export interface WorldSceneEntry {
  kind: 'scene';
  id: string;
  name: string;
  createdAt: string;
  visibility: string;
  job: ProcessingJob | null;
  parentRecordingId?: string | null;
  /** Middle evidence frame (most representative view), or null when none. */
  thumb: string | null;
  /** Registered objects, navigation viewpoints, reconstruction coverage %. */
  objects: number;
  views: number;
  coveragePct: number | null;
}

export interface WorldRecordingEntry {
  kind: 'recording';
  id: string;
  name: string;
  createdAt: string;
  recording: Recording;
  /** First available segment thumbnail, or null. */
  thumb: string | null;
}

/** Middle evidence frame for a scene card; null when no frames indexed. */
function sceneThumb(sceneId: string): string | null {
  try {
    const dir = join(STORAGE_DIR, 'assets', sceneId, 'frames');
    const frames = readdirSync(dir).filter((f) => /^\d{4}\.jpg$/.test(f)).sort();
    if (frames.length === 0) return null;
    return `/api/scenes/${encodeURIComponent(sceneId)}/frames/${frames[Math.floor(frames.length / 2)]}`;
  } catch {
    return null;
  }
}

/** Registered objects / viewpoints / coverage from the scene index. */
function sceneStats(sceneId: string): { objects: number; views: number; coveragePct: number | null } {
  try {
    const idx = JSON.parse(readFileSync(join(STORAGE_DIR, 'index', `${sceneId}.json`), 'utf8')) as {
      entities?: { position?: [number, number, number] | null }[];
      viewpoints?: unknown[];
      coverage?: { percent?: number };
    };
    return {
      objects: (idx.entities ?? []).filter((e) => e.position != null).length,
      views: (idx.viewpoints ?? []).length,
      coveragePct: typeof idx.coverage?.percent === 'number' ? Math.round(idx.coverage.percent) : null,
    };
  } catch {
    return { objects: 0, views: 0, coveragePct: null };
  }
}

/** First available segment thumbnail for a recording card. */
function recordingThumb(rec: Recording): string | null {
  for (const seg of rec.manifest?.segments ?? []) {
    const p = join(STORAGE_DIR, 'work', 'analysis', 'thumbs', `${seg.id}.jpg`);
    if (existsSync(p)) return `/api/recordings/${encodeURIComponent(rec.id)}/thumbs/${seg.id}`;
  }
  return null;
}

export function listMyWorlds(uid: string | null): {
  scenes: WorldSceneEntry[];
  recordings: WorldRecordingEntry[];
} {
  const scenes = Object.values(load<Scene>('scenes.json'))
    .filter((s) => mine(s, uid))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((s) => ({
      kind: 'scene' as const,
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      visibility: s.visibility,
      job: latestJobForScene(s.id),
      parentRecordingId: (s as Scene & { parentRecordingId?: string }).parentRecordingId ?? null,
      thumb: sceneThumb(s.id),
      ...sceneStats(s.id),
    }));
  const recordings = Object.values(load<Recording>('recordings.json'))
    .filter((r) => mine(r, uid))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((r) => {
      const full = getRecording(r.id) as Recording;
      return {
        kind: 'recording' as const,
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        recording: full,
        thumb: full ? recordingThumb(full) : null,
      };
    })
    .filter((r) => r.recording != null);
  return { scenes, recordings };
}
