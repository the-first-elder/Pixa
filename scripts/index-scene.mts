/**
 * Stage 3 scene indexing: frames -> Spark labels -> SAM detections -> index JSON.
 * Run: npx tsx scripts/index-scene.mts --scene <sceneId> --frames <dir> [--max-frames 12] [--yes]
 * Writes STORAGE_DIR/index/<sceneId>.json + copies frames to STORAGE_DIR/assets/<scene>/frames/.
 * Detection only: positions stay null until registration (Stage 3b). Never invents 3D.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const sceneId = arg('scene');
const framesDir = arg('frames');
const maxFrames = Math.max(1, parseInt(arg('max-frames', '16')!, 10)); // detection frames
const maxLabels = Math.max(1, parseInt(arg('max-labels', '16')!, 10)); // distinct categories
const probeCount = Math.max(1, parseInt(arg('probe-frames', '8')!, 10)); // label-discovery frames
const extraPrompts = (arg('extra-prompts', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const confirmed = process.argv.includes('--yes');
if (!sceneId || !framesDir) {
  console.error('Usage: index-scene.mts --scene <id> --frames <dir> [--max-frames 16] [--max-labels 16] [--probe-frames 8] [--extra-prompts tv,remote] [--yes]');
  process.exit(2);
}

const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');
const scenes = JSON.parse(readFileSync(join(storage, 'scenes.json'), 'utf8')) as Record<string, { id: string }>;
if (!scenes[sceneId]) {
  console.error(`Unknown scene: ${sceneId}`);
  process.exit(2);
}

const allFrames = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
const step = Math.max(1, Math.floor(allFrames.length / maxFrames));
const sampled = allFrames.filter((_, i) => i % step === 0).slice(0, maxFrames);
console.log(`frames: ${allFrames.length} total, ${sampled.length} sampled`);

const { chat, segmentImage } = await import('@worldlens/model-adapters');
const b64 = (f: string) => readFileSync(join(framesDir, f)).toString('base64');

// Pass 1: Spark lists distinct object categories across MANY frames so small
// or briefly-visible objects are not missed. Union + canonicalize.
const probeIdx = new Set<number>();
for (let i = 0; i < probeCount; i++) {
  probeIdx.add(Math.min(sampled.length - 1, Math.floor((i * sampled.length) / probeCount)));
}
const probeFrames = [...probeIdx].map((i) => sampled[i]);
console.log(`spark pass on: ${probeFrames.join(', ')}`);
const seen = new Set<string>();
for (const f of probeFrames) {
  let r;
  try {
    r = await withRetry(() => chat({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `List the distinct physical object categories visible in this indoor frame as a JSON array of short canonical noun phrases (e.g. ["bed","chair","door"]). Rules: merge synonyms into ONE phrase (bag/handbag -> "handbag"); skip walls/floor/ceiling unless a distinct fixture (window, curtain, air conditioner); only clearly visible objects. No explanation.` },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64(f)}` } },
        ],
      },
    ],
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'objects',
        schema: { type: 'object', properties: { objects: { type: 'array', items: { type: 'string' } } }, required: ['objects'], additionalProperties: false },
      },
    },
    maxTokens: 2048,
    }), `spark probe ${f}`);
  } catch (e) {
    console.log(`  spark probe failed for ${f}, skipping`);
    continue;
  }
  try {
    const parsed = JSON.parse(r.content ?? '{}') as { objects?: string[] };
    for (const o of parsed.objects ?? []) {
      const label = o.trim().toLowerCase();
      if (label) seen.add(label);
    }
  } catch {
    console.log(`  spark output unparseable for ${f}, skipping`);
  }
}
const canon = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
// Explicit user prompts take priority (they come first so caps never cut them),
// then discovered labels fill the remaining budget.
const labels = [...new Set(extraPrompts.concat([...seen].map(canon)))].filter(Boolean).slice(0, Math.max(maxLabels, extraPrompts.length));
console.log(`labels: ${labels.join(', ') || '(none)'}`);
if (labels.length === 0) {
  console.log('No labels found; writing empty index.');
}

// Pass 2: SAM detection per label per frame.
const calls = labels.length * sampled.length;
const estCost = (calls * 2.5) / 1000;
console.log(`sam calls: ${calls} (~$${estCost.toFixed(2)})`);
if (calls > 0 && !confirmed) {
  console.log('Re-run with --yes to spend.');
  process.exit(0);
}

interface Detection { frame: string; frameIdx: number; label: string; boxes: { xMin: number; yMin: number; xMax: number; yMax: number }[] }

/** Network calls fail sometimes; retry with backoff instead of losing the run. */
async function withRetry<T>(fn: () => Promise<T>, what: string, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const wait = 2000 * (i + 1);
      console.log(`  retry ${i + 1}/${tries} for ${what} after ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

const detections: Detection[] = [];
for (const label of labels) {
  for (const f of sampled) {
    const frameIdx = parseInt(basename(f, '.jpg'), 10);
    const seg = await withRetry(
      () => segmentImage({ image: `data:image/jpeg;base64,${b64(f)}`, prompt: label }),
      `${label} @${f}`,
    );
    if (seg.boxes.length > 0) {
      detections.push({ frame: f, frameIdx, label, boxes: seg.boxes });
      console.log(`  ${label} @${f}: ${seg.boxes.length} box(es)`);
    }
  }
}

// Merge: one entity per label with all supporting frames. Preserve existing
// entities (stable ids, registered positions, provenance) across re-runs;
// only add genuinely new labels.
const byLabel = new Map<string, Detection[]>();
for (const d of detections) {
  if (!byLabel.has(d.label)) byLabel.set(d.label, []);
  byLabel.get(d.label)!.push(d);
}
interface ExistingEntity {
  id: string; type: string; label: string; status: string;
  position: [number, number, number] | null;
  spatialRegistrationStatus?: string; coordinateProvenance?: string | null;
  evidence: { frames: number[] };
}
let prev: { entities: ExistingEntity[]; relationships: unknown[]; viewpoints: unknown[]; coverage?: unknown } | null = null;
try {
  prev = JSON.parse(readFileSync(join(storage, 'index', `${sceneId}.json`), 'utf8'));
} catch { /* first run */ }
const prevByLabel = new Map((prev?.entities ?? []).map((e) => [e.label, e]));
let nextN = 1;
for (const e of prevByLabel.values()) {
  const m = e.id.match(/^obj_(\d+)$/);
  if (m) nextN = Math.max(nextN, parseInt(m[1], 10) + 1);
}
const entities: ExistingEntity[] = [];
for (const [label, ds] of byLabel.entries()) {
  const old = prevByLabel.get(label);
  const frames = [...new Set(ds.map((d) => d.frameIdx))].sort((a, b) => a - b);
  if (old) {
    entities.push({ ...old, evidence: { frames } });
  } else {
    entities.push({
      id: `obj_${String(nextN++).padStart(2, '0')}`,
      type: 'object',
      label,
      status: 'identified',
      position: null,
      evidence: { frames },
    });
  }
}
// Keep previously indexed entities that simply had no detections this pass
// (different sample), so knowledge only grows.
for (const [label, old] of prevByLabel.entries()) {
  if (!byLabel.has(label)) entities.push(old);
}

// Persist index + sidecar + frame copies for evidence thumbnails.
// Existing relationships / viewpoints / coverage are preserved.
const indexDir = join(storage, 'index');
mkdirSync(indexDir, { recursive: true });
writeFileSync(join(indexDir, `${sceneId}.json`), JSON.stringify({
  entities,
  relationships: prev?.relationships ?? [],
  viewpoints: prev?.viewpoints ?? [],
  ...(prev && 'coverage' in prev ? { coverage: (prev as { coverage: unknown }).coverage } : {}),
}, null, 2));
// Merge (not overwrite) the detections sidecar: registration depends on it.
let prevDetections: Detection[] = [];
try {
  prevDetections = JSON.parse(readFileSync(join(indexDir, `${sceneId}.detections.json`), 'utf8'));
} catch { /* first run */ }
const seenD = new Set(detections.map((d) => `${d.label}|${d.frame}|${JSON.stringify(d.boxes)}`));
for (const d of prevDetections) {
  const k = `${d.label}|${d.frame}|${JSON.stringify(d.boxes)}`;
  if (!seenD.has(k)) {
    detections.push(d);
    seenD.add(k);
  }
}
writeFileSync(join(indexDir, `${sceneId}.detections.json`), JSON.stringify(detections, null, 2));
const framesOut = join(storage, 'assets', sceneId, 'frames');
mkdirSync(framesOut, { recursive: true });
for (const f of sampled) {
  const dest = join(framesOut, f);
  if (!existsSync(dest)) copyFileSync(join(framesDir, f), dest);
}
console.log(`index: ${entities.length} entities, ${detections.length} detections -> ${indexDir}/${sceneId}.json`);
