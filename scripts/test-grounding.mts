/**
 * Grounding matcher unit tests (offline, pure functions).
 * Run: npx tsx scripts/test-grounding.mts
 * Covers attribute-aware matching ("the blue towel"), plural tolerance,
 * and ambiguity flagging (never silently pick one of several instances).
 */
import assert from 'node:assert';
import { matchEntities, type SceneIndex, type IndexEntity } from '../apps/web/lib/scene-index';

const ent = (id: string, label: string, position: [number, number, number] | null = [0, 0, 0]): IndexEntity => ({
  id, type: 'object', label, status: 'identified', position,
  evidence: { frames: [1] },
} as IndexEntity);

const index = {
  status: 'partial',
  entities: [
    ent('t1', 'towel'),
    ent('t2', 'blue towel'),
    ent('c1', 'chair'),
    ent('c2', 'chair'),
    ent('b1', 'bed'),
  ],
  relationships: [],
  viewpoints: [],
} as unknown as SceneIndex;

// Attribute in the label wins.
let m = matchEntities(index, 'blue towel');
assert.equal(m.matches[0]?.id, 't2');
assert.deepEqual(m.attributes, ['blue']);
console.log('PASS: attribute phrase ranks the blue instance first');

// Plural + bare noun matches all instances, flagged ambiguous.
m = matchEntities(index, 'towels');
assert.equal(m.matches.length, 2);
assert.equal(m.ambiguous, true);
console.log('PASS: plural noun matches all, ambiguous flagged');

// Two identical labels, no discriminator -> ambiguous, both returned.
m = matchEntities(index, 'chair');
assert.equal(m.matches.length, 2);
assert.equal(m.ambiguous, true);
console.log('PASS: identical instances flagged ambiguous (no silent pick)');

// Attribute with no labeled instance: noun matches stand, not ambiguous
// beyond instance count (caller explains via evidence frames).
m = matchEntities(index, 'red chair');
assert.equal(m.matches.length, 2);
assert.deepEqual(m.attributes, ['red']);
console.log('PASS: unverifiable attribute keeps noun matches + attribute noted');

// Single match is unambiguous; unknown noun matches nothing.
m = matchEntities(index, 'bed');
assert.equal(m.matches.length, 1);
assert.equal(m.ambiguous, false);
m = matchEntities(index, 'spaceship');
assert.equal(m.matches.length, 0);
console.log('PASS: single match clear, unknown noun empty');

console.log('RESULT: 5 passed, 0 failed');
