/**
 * Admission-control unit tests (offline, isolated STORAGE_DIR).
 * Seeds jobs.json, asserts active counts + per-owner/global caps.
 * Run: STORAGE_DIR=/tmp/wl-admtest npx tsx scripts/test-admission.mts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert';

const dir = process.env.STORAGE_DIR ?? '/tmp/wl-admtest';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

process.env.WL_MAX_ACTIVE_JOBS = '3';
process.env.WL_MAX_ACTIVE_JOBS_PER_USER = '2';

const job = (id: string, ownerId: string | null, status = 'reconstructing') => ({
  id, sceneId: `scene_${id}`, jobType: 'reconstruction', status,
  progress: 50, startedAt: '2026-10-30T00:00:00Z', completedAt: null,
  errorCode: null, errorMessage: null, diagnostics: null, transitions: [],
  ownerId,
});
writeFileSync(join(dir, 'jobs.json'), JSON.stringify({
  j1: job('j1', 'google:alice'),
  j2: job('j2', 'google:alice'),
  j3: job('j3', 'google:bob'),
  j4: job('j4', 'google:bob', 'ready'),       // terminal: not active
  j5: job('j5', null, 'queued'),              // legacy bucket
  j6: { ...job('j6', 'google:alice'), jobType: 'analysis' }, // not reconstruction
}));

const { activeReconstructionCounts, reconstructionAdmissionError } = await import(
  '../apps/web/lib/store'
);

assert.deepEqual(activeReconstructionCounts('google:alice'), { total: 4, owner: 2 });
assert.deepEqual(activeReconstructionCounts('google:bob'), { total: 4, owner: 1 });
assert.deepEqual(activeReconstructionCounts(null), { total: 4, owner: 1 });
console.log('PASS: active counts (terminal + non-reconstruction excluded)');

const aliceErr = reconstructionAdmissionError('google:alice');
assert.ok(aliceErr && /already have 2/.test(aliceErr), aliceErr);
console.log('PASS: per-owner cap blocks with actionable message');

const bobErr = reconstructionAdmissionError('google:bob');
assert.ok(bobErr && /queue is full \(4 active\)/.test(bobErr), bobErr);
console.log('PASS: global cap blocks when machine saturated');

console.log('RESULT: 3 passed, 0 failed');
