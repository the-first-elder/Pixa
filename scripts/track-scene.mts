/**
 * Track-based scene indexing: workspace frames -> recon clip -> ONE video
 * track request -> per-instance entities + tracks sidecar.
 * Run: npx tsx scripts/track-scene.mts --scene <id> [--yes]
 *
 * Why tracks: per-frame detections associate instances geometrically (fragile
 * with 2+ same-label objects); video tracks return stable per-instance IDs
 * with per-observation confidence.
 *
 * Why a recon clip (not the source): the source is VFR/edit-shifted
 * (measured: workspace 0037 = source frame 546, not (37-1)*15=540), so
 * source-index mapping is unreliable. Re-encoding the workspace JPEGs into
 * a 2fps clip makes track frames identical to recon frames BY CONSTRUCTION
 * (concat order = manifest order), with exact obs->pose lookup, ~16x fewer
 * billed frames, and no chunking (180 frames track in one call).
 * Requires a ready job with poses + workspace images.
 *
 * Writes: STORAGE_DIR/index/<scene>.tracks.json + per-instance entities in
 * <scene>.json (track-sourced entities are replaced each run; frame-path
 * entities and their positions are preserved).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const sceneId = arg('scene');
const maxLabels = Math.max(1, parseInt(arg('max-labels', '10')!, 10));
const maxPrompts = Math.max(1, Math.min(16, parseInt(arg('max-prompts', '14')!, 10))); // SAM cap 16
const confirmed = process.argv.includes('--yes');
if (!sceneId) {
  console.error('Usage: track-scene.mts --scene <id> [--max-labels 10] [--yes]');
  process.exit(2);
}
const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');

const scenes = JSON.parse(readFileSync(join(storage, 'scenes.json'), 'utf8')) as Record<string, { id: string }>;
if (!scenes[sceneId]) {
  console.error(`Unknown scene: ${sceneId}`);
  process.exit(2);
}
const jobs = JSON.parse(readFileSync(join(storage, 'jobs.json'), 'utf8')) as Record<string, {
  sceneId: string; status: string; asset?: { posesPath?: string };
}>;
const job = Object.values(jobs).find((j) => j.sceneId === sceneId && j.status === 'ready' && j.asset?.posesPath);
if (!job?.asset?.posesPath) {
  console.error('No ready job with poses for scene — tracks would be unregistrable. Reconstruct first.');
  process.exit(2);
}
const sparseDir = job.asset.posesPath!;
const imagesDir = join(sparseDir, '..', '..', 'images');
const manifest = JSON.parse(readFileSync(join(imagesDir, 'manifest.json'), 'utf8')) as {
  policy?: string; frames: string[];
};
const frames = manifest.frames.filter((f) => existsSync(join(imagesDir, f)));
if (frames.length < 8) {
  console.error(`Only ${frames.length} workspace frames — need overlapping views.`);
  process.exit(2);
}
console.log(`workspace: ${frames.length} frames (${frames[0]}..${frames[frames.length - 1]})`);

// Recon clip: concat in manifest order. Clip frame j == frames[j] EXACTLY
// (order-preserving demuxer, re-encoded at native dims for 1:1 coords).
const first = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'json', join(imagesDir, frames[0])]).toString()) as { streams: [{ width: number; height: number }] };
const W = first.streams[0].width, H = first.streams[0].height;
const workTmp = join(tmpdir(), `pixa-track-${sceneId}`);
mkdirSync(workTmp, { recursive: true });
const listFile = join(workTmp, 'concat.txt');
writeFileSync(listFile, frames.map((f) => `file '${join(imagesDir, f).replace(/'/g, "'\\''")}'`).join('\n'));
const reconClip = join(workTmp, 'recon.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-framerate', '2', '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', reconClip]);
const cp = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', reconClip]).toString()) as { streams: [{ width: number; height: number; nb_frames: string }] };
if (parseInt(cp.streams[0].nb_frames, 10) !== frames.length || cp.streams[0].width !== W || cp.streams[0].height !== H) {
  console.error(`Recon clip mismatch: ${cp.streams[0].width}x${cp.streams[0].height}x${cp.streams[0].nb_frames} vs ${W}x${H}x${frames.length}. Aborting.`);
  process.exit(2);
}
// Verify frame identity (not just count): clip frame 0 must equal frames[0].
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', reconClip, '-vf', 'select=eq(n\\,0)', '-frames:v', '1', '-pix_fmt', 'yuvj420p', join(workTmp, 'c0.jpg')]);
const ssimProc = spawnSync('ffmpeg', ['-v', 'info', '-i', join(workTmp, 'c0.jpg'), '-i', join(imagesDir, frames[0]),
  '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
const ssimM = (ssimProc.stderr as string).match(/All:([\d.]+)/);
if (!ssimM || parseFloat(ssimM[1]) < 0.95) {
  console.error(`Recon clip frame 0 != ${frames[0]} (SSIM ${ssimM?.[1] ?? 'n/a'}). Aborting — order assumption broken.`);
  process.exit(2);
}
console.log(`recon clip: ${frames.length} frames ${W}x${H}, identity SSIM ${ssimM[1]}`);

const estCost = (frames.length / 1000) * 0.2 + ((maxLabels * 2) / 1000) * 2.5;
console.log(`est: 1 track x ${frames.length} frames + ${maxLabels * 2} discovery images ≈ $${estCost.toFixed(2)}`);
if (!confirmed) {
  console.log('Re-run with --yes to spend.');
  process.exit(0);
}
const { loadConfig, chat, segmentImage, uploadFile, segmentVideo } = await import('@pixa/model-adapters');
const { buildObjectPrompt } = await import('@meta-sam/parser');
const config = loadConfig(); // throws if META_API_KEY missing

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

// Pass 1: Spark labels from 2 workspace frames (early + late).
const SPARK_PROMPT = 'List the distinct physical object categories visible in this indoor frame as a JSON array of short canonical noun phrases (e.g. ["bed","chair","door"]). Rules: merge synonyms into ONE phrase; skip walls/floor/ceiling unless a distinct fixture (window, curtain, air conditioner); only clearly visible objects. No explanation.';
const SCHEMA = { type: 'json_schema', json_schema: { name: 'objects', schema: { type: 'object', properties: { objects: { type: 'array', items: { type: 'string' } } }, required: ['objects'], additionalProperties: false } } } as const;
const djs = [Math.floor(frames.length * 0.05), Math.floor(frames.length * 0.65)];
const seen = new Set<string>();
for (const j of djs) {
  const f = frames[j];
  const r = await withRetry(() => chat({
    messages: [{ role: 'user', content: [
      { type: 'text', text: SPARK_PROMPT },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(join(imagesDir, f)).toString('base64')}` } },
    ] }],
    responseFormat: { ...SCHEMA },
    maxTokens: 4096, // Spark reasons first; small budgets starve output -> null
  }), `spark probe ${f}`);
  if (r.content == null) {
    console.log(`  spark null content for ${f}, skipping`);
    continue;
  }
  try {
    for (const o of (JSON.parse(r.content) as { objects?: string[] }).objects ?? []) {
      const label = o.trim().toLowerCase().replace(/\s+/g, ' ');
      if (label) seen.add(label);
    }
  } catch {
    console.log(`  spark output unparseable for ${f}, skipping`);
  }
}
const labels = [...seen].slice(0, maxLabels);
console.log(`labels: ${labels.join(', ') || '(none)'}`);
if (labels.length === 0) {
  console.error('No labels discovered; nothing to track. Aborting before video spend.');
  process.exit(2);
}

// Pass 2: SAM boxes on the same 2 frames -> prompts (clip coords == JPEG
// coords 1:1 by construction; prompt frame = clip index j).
interface Box { xMin: number; yMin: number; xMax: number; yMax: number }
interface Prompt { label: string; j: number; box: Box }
const prompts: Prompt[] = [];
for (const label of labels) {
  for (const j of djs) {
    if (prompts.length >= maxPrompts) break;
    const f = frames[j];
    const seg = await withRetry(
      () => segmentImage({ image: `data:image/jpeg;base64,${readFileSync(join(imagesDir, f)).toString('base64')}`, prompt: label }),
      `${label} @${f}`,
    );
    for (const b of seg.boxes.slice(0, 2)) {
      if (prompts.length >= maxPrompts) break;
      // Hygiene: SAM 500s on near-degenerate prompt boxes (measured: a 3px
      // edge sliver killed a request). Drop <6px, clamp to frame.
      const x1 = Math.max(0, Math.floor(b.xMin)), y1 = Math.max(0, Math.floor(b.yMin));
      const x2 = Math.min(W - 1, Math.ceil(b.xMax)), y2 = Math.min(H - 1, Math.ceil(b.yMax));
      if (x2 - x1 < 6 || y2 - y1 < 6) continue;
      prompts.push({ label, j, box: { xMin: x1, yMin: y1, xMax: x2, yMax: y2 } });
    }
    if (seg.boxes.length > 0) console.log(`  ${label} @${f}: ${seg.boxes.length} box(es)`);
  }
}
console.log(`prompts: ${prompts.length}`);
if (prompts.length === 0) {
  console.error('No discovery boxes — nothing to track. Aborting before video spend.');
  process.exit(2);
}

// Pass 3: ONE track request over the recon clip.
console.log('uploading recon clip...');
const fileId = await withRetry(
  () => uploadFile(new Uint8Array(readFileSync(reconClip)), 'recon.mp4', config),
  'clip upload', 5, // uploads are free: retry generously
);
const promptText = buildObjectPrompt({
  size: { width: W, height: H },
  objects: prompts.map((p, i) => ({
    id: i + 1,
    prompts: [{ frame: p.j, box: { left: p.box.xMin, top: p.box.yMin, right: p.box.xMax + 1, bottom: p.box.yMax + 1 } }],
  })),
});
// Billed-call retry policy: explicit 5xx = failed server-side, safe to retry
// once. Timeout/abort = unknown outcome, NEVER re-fire (double-spend).
console.log(`tracking ${prompts.length} objects over ${frames.length} frames...`);
const t0 = Date.now();
let tracked: Awaited<ReturnType<typeof segmentVideo>> | null = null;
for (let attempt = 1; attempt <= 2 && !tracked; attempt++) {
  try {
    tracked = await segmentVideo({ fileId, prompt: promptText }, config);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status !== undefined && status >= 500 && attempt < 2) {
      console.log(`  HTTP ${status} (explicit failure, safe retry in 15s)...`);
      await new Promise((r) => setTimeout(r, 15000));
    } else {
      throw e;
    }
  }
}
const done = tracked!;
console.log(`track: outcome=${done.outcome} obs=${done.obs.length} billed=${done.framesProcessed} diags=${done.diagnostics.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
if (done.obs.length === 0) {
  console.error('Track returned zero observations. Aborting (clip was billed; check prompts).');
  process.exit(2);
}
const actualCost = (done.framesProcessed / 1000) * 0.2;
console.log(`video cost: $${actualCost.toFixed(2)}`);

// Group obs by prompted id. Clip frame j == frames[j]; evidence B-numbers
// are the workspace %04d numbers (gaps preserved) — direct pose lookup.
interface Track { id: string; label: string; obs: { j: number; frame: string; m: number; box: Box; c?: number }[] }
const tracks: Track[] = prompts.map((p, i) => ({ id: String(i + 1), label: p.label, obs: [] }));
for (const o of done.obs) {
  const t = tracks[parseInt(o.objectId, 10) - 1];
  const fname = frames[o.frame];
  if (!t || !fname) continue;
  t.obs.push({ j: o.frame, frame: fname, m: parseInt(fname, 10), box: o.box, ...(o.confidence !== undefined ? { c: o.confidence } : {}) });
}
for (const t of tracks) t.obs.sort((a, b) => a.j - b.j);
const live = tracks.filter((t) => t.obs.length > 0);
console.log(`tracks alive: ${live.length}/${tracks.length}`);

const indexDir = join(storage, 'index');
mkdirSync(indexDir, { recursive: true });
writeFileSync(join(indexDir, `${sceneId}.tracks.json`), JSON.stringify({
  clip: { reconClip: true, frames: frames.length, W, H, extraction: manifest.policy ?? null },
  labels,
  prompts: prompts.map((p, i) => ({ id: i + 1, label: p.label, frame: frames[p.j], box: p.box })),
  tracks: live.map((t) => ({ id: t.id, label: t.label, obs: t.obs })),
  billedFrames: done.framesProcessed, costUsd: actualCost,
  createdAt: new Date().toISOString(),
}, null, 2));

interface Entity {
  id: string; type: string; label: string; status: string;
  position: [number, number, number] | null;
  spatialRegistrationStatus?: string; coordinateProvenance?: string | null;
  evidence: { frames: number[] };
  trackId?: string; instance?: number;
}
let prev: { entities: Entity[]; relationships: unknown[]; viewpoints: unknown[]; coverage?: unknown } | null = null;
try {
  prev = JSON.parse(readFileSync(join(indexDir, `${sceneId}.json`), 'utf8'));
} catch { /* first run */ }
const kept = (prev?.entities ?? []).filter((e) => e.trackId === undefined);
let nextN = 1;
for (const e of (prev?.entities ?? [])) {
  const m = e.id.match(/^obj_(\d+)$/);
  if (m) nextN = Math.max(nextN, parseInt(m[1], 10) + 1);
}
const perLabelCount = new Map<string, number>();
const fresh: Entity[] = [];
for (const t of live) {
  const n = (perLabelCount.get(t.label) ?? 0) + 1;
  perLabelCount.set(t.label, n);
  fresh.push({
    id: `obj_${String(nextN++).padStart(2, '0')}`,
    type: 'object', label: t.label, status: 'identified', position: null,
    evidence: { frames: [...new Set(t.obs.map((o) => o.m))].sort((a, b) => a - b) },
    trackId: t.id, instance: n,
  });
}
writeFileSync(join(indexDir, `${sceneId}.json`), JSON.stringify({
  entities: [...kept, ...fresh],
  relationships: prev?.relationships ?? [],
  viewpoints: prev?.viewpoints ?? [],
  ...(prev && 'coverage' in prev ? { coverage: (prev as { coverage: unknown }).coverage } : {}),
}, null, 2));

// Evidence thumbnails: spread-capped at 24 observed frames.
const allB = [...new Set(live.flatMap((t) => t.obs.map((o) => o.m)))].sort((a, b) => a - b);
const step = Math.max(1, Math.floor(allB.length / 24));
const sample = allB.filter((_, i) => i % step === 0).slice(0, 24);
const framesOut = join(storage, 'assets', sceneId, 'frames');
mkdirSync(framesOut, { recursive: true });
for (const m of sample) {
  const name = String(m).padStart(4, '0') + '.jpg';
  const src = join(imagesDir, name);
  const dest = join(framesOut, name);
  if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
}
console.log(`entities: ${fresh.length} fresh tracked instances (+${kept.length} kept), evidence frames sampled: ${sample.length}`);
console.log('Next: npx tsx scripts/register-entities.mts --scene ' + sceneId);
