/**
 * Verify registered positions by reprojection: project each entity's 3D
 * position back into its evidence frames; report median miss distance to
 * its own observed boxes. Independent recomputation (shares only the
 * colmap-utils math, verified by round-trip at 1e-16) — catches instance
 * swaps, drift, and triangulation collapses that residuals cannot.
 * Bar: median ≤100px (app-grade flight targets). Exact numbers always logged.
 * Run: npx tsx scripts/verify-registration.mts --scene <id> [--overlays <dir>]
 * Reads index JSON + tracks/detections sidecars + COLMAP poses. No API calls.
 */
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadSparse, project, missDistance, type Vec3, type Box } from './colmap-utils.mts';
import { loadMeshAnchor } from './mesh-anchor.mts';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const sceneId = arg('scene');
const overlayDir = arg('overlays');
if (!sceneId) {
  console.error('Usage: verify-registration.mts --scene <id> [--overlays <dir>]');
  process.exit(2);
}
const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');
if (overlayDir) mkdirSync(overlayDir, { recursive: true });

const { sparse, intrinsics, poses } = loadSparse(storage, sceneId);
const wsImages = join(sparse, '..', '..', 'images');

const index = JSON.parse(readFileSync(join(storage, 'index', `${sceneId}.json`), 'utf8')) as {
  entities: { id: string; label: string; position: Vec3 | null; evidence: { frames: number[] }; trackId?: string }[];
};
let tracks: { clip: { reconClip?: boolean; W: number; H: number }; tracks: { id: string; obs: { m: number; box: Box }[] }[] } | null = null;
try {
  tracks = JSON.parse(readFileSync(join(storage, 'index', `${sceneId}.tracks.json`), 'utf8'));
} catch { /* frame-path scene */ }
if (tracks && !tracks.clip.reconClip) {
  console.error('Stale tracks sidecar (source-index mapping — known wrong). Re-run track-scene.mts and retry.');
  process.exit(2);
}
interface Detection { frame: string; frameIdx: number; label: string; boxes: Box[] }
let detections: Detection[] = [];
try {
  detections = JSON.parse(readFileSync(join(storage, 'index', `${sceneId}.detections.json`), 'utf8'));
} catch { /* track-only scene */ }
// Frame-path scale: detection boxes are in detection-image pixels (often
// Pipeline-A, e.g. 1280px); poses/K fit workspace B-frames (e.g. 1600px).
// Derived from the actual files (measured 1.25x on scene_d7259e7e).
let frameScale = 1, frameScaleReady = false;
function detectionScale(): number {
  if (frameScaleReady) return frameScale;
  frameScaleReady = true;
  if (detections.length === 0) return frameScale;
  const jp = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', f]).toString()) as { streams: [{ width: number; height: number }] };
  const a = jp(join(storage, 'assets', sceneId, 'frames', detections[0].frame)).streams[0];
  const firstB = readdirSync(wsImages).filter((f: string) => f.endsWith('.jpg')).sort()[0];
  const b = jp(join(wsImages, firstB)).streams[0];
  if (Math.abs((a.width / a.height) - (b.width / b.height)) / (a.width / a.height) > 0.01) {
    console.error(`Aspect mismatch: detection ${a.width}x${a.height} vs workspace ${b.width}x${b.height}. Aborting.`);
    process.exit(2);
  }
  frameScale = b.width / a.width;
  console.log(`frame-path box scale: ${frameScale.toFixed(4)}`);
  return frameScale;
}

const meshAnchor = await loadMeshAnchor(storage, sceneId, sparse).catch(() => null);
if (!meshAnchor) console.log('note: no mesh — occlusion check disabled, all posed frames scored');

let pass = 0, fail = 0;
for (const ent of index.entities) {
  if (!ent.position) continue;
  // Own boxes per B-frame: track obs for track entities (JPEG pixels 1:1),
  // largest detection box per frame for frame-path entities (mirrors
  // register-entities' association, including its instance ambiguity).
  const ownBoxes = new Map<number, Box>();
  if (ent.trackId && tracks) {
    const t = tracks.tracks.find((x) => x.id === ent.trackId);
    if (t) {
      for (const o of t.obs) {
        if (!ownBoxes.has(o.m)) ownBoxes.set(o.m, o.box);
      }
    }
  } else {
    const s = detectionScale();
    for (const d of detections.filter((x) => x.label === ent.label)) {
      const raw = [...d.boxes].sort((a, b) => (b.xMax - b.xMin) * (b.yMax - b.yMin) - (a.xMax - a.xMin) * (a.yMax - a.yMin))[0];
      if (!raw) continue;
      const m = 2 * d.frameIdx - 1; // A->B mapping, mirrors registration
      if (!ownBoxes.has(m)) {
        ownBoxes.set(m, { xMin: raw.xMin * s, yMin: raw.yMin * s, xMax: raw.xMax * s, yMax: raw.yMax * s });
      }
    }
  }
  let hits = 0, total = 0, occluded = 0;
  const missDist: number[] = []; // 0 = inside; else px to box edge
  for (const ef of ent.evidence.frames) {
    // Frame-path evidence holds A-indices; poses/boxes key by B-numbers.
    const m = ent.trackId ? ef : 2 * ef - 1;
    const bName = String(m).padStart(4, '0') + '.jpg';
    const pose = poses.get(bName);
    const K = pose ? intrinsics.get(pose.cameraId) : undefined;
    const box = ownBoxes.get(m);
    if (!pose || !K || !box) continue;
    // Occlusion-aware: a perfect position behind a wall from this viewpoint
    // still "misses" its box. Exclude occluded views (mesh hit strictly
    // closer than the position, 10cm tolerance for mesh noise).
    if (meshAnchor) {
      const toP: Vec3 = [ent.position[0] - pose.center[0], ent.position[1] - pose.center[1], ent.position[2] - pose.center[2]];
      const distP = Math.hypot(toP[0], toP[1], toP[2]);
      const dir: Vec3 = [toP[0] / distP, toP[1] / distP, toP[2] / distP];
      const hit = meshAnchor.raycast(pose.center, dir);
      if (hit) {
        const distH = Math.hypot(hit[0] - pose.center[0], hit[1] - pose.center[1], hit[2] - pose.center[2]);
        if (distH < distP - 0.1) {
          occluded++;
          continue;
        }
      }
    }
    total++;
    const dist = missDistance(project(ent.position, pose, K), box);
    missDist.push(dist);
    if (dist === 0) hits++;
  }
  const dumpId = arg('dump');
  if (dumpId && (ent.id === dumpId || ent.trackId === dumpId.replace(/^t/, ''))) {
    console.log(`  --- dump ${ent.id} ${ent.label} pos=(${ent.position.map((p) => p.toFixed(3)).join(',')})`);
    for (const ef of ent.evidence.frames) {
      const m = ent.trackId ? ef : 2 * ef - 1;
      const bName = String(m).padStart(4, '0') + '.jpg';
      const pose = poses.get(bName);
      const K = pose ? intrinsics.get(pose.cameraId) : undefined;
      const box = ownBoxes.get(m);
      if (!pose || !K || !box) {
        console.log(`    f${m}: no pose/box`);
        continue;
      }
      const uv = project(ent.position, pose, K);
      const bcx = ((box.xMin + box.xMax) / 2).toFixed(0), bcy = ((box.yMin + box.yMax) / 2).toFixed(0);
      console.log(`    f${m}: box-c=(${bcx},${bcy}) box=${Math.round(box.xMax - box.xMin)}x${Math.round(box.yMax - box.yMin)} proj=${uv ? `(${uv[0].toFixed(0)},${uv[1].toFixed(0)})` : 'BEHIND'}`);
    }
  }
  missDist.sort((a, b) => a - b);
  const med = total ? missDist[Math.floor(missDist.length / 2)] : NaN;
  const p95 = total ? missDist[Math.floor(missDist.length * 0.95)] : NaN;
  // Bar matches register-entities (≤100px median, app-grade flight targets).
  // Exact numbers always logged — the bar is a backstop, not a claim.
  const verdict = total >= 2 && med <= 100 ? 'PASS' : 'FAIL';
  if (verdict === 'PASS') pass++; else fail++;
  console.log(`  ${verdict} ${ent.id} ${ent.label}${ent.trackId ? ` [t${ent.trackId}]` : ''}: inside=${hits}/${total} occluded=${occluded} missMed=${Number.isNaN(med) ? 'n/a' : med.toFixed(1) + 'px'} missP95=${Number.isNaN(p95) ? 'n/a' : p95 >= 1e9 ? 'OFF-FRAME' : p95.toFixed(0) + 'px'}`);
  // Overlays (first/middle/last evidence frames): own box green, cross red.
  if (overlayDir && total > 0) {
    const picks = [0, Math.floor(ent.evidence.frames.length / 2), ent.evidence.frames.length - 1];
    for (const pi of [...new Set(picks)]) {
      const ef = ent.evidence.frames[pi];
      const m = ent.trackId ? ef : 2 * ef - 1;
      const bName = String(m).padStart(4, '0') + '.jpg';
    const pose = poses.get(bName);
    const K = pose ? intrinsics.get(pose.cameraId) : undefined;
    const box = ownBoxes.get(m);
    const src = join(wsImages, bName);
    if (pose && K && box && existsSync(src)) {
      const uv = project(ent.position, pose, K);
      const cx = uv ? Math.round(uv[0]) : -100, cy = uv ? Math.round(uv[1]) : -100;
      const vf = `drawbox=x=${Math.round(box.xMin)}:y=${Math.round(box.yMin)}:w=${Math.round(box.xMax - box.xMin)}:h=${Math.round(box.yMax - box.yMin)}:c=green:t=3,` +
        `drawbox=x=${cx - 12}:y=${cy - 1}:w=25:h=3:c=red:t=fill,` +
        `drawbox=x=${cx - 1}:y=${cy - 12}:w=3:h=25:c=red:t=fill`;
      try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', vf, '-frames:v', '1', '-pix_fmt', 'yuvj420p',
          join(overlayDir, `${ent.id}-${ent.label}-t${ent.trackId ?? 'f'}-f${m}.jpg`)]);
      } catch { /* overlay best-effort */ }
      }
    }
  }
}
console.log(`verify: ${pass} PASS, ${fail} FAIL (bar: median miss ≤100px; exact numbers above)`);
process.exit(fail > 0 ? 1 : 0);
