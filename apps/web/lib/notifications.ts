/**
 * User notifications. Persistent, deduplicated, per-owner.
 * Creation is idempotent by dedupeKey: worker restarts, recovery runs, or
 * repeated polls never duplicate. A delivery failure here never reverts a
 * completed reconstruction — notifications only ever reflect stored states.
 *
 * NOTE: intentionally no `server-only` import — this module is unit-tested
 * in plain node (see scripts/test-notifications.mts). It touches only the
 * filesystem under STORAGE_DIR; route handlers remain the access boundary.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageDir } from './paths';

const STORAGE_DIR = storageDir();

export type NotificationKind = 'scene-ready' | 'scene-failed' | 'recording-settled';

export interface Notification {
  id: string;
  ownerId: string;
  kind: NotificationKind;
  projectId: string; // sceneId or recordingId
  projectKind: 'scene' | 'recording';
  projectName: string;
  title: string;
  message: string;
  detail?: string | null; // user-safe failure summary (never raw traces)
  createdAt: string;
  readAt: string | null;
  dedupeKey: string;
}

function load(): Record<string, Notification> {
  try {
    return JSON.parse(readFileSync(join(STORAGE_DIR, 'notifications.json'), 'utf8')) as Record<string, Notification>;
  } catch {
    return {};
  }
}

function save(all: Record<string, Notification>): void {
  mkdirSync(STORAGE_DIR, { recursive: true });
  const tmp = join(tmpdir(), `wl-n-${Date.now()}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, join(STORAGE_DIR, 'notifications.json'));
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function listNotifications(ownerId: string): Notification[] {
  return Object.values(load())
    .filter((n) => n.ownerId === ownerId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 100);
}

export function unreadCount(ownerId: string): number {
  return listNotifications(ownerId).filter((n) => !n.readAt).length;
}

export function markRead(ownerId: string, id: string): Notification | null {
  const all = load();
  const n = all[id];
  if (!n || n.ownerId !== ownerId) return null;
  n.readAt = now();
  save(all);
  return n;
}

function create(n: Omit<Notification, 'id' | 'createdAt' | 'readAt'>): Notification | null {
  const all = load();
  if (Object.values(all).some((x) => x.dedupeKey === n.dedupeKey)) return null;
  const full: Notification = {
    ...n,
    id: `notif_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    createdAt: now(),
    readAt: null,
  };
  all[full.id] = full;
  save(all);
  return full;
}

function readJson(name: string): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(readFileSync(join(STORAGE_DIR, name), 'utf8')) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

/**
 * Sweep jobs + recordings for newly-settled work and create the missing
 * notifications. Safe to call on every read path (GET notifications, worlds
 * page, job polling): idempotent, owner-scoped, legacy skipped (no owner).
 * Returns number created (for tests).
 */
export function ensureNotifications(ownerId: string): number {
  let created = 0;
  const jobs = readJson('jobs.json');
  const scenes = readJson('scenes.json');
  for (const job of Object.values(jobs)) {
    if (job.ownerId !== ownerId) continue;
    if (job.status !== 'ready' && job.status !== 'failed') continue;
    const sceneId = job.sceneId as string;
    const scene = scenes[sceneId] as { name?: string } | undefined;
    // Scene jobs belonging to a recording segment are covered by the
    // recording-level notification instead (no per-segment spam).
    if (scene && (scene as { parentRecordingId?: string }).parentRecordingId) continue;
    const kind: NotificationKind = job.status === 'ready' ? 'scene-ready' : 'scene-failed';
    const n = create({
      ownerId,
      kind,
      projectId: sceneId,
      projectKind: 'scene',
      projectName: (scene?.name as string) ?? 'Your scene',
      title: job.status === 'ready' ? 'Your world is ready' : 'We couldn’t finish building your world',
      message:
        job.status === 'ready'
          ? 'Your 3D scene has finished processing. Open Pixa to explore it.'
          : 'The reconstruction encountered a problem. Your project has been saved, and you can review the details or retry if supported.',
      detail: job.status === 'failed' ? ((job.errorCode as string) ?? null) : null,
      dedupeKey: `job:${job.id as string}:${job.status as string}`,
    });
    if (n) created++;
  }
  const recordings = readJson('recordings.json');
  for (const rec of Object.values(recordings)) {
    if (rec.ownerId !== ownerId) continue;
    const segs = ((rec.manifest as { segments?: { status: string }[] } | null)?.segments ?? []) as {
      status: string;
    }[];
    if (segs.length === 0) continue;
    const terminal = segs.every((s) => s.status === 'ready' || s.status === 'failed');
    if (!terminal) continue;
    const ready = segs.filter((s) => s.status === 'ready').length;
    const failed = segs.length - ready;
    const summary =
      failed === 0
        ? 'ready'
        : ready === 0
          ? 'failed'
          : 'partial';
    const n = create({
      ownerId,
      kind: 'recording-settled',
      projectId: rec.id as string,
      projectKind: 'recording',
      projectName: (rec.name as string) ?? 'Your recording',
      title:
        summary === 'ready'
          ? 'Your world is ready'
          : summary === 'partial'
            ? 'Your world is partially ready'
            : 'We couldn’t finish building your world',
      message:
        summary === 'ready'
          ? `All ${segs.length} segment(s) finished processing. Open Pixa to explore.`
          : summary === 'partial'
            ? `${ready} of ${segs.length} segment(s) finished; ${failed} need attention. Open scenes work independently.`
            : 'The reconstruction encountered a problem. Your project has been saved, and you can review the details or retry if supported.',
      detail: summary === 'ready' ? null : `${failed} segment(s) failed`,
      dedupeKey: `rec:${rec.id as string}:settled:${summary}`,
    });
    if (n) created++;
  }
  return created;
}
