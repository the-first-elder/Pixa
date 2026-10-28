/**
 * My Worlds listing (server-only). Returns the caller's scenes + recordings:
 * own records plus legacy pre-auth records (consistent with canRead).
 * Each entry carries its latest job/segment state for honest status display.
 */
import 'server-only';
import { readFileSync } from 'node:fs';
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
}

export interface WorldRecordingEntry {
  kind: 'recording';
  id: string;
  name: string;
  createdAt: string;
  recording: Recording;
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
    }));
  const recordings = Object.values(load<Recording>('recordings.json'))
    .filter((r) => mine(r, uid))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((r) => ({
      kind: 'recording' as const,
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      recording: getRecording(r.id) as Recording,
    }))
    .filter((r) => r.recording != null);
  return { scenes, recordings };
}
