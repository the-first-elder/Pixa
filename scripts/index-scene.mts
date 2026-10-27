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
const maxFrames = Math.max(1, parseInt(arg('max-frames', '12')!, 10));
const confirmed = process.argv.includes('--yes');
if (!sceneId || !framesDir) {
  console.error('Usage: index-scene.mts --scene <id> --frames <dir> [--max-frames 12] [--yes]');
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

// Pass 1: Spark lists visible discrete object categories on a few frames.
const probeFrames = sampled.filter((_, i) => i % Math.max(1, Math.floor(sampled.length / 4)) === 0).slice(0, 4);
console.log(`spark pass on: ${probeFrames.join(', ')}`);
const seen = new Set<string>();
for (const f of probeFrames) {
  const r = await chat({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `List the discrete physical objects visible in this indoor frame as a JSON array of short noun phrases (e.g. ["bed","chair","door"]). Only clearly visible objects. No explanation.` },
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
  });
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
const labels = [...seen].slice(0, 8);
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
const detections: Detection[] = [];
for (const label of labels) {
  for (const f of sampled) {
    const frameIdx = parseInt(basename(f, '.jpg'), 10);
    const seg = await segmentImage({ image: `data:image/jpeg;base64,${b64(f)}`, prompt: label });
    if (seg.boxes.length > 0) {
      detections.push({ frame: f, frameIdx, label, boxes: seg.boxes });
      console.log(`  ${label} @${f}: ${seg.boxes.length} box(es)`);
    }
  }
}

// Merge: one entity per label with all supporting frames.
const byLabel = new Map<string, Detection[]>();
for (const d of detections) {
  if (!byLabel.has(d.label)) byLabel.set(d.label, []);
  byLabel.get(d.label)!.push(d);
}
const entities = [...byLabel.entries()].map(([label, ds], i) => ({
  id: `obj_${String(i + 1).padStart(2, '0')}`,
  type: 'object',
  label,
  status: 'identified',
  position: null as null,
  evidence: { frames: [...new Set(ds.map((d) => d.frameIdx))].sort((a, b) => a - b) },
}));

// Persist index + sidecar + frame copies for evidence thumbnails.
const indexDir = join(storage, 'index');
mkdirSync(indexDir, { recursive: true });
writeFileSync(join(indexDir, `${sceneId}.json`), JSON.stringify({ entities, relationships: [], viewpoints: [] }, null, 2));
writeFileSync(join(indexDir, `${sceneId}.detections.json`), JSON.stringify(detections, null, 2));
const framesOut = join(storage, 'assets', sceneId, 'frames');
mkdirSync(framesOut, { recursive: true });
for (const f of sampled) {
  const dest = join(framesOut, f);
  if (!existsSync(dest)) copyFileSync(join(framesDir, f), dest);
}
console.log(`index: ${entities.length} entities, ${detections.length} detections -> ${indexDir}/${sceneId}.json`);
