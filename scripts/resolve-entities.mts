/**
 * Entity resolution: merge near-duplicate labels (Stage 4).
 * Run: npx tsx scripts/resolve-entities.mts --scene <id> [--yes]
 * Merge rule: one label contains the other (min 4 chars) AND their evidence
 * frames overlap OR one is unregistered. Keeps the registered entity (or the
 * one with more evidence), unions evidence, remaps relationships, rewrites
 * the detections sidecar. Drops stale type=region entities (graph rebuild
 * re-proposes them cleanly).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sceneId = arg('scene');
if (!sceneId) {
  console.error('Usage: resolve-entities.mts --scene <id> [--yes]');
  process.exit(2);
}
const confirmed = process.argv.includes('--yes');
const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');

interface Entity {
  id: string; type: string; label: string; status: string;
  position: [number, number, number] | null;
  spatialRegistrationStatus?: string; coordinateProvenance?: string | null;
  evidence: { frames: number[] };
}
interface Relationship { source: string; target: string; type: string; status: string }
const indexPath = join(storage, 'index', `${sceneId}.json`);
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  entities: Entity[]; relationships: Relationship[]; viewpoints: unknown[]; coverage?: unknown;
};
const detPath = join(storage, 'index', `${sceneId}.detections.json`);
const detections = JSON.parse(readFileSync(detPath, 'utf8')) as { label: string; [k: string]: unknown }[];

const objects = index.entities.filter((e) => e.type !== 'region');
// Same thing, different phrase: single words where one contains the other
// ("bag"/"handbag"), or multi-word labels sharing the head noun
// ("clothes drying rack"/"drying rack"). "Clothes rack" vs "clothes"
// (different heads) must NOT merge.
const head = (s: string) => s.trim().toLowerCase().split(/\s+/).slice(-1)[0];
const sameThing = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return true;
  const xa = x.split(/\s+/), ya = y.split(/\s+/);
  if (xa.length === 1 && ya.length === 1) {
    // Same head concept only when the shorter is a SUFFIX ("bag" in "handbag").
    // Prefix overlap ("clothes" in "clothespin") is a different word family.
    const [s, l] = xa[0].length <= ya[0].length ? [xa[0], ya[0]] : [ya[0], xa[0]];
    return l.endsWith(s);
  }
  return head(x) === head(y);
};
const groups: Entity[][] = [];
const used = new Set<string>();
for (const e of objects) {
  if (used.has(e.id)) continue;
  const group = [e];
  used.add(e.id);
  for (const o of objects) {
    if (used.has(o.id)) continue;
    if (!sameThing(e.label, o.label)) continue;
    // Same phrase must also co-occur: two same-named things in disjoint
    // frames may be two instances, not one entity.
    const overlap = e.evidence.frames.filter((f) => o.evidence.frames.includes(f)).length;
    if (overlap > 0) {
      group.push(o);
      used.add(o.id);
    }
  }
  groups.push(group);
}
const remap = new Map<string, string>(); // dropped id -> kept id
const kept: Entity[] = [];
for (const g of groups) {
  if (g.length === 1) {
    kept.push(g[0]);
    continue;
  }
  const sorted = [...g].sort((a, b) =>
    Number(b.position !== null) - Number(a.position !== null) ||
    b.evidence.frames.length - a.evidence.frames.length,
  );
  const keep = sorted[0];
  const frames = [...new Set(sorted.flatMap((e) => e.evidence.frames))].sort((a, b) => a - b);
  keep.evidence = { frames };
  kept.push(keep);
  for (const d of sorted.slice(1)) {
    remap.set(d.id, keep.id);
    console.log(`  merge: "${d.label}" (${d.id}) -> "${keep.label}" (${keep.id})`);
  }
}
if (remap.size > 0 && !confirmed) {
  console.log('Dry run. Re-run with --yes to write.');
  process.exit(0);
}
if (remap.size === 0) {
  console.log('No duplicates found.');
}
// Always dedupe the sidecar (merges can duplicate entries across runs).
const seenDet = new Set<string>();
const uniq = detections.filter((d) => {
  const k = `${d.label}|${d.frame}|${JSON.stringify(d.boxes)}`;
  if (seenDet.has(k)) return false;
  seenDet.add(k);
  return true;
});
const droppedDupes = detections.length - uniq.length;
detections.length = 0;
detections.push(...uniq);
if ((remap.size > 0 || droppedDupes > 0) && confirmed) {
  const relabel = (id: string) => remap.get(id) ?? id;
  index.entities = kept;
  index.relationships = index.relationships
    .map((r) => ({ ...r, source: relabel(r.source), target: relabel(r.target) }))
    .filter((r, i, arr) => arr.findIndex((x) => x.source === r.source && x.target === r.target && x.type === r.type) === i)
    .filter((r) => r.source !== r.target);
  const keptLabels = new Set(kept.map((e) => e.label));
  void keptLabels;
  // Rebuild detections labels via id remap table on labels:
  const droppedLabels = new Map<string, string>();
  for (const [did, kid] of remap.entries()) {
    const dl = groups.flat().find((e) => e.id === did)?.label;
    const kl = kept.find((e) => e.id === kid)?.label;
    if (dl && kl) droppedLabels.set(dl, kl);
  }
  for (const d of detections) {
    const nl = droppedLabels.get(d.label);
    if (nl) d.label = nl;
  }
  // Drop exact-duplicate detections created by the relabel.
  const seenDet = new Set<string>();
  const uniq = detections.filter((d) => {
    const k = `${d.label}|${d.frame}|${JSON.stringify(d.boxes)}`;
    if (seenDet.has(k)) return false;
    seenDet.add(k);
    return true;
  });
  detections.length = 0;
  detections.push(...uniq);
  for (const e of kept) {
    e.evidence = { frames: [...new Set(e.evidence.frames)].sort((a, b) => a - b) };
  }
  writeFileSync(indexPath, JSON.stringify({ ...index, entities: kept }, null, 2));
  writeFileSync(detPath, JSON.stringify(detections, null, 2));
  console.log(`merged ${remap.size}, entities now ${kept.length}`);
}
