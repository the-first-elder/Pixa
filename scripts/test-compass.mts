/**
 * Coverage compass logic unit tests (offline, pure functions).
 * Run: npx tsx scripts/test-compass.mts
 * Covers relative sectors, dwell-based coverage, largest-gap hints, tilt.
 */
import assert from 'node:assert';
import {
  SECTORS, DWELL_MS, sectorFor, accumulateDwell, coveredFromDwell,
  largestGapHint, tiltFlags,
} from '../apps/web/lib/coverage-logic';

// Sectors are relative to start heading, not absolute compass points.
assert.equal(sectorFor(10, 10), 0);          // facing start = ahead
assert.equal(sectorFor(100, 10), 3);         // +90° = right
assert.equal(sectorFor(280, 10), 9);         // -90° wraps to left
assert.equal(sectorFor(370, 10), 0);         // wrap-around
console.log('PASS: sectors relative to start heading');

// A sweep doesn't cover; dwell does.
const dwell = Array(SECTORS).fill(0);
assert.equal(accumulateDwell(dwell, 2, 100, true), false);
assert.equal(coveredFromDwell(dwell)[2], false);
assert.equal(accumulateDwell(dwell, 2, 700, true), false);
assert.equal(accumulateDwell(dwell, 2, 700, true), true); // crosses DWELL_MS
assert.equal(coveredFromDwell(dwell)[2], true);
const dwell2 = Array(SECTORS).fill(0);
assert.equal(accumulateDwell(dwell2, 2, DWELL_MS * 2, false), false); // bad quality never counts
assert.equal(accumulateDwell(dwell2, 2, 5000, true), false);           // huge delta (tab stall) ignored
console.log('PASS: dwell-based coverage (sweeps and bad quality do not count)');

// Largest gap hint names the middle of the biggest hole, relatively.
const covered = Array(SECTORS).fill(false);
covered[0] = covered[1] = covered[2] = true; // filmed ahead..right
const hint = largestGapHint(covered);
assert.ok(hint && /behind|left/.test(hint), String(hint));
assert.equal(largestGapHint(Array(SECTORS).fill(true)), null);
assert.equal(largestGapHint(Array(SECTORS).fill(false)), null);
console.log(`PASS: largest-gap hint ("${hint}")`);

// Tilt flags.
assert.deepEqual(tiltFlags(30), { up: true, down: false });
assert.deepEqual(tiltFlags(150), { up: false, down: true });
assert.deepEqual(tiltFlags(90), { up: false, down: false });
assert.deepEqual(tiltFlags(null), { up: false, down: false });
console.log('PASS: tilt flags');

console.log('RESULT: 4 passed, 0 failed');
