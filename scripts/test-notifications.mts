/**
 * Notifications unit tests (plain node, isolated STORAGE_DIR).
 * Run: STORAGE_DIR=/tmp/wl-ntest npx tsx scripts/test-notifications.mts
 * Seeds jobs/scenes/recordings, asserts creation, ownership isolation,
 * dedupe/idempotency, partial-success honesty, legacy skip.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert';

const dir = process.env.STORAGE_DIR ?? '/tmp/wl-ntest';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const write = (n: string, o: unknown) => writeFileSync(join(dir, n), JSON.stringify(o));

const UID = 'google:test-user';
const OTHER = 'google:other-user';

write('scenes.json', {
  scene_ready: { id: 'scene_ready', name: 'Done Room', ownerId: UID },
  scene_failed: { id: 'scene_failed', name: 'Bad Room', ownerId: UID },
  scene_legacy: { id: 'scene_legacy', name: 'Old Room' },
  scene_other: { id: 'scene_other', name: 'Theirs', ownerId: OTHER },
});
write('jobs.json', {
  job_ready: { id: 'job_ready', sceneId: 'scene_ready', status: 'ready', ownerId: UID },
  job_failed: { id: 'job_failed', sceneId: 'scene_failed', status: 'failed', errorCode: 'COVERAGE_GAP', ownerId: UID },
  job_active: { id: 'job_active', sceneId: 'scene_ready', status: 'reconstructing', ownerId: UID },
  job_legacy: { id: 'job_legacy', sceneId: 'scene_legacy', status: 'ready' },
  job_other: { id: 'job_other', sceneId: 'scene_other', status: 'ready', ownerId: OTHER },
});
write('recordings.json', {
  rec_partial: {
    id: 'rec_partial', name: 'Walk', ownerId: UID,
    manifest: { segments: [{ id: 'seg_01', status: 'ready' }, { id: 'seg_02', status: 'failed' }] },
  },
  rec_busy: {
    id: 'rec_busy', name: 'Busy', ownerId: UID,
    manifest: { segments: [{ id: 'seg_01', status: 'reconstructing' }] },
  },
  rec_other: {
    id: 'rec_other', name: 'Theirs', ownerId: OTHER,
    manifest: { segments: [{ id: 'seg_01', status: 'ready' }] },
  },
});

const { ensureNotifications, listNotifications, markRead, unreadCount } = await import(
  '../apps/web/lib/notifications.ts'
);

// 1. First sweep creates exactly: scene-ready + scene-failed + 1 partial recording.
const created = ensureNotifications(UID);
assert.equal(created, 3, `expected 3 created, got ${created}`);
assert.equal(listNotifications(UID).length, 3);
assert.equal(unreadCount(UID), 3);
// Other user's items are untouched.
assert.equal(listNotifications(OTHER).length, 0);
// Legacy skipped (no owner to notify).
assert.ok(!listNotifications(UID).some((n) => n.projectId === 'scene_legacy'));
// Partial honesty.
const partial = listNotifications(UID).find((n) => n.projectId === 'rec_partial')!;
assert.equal(partial.title, 'Your world is partially ready');
assert.match(partial.message, /1 of 2/);
// Busy recording: no notification yet.
assert.ok(!listNotifications(UID).some((n) => n.projectId === 'rec_busy'));
// No raw traces in user-facing copy.
for (const n of listNotifications(UID)) {
  assert.ok(!JSON.stringify(n).includes('Traceback'), 'no stack traces');
}

// 2. Idempotency: second sweep creates nothing.
assert.equal(ensureNotifications(UID), 0);
assert.equal(listNotifications(UID).length, 3);

// 3. Read acknowledgment + cross-owner protection.
const first = listNotifications(UID)[0];
assert.ok(markRead(UID, first.id));
assert.equal(unreadCount(UID), 2);
assert.equal(markRead(OTHER, first.id), null);

// 4. Copy check (mission §8.3).
const ready = listNotifications(UID).find((n) => n.kind === 'scene-ready')!;
assert.equal(ready.title, 'Your world is ready');
const failed = listNotifications(UID).find((n) => n.kind === 'scene-failed')!;
assert.equal(failed.title, 'We couldn’t finish building your world');
assert.equal(failed.detail, 'COVERAGE_GAP');

console.log('notifications: 4/4 suites pass (creation, idempotency, read+isolation, copy)');
