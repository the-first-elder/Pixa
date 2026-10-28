/**
 * SPIKE: SAM 3.1 video tracking for entity association + dynamic masking.
 * Run: META_API_KEY=... npx tsx scripts/spike-sam-track.mts --clip <mp4> --frames-dir <workspace/images> [--yes]
 *
 * Phase 1: upload clip once (Files API, purpose=user_data).
 * Phase 2: Spark labels + SAM boxes on 2 discovery frames (cheap image calls).
 * Phase 3A: ONE box-prompted video request tracks all entities (stable IDs?).
 * Phase 3B: ONE concept video request tracks "person" (dynamic masking input).
 * Phase 4 (offline): continuity/coverage stats + masked fractions + billed cost.
 *
 * Mapping: recon frame N (1-based, gaps where blur-dropped) shot at t=(N-1)/2s
 * at 2fps extraction -> source frame (N-1)*15 at 30fps. Verified, not assumed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const clip = arg('clip');
const framesDir = arg('frames-dir');
const srcFps = parseFloat(arg('src-fps', '30')!);
const extractFps = parseFloat(arg('extract-fps', '2')!);
const maxLabels = Math.max(1, parseInt(arg('max-labels', '8')!, 10));
const discoverList = (arg('discover-frames', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const outDir = arg('out', '/tmp/sam-spike')!;
const srcOffset = parseInt(arg('src-offset', '0')!, 10); // when --clip is a cut: its frame 0 == full-clip frame N
const reuseFileId = arg('file-id');
const confirmed = process.argv.includes('--yes');
if (!clip || !framesDir) {
  console.error('Usage: spike-sam-track.mts --clip <mp4> --frames-dir <dir> [--discover-frames 0011,0125] [--yes]');
  process.exit(2);
}

/** Recon frame number (1-based, from %04d name) -> given-clip frame index. */
const reconToSrc = (n: number) => Math.round(((n - 1) / extractFps) * srcFps) - srcOffset;

// Verify media geometry + length with ffprobe (prompts need exact w/h).
const probe = JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,nb_frames,duration,avg_frame_rate',
  '-of', 'json', clip,
]).toString()) as { streams: [{ width: number; height: number; nb_frames: string; duration: string; avg_frame_rate: string }] };
const vs = probe.streams[0];
const W = vs.width, H = vs.height;
const [afpsN, afpsD] = vs.avg_frame_rate.split('/').map(Number);
const realFps = afpsN / afpsD;
const totalFrames = parseInt(vs.nb_frames, 10);
if (Math.abs(realFps - srcFps) > 0.5 || !Number.isFinite(totalFrames)) {
  console.error(`fps/frame-count mismatch: claimed ${srcFps}fps, file is ${realFps.toFixed(2)}fps with ${vs.nb_frames} frames. Pass --src-fps explicitly.`);
  process.exit(2);
}
console.log(`clip: ${W}x${H} ${realFps.toFixed(2)}fps ${totalFrames} frames (${vs.duration}s)`);

// Discovery frames default: early + late, must exist (blur gaps!).
const avail = new Set(
  execFileSync('ls', [framesDir]).toString().split('\n').filter((f) => f.endsWith('.jpg')),
);
let discover = (discoverList.length > 0 ? discoverList : ['0011.jpg', '0125.jpg'])
  .map((f) => (f.endsWith('.jpg') ? f : `${f}.jpg`));
discover = discover.filter((f) => avail.has(f));
if (discover.length === 0) {
  console.error(`No discovery frames present. Available head: ${[...avail].slice(0, 5).join(',')}`);
  process.exit(2);
}
console.log(`discovery frames: ${discover.join(', ')} -> src frames ${discover.map((f) => reconToSrc(parseInt(f, 10))).join(',')}`);

const { loadConfig, chat, segmentImage } = await import('@pixa/model-adapters');
const { metaFetch, throwIfError } = await import('@pixa/model-adapters/src/config.js');
const { buildObjectPrompt, parseVideoStream, recordsOfKind, decodeMaskToRaster } = await import('@meta-sam/parser');
const config = loadConfig(); // throws if META_API_KEY missing

// Cost estimate BEFORE spending.
const estVideoFrames = totalFrames * 2; // track A + person B
const estCost = (estVideoFrames / 1000) * 0.2 + ((maxLabels * discover.length) / 1000) * 2.5;
console.log(`est: 2 video tracks x ${totalFrames} frames + ${maxLabels * discover.length} discovery images ≈ $${estCost.toFixed(2)}`);
if (!confirmed) {
  console.log('Re-run with --yes to spend.');
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });

// --- Phase 1: upload once (or reuse) ---
let fileId = reuseFileId;
if (!fileId) {
  console.log('uploading clip...');
  const form = new FormData();
  form.set('purpose', 'user_data');
  form.set('file', new Blob([readFileSync(clip)]), basename(clip));
  const upRes = await metaFetch(config, '/files', { method: 'POST', body: form });
  await throwIfError(upRes);
  fileId = ((await upRes.json()) as { id: string }).id;
}
console.log(`file_id: ${fileId}`);

/** Stream a video segmentation request; returns raw text + parsed result + usage. */
async function trackVideo(promptText: string, tag: string) {
  const res = await metaFetch(config, '/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: config.samModel,
      stream: true,
      metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: promptText },
          { type: 'input_video', file_id: fileId },
        ],
      }],
    }),
  });
  await throwIfError(res);
  // SSE -> event objects for the parser.
  let events = 0;
  let usage: unknown = null;
  const t0 = Date.now();
  async function* sseEvents(): AsyncGenerator<Record<string, unknown>> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop()!;
      for (const part of parts) {
        for (const line of part.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const ev = JSON.parse(data) as Record<string, unknown>;
            events++;
            if (ev.usage) usage = ev.usage;
            if (ev.type === 'response.completed' && (ev.response as Record<string, unknown> | undefined)?.usage) {
              usage = ((ev.response as Record<string, unknown>).usage);
            }
            if (events % 200 === 0) console.log(`  ${tag}: ${events} events, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
            yield ev;
          } catch { /* keep-alive / partial */ }
        }
      }
    }
  }
  const parsed = parseVideoStream(sseEvents() as never);
  const result = await parsed.finalResult as {
    outcome: { status: string; reason?: string };
    records: unknown[];
    diagnostics: unknown[];
    rawOutput: string;
  };
  writeFileSync(join(outDir, `${tag}.raw.txt`), result.rawOutput);
  if (usage) writeFileSync(join(outDir, `${tag}.usage.json`), JSON.stringify(usage, null, 2));
  console.log(`${tag}: outcome=${result.outcome.status} records=${result.records.length} diagnostics=${(result.diagnostics as unknown[]).length} rawBytes=${result.rawOutput.length} usage=${JSON.stringify(usage) ?? 'n/a'}`);
  return result;
}

// --- Phase 2: discovery (Spark labels + SAM boxes on 2 frames) ---
const b64 = (f: string) => readFileSync(join(framesDir, f)).toString('base64');
const seen = new Set<string>();
for (const f of discover) {
  const r = await chat({
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'List the distinct physical object categories visible in this indoor frame as a JSON array of short canonical noun phrases (e.g. ["bed","chair","door"]). Merge synonyms; skip walls/floor/ceiling unless a distinct fixture; only clearly visible objects.' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64(f)}` } },
    ] }],
    responseFormat: { type: 'json_schema', json_schema: { name: 'o', schema: { type: 'object', properties: { objects: { type: 'array', items: { type: 'string' } } }, required: ['objects'], additionalProperties: false } } },
    maxTokens: 4096, // Spark reasons first (~300 tok); small budgets starve output -> null content
  });
  if (r.content == null) {
    console.log(`  spark null content for ${f} (reasoning starved), skipping`);
    continue;
  }
  try {
    for (const o of (JSON.parse(r.content) as { objects?: string[] }).objects ?? []) {
      const l = o.trim().toLowerCase();
      if (l) seen.add(l);
    }
  } catch { console.log(`  spark unparseable for ${f}`); }
}
const labels = [...seen].slice(0, maxLabels);
console.log(`labels: ${labels.join(', ')}`);

interface BoxPrompt { label: string; recon: string; src: number; box: { xMin: number; yMin: number; xMax: number; yMax: number } }
const prompts: BoxPrompt[] = [];
for (const label of labels) {
  for (const f of discover) {
    if (prompts.length >= 14) break;
    const seg = await segmentImage({ image: `data:image/jpeg;base64,${b64(f)}`, prompt: label });
    // Discovery JPEGs are extraction crops of source frames: same pixels (no
    // resize at 478px < 2048 cap), so box coords transfer 1:1. Verified below.
    for (const b of seg.boxes.slice(0, 2)) {
      if (prompts.length >= 14) break;
      prompts.push({ label, recon: f, src: reconToSrc(parseInt(f, 10)), box: b });
    }
    if (seg.boxes.length > 0) console.log(`  ${label} @${f}: ${seg.boxes.length} box(es)`);
  }
}
// Verify the 1:1 coord assumption: discovery JPEG dims must equal source dims.
const dj = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'json', join(framesDir, discover[0])]).toString()) as { streams: [{ width: number; height: number }] };
if (dj.streams[0].width !== W || dj.streams[0].height !== H) {
  console.error(`COORD MISMATCH: discovery ${dj.streams[0].width}x${dj.streams[0].height} vs source ${W}x${H} — box transfer invalid. Aborting before video spend.`);
  process.exit(2);
}
const inRange = prompts.filter((p) => p.src >= 0 && p.src < totalFrames);
if (inRange.length !== prompts.length) console.log(`dropped ${prompts.length - inRange.length} prompts outside clip range`);
prompts.length = 0;
prompts.push(...inRange);
console.log(`coord check ok: discovery == source == ${W}x${H}; ${prompts.length} box prompts`);
if (prompts.length === 0) {
  console.error('No discovery boxes — nothing to track. Aborting before video spend.');
  process.exit(2);
}
writeFileSync(join(outDir, 'prompts.json'), JSON.stringify({ labels, prompts, W, H }, null, 2));

// --- Phase 3A: track all entities in ONE request (prompt予算 ≤16 objects) ---
// One prompted object per (label, discovery-frame) box, capped at 14.
const promptText = buildObjectPrompt({
  size: { width: W, height: H },
  objects: prompts.map((p, i) => ({
    id: i + 1,
    prompts: [{ frame: p.src, box: { left: Math.floor(p.box.xMin), top: Math.floor(p.box.yMin), right: Math.ceil(p.box.xMax) + 1, bottom: Math.ceil(p.box.yMax) + 1 } }],
  })),
});
console.log(`object prompt bytes: ${promptText.length}`);
const trackA = await trackVideo(promptText, 'track-entities');

// --- Phase 3B: person concept track (dynamic masking input) ---
const trackB = await trackVideo('person', 'track-person');

// --- Phase 4: offline analysis ---
interface BoxRec { objectId: string; frame?: { frameIndex: number }; left: number; top: number; right: number; bottom: number; confidence?: number }
function analyzeBoxes(tag: string, result: { records: unknown[] }) {
  const boxes = recordsOfKind(result.records as never, 'box') as unknown as BoxRec[];
  const byObj = new Map<string, BoxRec[]>();
  for (const b of boxes) {
    if (b.frame == null) continue;
    if (!byObj.has(b.objectId)) byObj.set(b.objectId, []);
    byObj.get(b.objectId)!.push(b);
  }
  const rows: string[] = [`${tag}: ${boxes.length} box records, ${byObj.size} object ids`];
  for (const [id, bs] of [...byObj.entries()].sort()) {
    bs.sort((a, b2) => a.frame!.frameIndex - b2.frame!.frameIndex);
    const frames = bs.map((b) => b.frame!.frameIndex);
    const coverage = frames.length / totalFrames;
    // Center jumps between consecutive records (ID-switch / occlusion smell test).
    const jumps: number[] = [];
    for (let i = 1; i < bs.length; i++) {
      const df = frames[i] - frames[i - 1];
      const dx = (bs[i].left + bs[i].right) / 2 - (bs[i - 1].left + bs[i - 1].right) / 2;
      const dy = (bs[i].top + bs[i].bottom) / 2 - (bs[i - 1].top + bs[i - 1].bottom) / 2;
      jumps.push(Math.hypot(dx, dy) / Math.max(1, df));
    }
    jumps.sort((a, b2) => a - b2);
    const med = jumps.length ? jumps[Math.floor(jumps.length / 2)] : 0;
    const p99 = jumps.length ? jumps[Math.floor(jumps.length * 0.99)] : 0;
    const conf = bs.map((b) => b.confidence ?? -1).filter((c) => c >= 0);
    const meanConf = conf.length ? (conf.reduce((a, b2) => a + b2, 0) / conf.length).toFixed(2) : 'n/a';
    rows.push(`  id=${id} frames=${frames.length} (${(coverage * 100).toFixed(1)}%) range=${frames[0]}..${frames[frames.length - 1]} jumpMed=${med.toFixed(1)}px/f jumpP99=${p99.toFixed(1)}px/f conf=${meanConf}`);
  }
  return rows.join('\n');
}
console.log(analyzeBoxes('A entities', trackA));
console.log(analyzeBoxes('B person', trackB));

// Masked fractions for person track (decode every mask raster — 478x850 is small).
interface MaskRec { frame?: { frameIndex: number }; mask: never }
const personMasks = recordsOfKind(trackB.records as never, 'mask') as unknown as MaskRec[];
let pxSum = 0, framesWithPerson = new Set<number>();
for (const m of personMasks) {
  try {
    const raster = decodeMaskToRaster(m.mask);
    let n = 0;
    for (let i = 0; i < raster.length; i++) n += raster[i];
    pxSum += n / raster.length;
    if (m.frame) framesWithPerson.add(m.frame.frameIndex);
  } catch { /* invalid payload counted as miss */ }
}
const meanFrac = personMasks.length ? pxSum / personMasks.length : 0;
console.log(`person masks: ${personMasks.length} records on ${framesWithPerson.size}/${totalFrames} frames, mean masked fraction ${meanFrac.toFixed(4)}`);
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
  clip, W, H, totalFrames, labels, promptCount: prompts.length,
  entitiesOutcome: trackA.outcome, personOutcome: trackB.outcome,
  estCostUsd: estCost,
}, null, 2));
console.log(`done. artifacts in ${outDir}`);
