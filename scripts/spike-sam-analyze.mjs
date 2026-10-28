// Offline analysis of spike raw outputs. No API calls.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { decodeMaskToRaster } from '@meta-sam/parser';

const DIR = process.argv[2] ?? '/tmp/sam-spike';
const raw = (t) => readFileSync(`${DIR}/${t}.raw.txt`, 'utf8');

// Parse: <Nf>id<|box;x1=..;..|><|mask;..|> records per line.
function parseBoxes(text) {
  const out = new Map(); // frame -> [{id, box}]
  for (const line of text.split('\n')) {
    const fm = line.match(/^<(\d+)f>/);
    if (!fm) continue;
    const f = parseInt(fm[1], 10);
    const recs = [];
    const re = /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      recs.push({ id: m[1], x1: +m[2], y1: +m[3], x2: +m[4], y2: +m[5] });
    }
    if (recs.length) out.set(f, recs);
  }
  return out;
}

// 1) id=4 (entities) max-jump location.
const ent = parseBoxes(raw('track-entities'));
const t4 = [];
for (const [f, rs] of ent) for (const r of rs) if (r.id === '4') t4.push({ f, ...r });
t4.sort((a, b) => a.f - b.f);
let worst = null;
for (let i = 1; i < t4.length; i++) {
  const df = t4[i].f - t4[i - 1].f;
  const dx = (t4[i].x1 + t4[i].x2) / 2 - (t4[i - 1].x1 + t4[i - 1].x2) / 2;
  const dy = (t4[i].y1 + t4[i].y2) / 2 - (t4[i - 1].y1 + t4[i - 1].y2) / 2;
  const j = Math.hypot(dx, dy) / Math.max(1, df);
  if (!worst || j > worst.j) worst = { j, a: t4[i - 1], b: t4[i] };
}
console.log('id4 worst jump:', JSON.stringify(worst));
// id=4 label? prompts.json order -> id index.
const prompts = JSON.parse(readFileSync(`${DIR}/prompts.json`, 'utf8'));
console.log('id4 prompt:', JSON.stringify(prompts.prompts[3]));

// 2) Render overlays for chosen frames (entities green, person red).
function overlay(frame, tags) {
  const filters = [];
  for (const [t, color] of tags) {
    const boxes = parseBoxes(raw(t)).get(frame) ?? [];
    for (const b of boxes) {
      filters.push(`drawbox=x=${b.x1}:y=${b.y1}:w=${b.x2 - b.x1}:h=${b.y2 - b.y1}:c=${color}:t=3`);
    }
  }
  const vf = `select=eq(n\\,${frame}),${filters.join(',')}`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${DIR}/seg55-75.mp4`, '-vf', vf, '-frames:v', '1', '-pix_fmt', 'yuvj420p', `${DIR}/ov-f${frame}.jpg`]);
  console.log(`overlay frame ${frame}: ${filters.length} boxes`);
}
for (const f of [30, 100, 180, 400, 500]) overlay(f, [['track-entities', 'green'], ['track-person', 'red']]);
// Around the id4 jump:
if (worst) {
  overlay(worst.a.f, [['track-entities', 'green']]);
  overlay(worst.b.f, [['track-entities', 'green']]);
}

// 3) Per-frame UNION person fraction (raster OR per frame).
function parseMasks(text) {
  const out = new Map(); // frame -> [maskPayloadStr...] — need full token for decoder
  for (const line of text.split('\n')) {
    const fm = line.match(/^<(\d+)f>/);
    if (!fm) continue;
    const f = parseInt(fm[1], 10);
    const re = /<\|mask;x=(\d+);y=(\d+);(?:c=[\d.]+;)?data=([^|]*)\|>/g;
    let m;
    const arr = out.get(f) ?? [];
    while ((m = re.exec(line)) !== null) {
      arr.push({ x: +m[1], y: +m[2], raw: m[0] });
    }
    out.set(f, arr);
  }
  return out;
}
// Mask payloads are base85 and may contain '|'\u2014never split tokens by hand.
// Replay the saved raw text through the official parser with a proper event
// envelope, then OR each record's raster (placed at its bounds) per frame.
const { parseVideoStream: parseVS, recordsOfKind: rok } = await import('@meta-sam/parser');
const fullText = raw('track-person');
async function* fakeEvents() {
  const lane = { item_id: 'spike', output_index: 0, content_index: 0 };
  for (const line of fullText.split('\n')) {
    if (line.trim()) yield { type: 'response.output_text.delta', delta: line + '\n', ...lane };
  }
  yield { type: 'response.output_text.done', text: fullText, ...lane };
  yield { type: 'response.completed' };
}
const vres = await parseVS(fakeEvents()).finalResult;
console.log('reparse:', vres.outcome.status, 'records:', vres.records.length, 'diags:', vres.diagnostics.length);
const { W: FW, H: FH } = prompts;
const perFrame = new Map();
let maskCount = 0, badMasks = 0;
for (const m of rok(vres.records, 'mask')) {
  try {
    const raster = decodeMaskToRaster(m.mask);
    const { left, top, right, bottom } = m.bounds;
    let or = perFrame.get(m.frame.frameIndex);
    if (!or) { or = new Uint8Array(FW * FH); perFrame.set(m.frame.frameIndex, or); }
    const w = right - left, h = bottom - top;
    for (let r = 0; r < h && r * w < raster.length; r++) {
      for (let c = 0; c < w; c++) {
        if (raster[r * w + c]) {
          const px = (left + c) + (top + r) * FW;
          if (px >= 0 && px < or.length) or[px] = 1;
        }
      }
    }
    maskCount++;
  } catch { badMasks++; }
}
console.log(`person masks placed: ${maskCount}, undecodable: ${badMasks}`);
let sum = 0, over50 = 0;
for (const [f, or] of perFrame) {
  let n = 0;
  for (let i = 0; i < or.length; i++) n += or[i];
  const frac = n / or.length;
  sum += frac;
  if (frac > 0.5) over50++;
}
console.log(`person UNION: ${perFrame.size} frames, mean union fraction ${(sum / perFrame.size).toFixed(4)}, frames>50%: ${over50}`);
writeFileSync(`${DIR}/union.json`, JSON.stringify({ frames: perFrame.size, mean: sum / perFrame.size, over50 }));
