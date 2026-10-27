/**
 * Stage 3b registration: 2D SAM boxes -> 3D positions via ray triangulation.
 * Run: npx tsx scripts/register-entities.mts --scene <id>
 * Reads index JSON + detections sidecar, parses COLMAP cameras.bin/images.bin
 * from the job's posesPath, triangulates box-center rays across evidence frames.
 * Gates: >=2 posed frames, min ray angle, residual bound. Failures stay
 * unregistered (position null) — never fabricated coordinates.
 *
 * Frame mapping: Pipeline-A frame N (1fps) and Pipeline-B frame 2N-1 (2fps)
 * are the same source frame (fps grids coincide), so A evidence refs map to
 * B poses.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sceneId = arg('scene');
if (!sceneId) {
  console.error('Usage: register-entities.mts --scene <id>');
  process.exit(2);
}
const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');

type Vec3 = [number, number, number];
interface Box { xMin: number; yMin: number; xMax: number; yMax: number }
interface Detection { frame: string; frameIdx: number; label: string; boxes: Box[] }

// --- COLMAP parsing ---
const PARAM_COUNTS: Record<number, number> = { 0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 8, 7: 12, 8: 4, 9: 5, 10: 12 };
interface Intrinsics { fx: number; fy: number; cx: number; cy: number }
function parseCameras(path: string): Map<number, Intrinsics> {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const out = new Map<number, Intrinsics>();
  for (let k = 0; k < n; k++) {
    const id = data.readInt32LE(off); off += 4;
    const model = data.readInt32LE(off); off += 4;
    off += 16; // w, h
    const count = PARAM_COUNTS[model];
    if (count === undefined) throw new Error(`Unsupported camera model ${model}`);
    const p: number[] = [];
    for (let i = 0; i < count; i++, off += 8) p.push(data.readDoubleLE(off));
    // SIMPLE_PINHOLE (f,cx,cy) and PINHOLE (fx,fy,cx,cy) share leading layout.
    out.set(id, model === 0 ? { fx: p[0], fy: p[0], cx: p[1], cy: p[2] } : { fx: p[0], fy: p[1], cx: p[2], cy: p[3] });
  }
  return out;
}
interface Pose { center: Vec3; R: number[][]; cameraId: number }
function parseImages(path: string): Map<string, Pose> {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const out = new Map<string, Pose>();
  for (let k = 0; k < n; k++) {
    off += 4; // image_id
    const qw = data.readDoubleLE(off); const qx = data.readDoubleLE(off + 8);
    const qy = data.readDoubleLE(off + 16); const qz = data.readDoubleLE(off + 24);
    off += 32;
    const tx = data.readDoubleLE(off); const ty = data.readDoubleLE(off + 8); const tz = data.readDoubleLE(off + 24);
    off += 24;
    const cameraId = data.readInt32LE(off); off += 4;
    let s = '';
    while (data[off] !== 0) { s += String.fromCharCode(data[off]); off++; }
    off += 1;
    const npts = Number(data.readBigUInt64LE(off)); off += 8 + npts * 24;
    const [w, x, y, z] = [qw, qx, qy, qz];
    const R = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
    const t: Vec3 = [tx, ty, tz];
    const C: Vec3 = [
      -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
      -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
      -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
    ];
    out.set(basename(s), { center: C, R, cameraId });
  }
  return out;
}

// --- triangulation ---
function solve3(A: number[][], b: number[]): Vec3 | null {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
function triangulate(rays: { origin: Vec3; dir: Vec3 }[]): { point: Vec3; residual: number } | null {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b: Vec3 = [0, 0, 0];
  for (const { origin: C, dir: d } of rays) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const delta = (i === j ? 1 : 0) - d[i] * d[j];
      A[i][j] += delta;
      b[i] += delta * C[j];
    }
  }
  const p = solve3(A, b);
  if (!p || !p.every(Number.isFinite)) return null;
  let res = 0;
  for (const { origin: C, dir: d } of rays) {
    const v: Vec3 = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
    const along = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
    if (along <= 0) return null; // point behind a camera: reject
    const px: Vec3 = [C[0] + d[0] * along, C[1] + d[1] * along, C[2] + d[2] * along];
    res += Math.hypot(p[0] - px[0], p[1] - px[1], p[2] - px[2]);
  }
  return { point: p, residual: res / rays.length };
}

// --- main ---
const jobs = JSON.parse(readFileSync(join(storage, 'jobs.json'), 'utf8')) as Record<string, { sceneId: string; status: string; asset?: { posesPath?: string } }>;
const job = Object.values(jobs).find((j) => j.sceneId === sceneId && j.status === 'ready' && j.asset?.posesPath);
if (!job?.asset?.posesPath) {
  console.error('No ready job with poses for scene');
  process.exit(2);
}
const sparse = job.asset.posesPath;
const intrinsics = parseCameras(join(sparse, 'cameras.bin'));
const poses = parseImages(join(sparse, 'images.bin'));
console.log(`poses: ${poses.size} images, ${intrinsics.size} camera(s)`);

const indexPath = join(storage, 'index', `${sceneId}.json`);
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  entities: { id: string; type: string; label: string; status: string; position: Vec3 | null; evidence: { frames: number[] } }[];
};
const detections: Detection[] = JSON.parse(readFileSync(join(storage, 'index', `${sceneId}.detections.json`), 'utf8') as string);

// Scene scale for relative residual gate.
const centers = [...poses.values()].map((p) => p.center);
const mean: Vec3 = [0, 1, 2].map((i) => centers.reduce((s, c) => s + c[i], 0) / centers.length) as Vec3;
const radius = Math.max(...centers.map((c) => Math.hypot(c[0] - mean[0], c[1] - mean[1], c[2] - mean[2])), 1e-6);

let registered = 0;
for (const ent of index.entities) {
  const ds = detections.filter((d) => d.label === ent.label);
  const rays: ({ origin: Vec3; dir: Vec3; frame: number })[] = [];
  const usedFrames: number[] = [];
  for (const d of ds) {
    // Largest box = most prominent instance in this frame.
    const box = [...d.boxes].sort((a, b) => (b.xMax - b.xMin) * (b.yMax - b.yMin) - (a.xMax - a.xMin) * (a.yMax - a.yMin))[0];
    if (!box) continue;
    const bName = String(2 * d.frameIdx - 1).padStart(4, '0') + '.jpg';
    const pose = poses.get(bName);
    const K = pose ? intrinsics.get(pose.cameraId) : undefined;
    if (!pose || !K) continue;
    const u = (box.xMin + box.xMax) / 2;
    const v = (box.yMin + box.yMax) / 2;
    const nx = (u - K.cx) / K.fx;
    const ny = (v - K.cy) / K.fy;
    const inv = Math.hypot(nx, ny, 1);
    const camDir: Vec3 = [nx / inv, ny / inv, 1 / inv];
    const R = pose.R;
    const dir: Vec3 = [
      R[0][0] * camDir[0] + R[1][0] * camDir[1] + R[2][0] * camDir[2],
      R[0][1] * camDir[0] + R[1][1] * camDir[1] + R[2][1] * camDir[2],
      R[0][2] * camDir[0] + R[1][2] * camDir[1] + R[2][2] * camDir[2],
    ];
    rays.push({ origin: pose.center, dir, frame: d.frameIdx });
    usedFrames.push(d.frameIdx);
  }
  // RANSAC-lite over ray pairs: multi-instance detections (e.g. four doors
  // in one frame, largest-box picking different instances per frame) produce
  // outlier rays. Keep the largest consensus set; require >=2 inliers.
  interface Ray { origin: Vec3; dir: Vec3 }
  function pairMidpoint(a: Ray, b: Ray): { mid: Vec3; angle: number } | null {
    const dot = Math.min(1, Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2]));
    const angle = Math.acos(dot) * 180 / Math.PI;
    if (angle < 1.5) return null;
    // Closest points between two lines.
    const w0: Vec3 = [a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]];
    const a1 = 1; // |dir| == 1
    const b1 = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2];
    const c1 = 1;
    const d1 = a.dir[0] * w0[0] + a.dir[1] * w0[1] + a.dir[2] * w0[2];
    const e1 = b.dir[0] * w0[0] + b.dir[1] * w0[1] + b.dir[2] * w0[2];
    const denom = a1 * c1 - b1 * b1;
    if (Math.abs(denom) < 1e-12) return null;
    const s = (b1 * e1 - c1 * d1) / denom;
    const t = (a1 * e1 - b1 * d1) / denom;
    const pa: Vec3 = [a.origin[0] + s * a.dir[0], a.origin[1] + s * a.dir[1], a.origin[2] + s * a.dir[2]];
    const pb: Vec3 = [b.origin[0] + t * b.dir[0], b.origin[1] + t * b.dir[1], b.origin[2] + t * b.dir[2]];
    return { mid: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2], angle };
  }
  function distToRay(p: Vec3, r: Ray): number {
    const v: Vec3 = [p[0] - r.origin[0], p[1] - r.origin[1], p[2] - r.origin[2]];
    const along = v[0] * r.dir[0] + v[1] * r.dir[1] + v[2] * r.dir[2];
    if (along <= 0) return Infinity;
    return Math.hypot(v[0] - r.dir[0] * along, v[1] - r.dir[1] * along, v[2] - r.dir[2] * along);
  }
  let best: Ray[] | null = null;
  for (let i = 0; i < rays.length; i++) for (let j = i + 1; j < rays.length; j++) {
    const pm = pairMidpoint(rays[i], rays[j]);
    if (!pm) continue;
    const inliers = rays.filter((r) => distToRay(pm.mid, r) < radius * 0.1);
    if (inliers.length >= 2 && (!best || inliers.length > best.length)) best = inliers;
  }
  const consensus = best ?? rays;
  if (consensus.length < 2) {
    console.log(`  ${ent.label}: unregistered (no consensus pair)`);
    continue;
  }
  // Gate 1b: baseline angle within the consensus set.
  let maxAngle = 0;
  for (let i = 0; i < consensus.length; i++) for (let j = i + 1; j < consensus.length; j++) {
    const dot = Math.min(1, Math.abs(consensus[i].dir[0] * consensus[j].dir[0] + consensus[i].dir[1] * consensus[j].dir[1] + consensus[i].dir[2] * consensus[j].dir[2]));
    maxAngle = Math.max(maxAngle, Math.acos(dot) * 180 / Math.PI);
  }
  if (maxAngle < 1.5) {
    console.log(`  ${ent.label}: unregistered (maxAngle=${maxAngle.toFixed(1)}°)`);
    continue;
  }
  // Keep evidence frames accurate and duplicate-free.
  const detFrames = [...new Set(detections.filter((x) => x.label === ent.label).map((x) => x.frameIdx))].sort((a, b) => a - b);
  ent.evidence = { frames: detFrames };
  const tri = triangulate(consensus);
  // Gate 2: residual relative to scene scale.
  if (!tri || tri.residual / radius > 0.15) {
    console.log(`  ${ent.label}: unregistered (residual=${tri ? (tri.residual / radius).toFixed(3) : 'fail'} of scene radius)`);
    continue;
  }
  ent.position = tri.point;
  (ent as Record<string, unknown>).spatialRegistrationStatus = 'registered';
  (ent as Record<string, unknown>).coordinateProvenance = 'triangulated-sam-box-centers-v1';
  registered++;
  const inlierFrames = consensus.map((r) => (r as { frame: number }).frame).join(',');
  console.log(`  ${ent.label}: REGISTERED @(${tri.point.map((p) => p.toFixed(2)).join(',')}) residual=${(tri.residual / radius).toFixed(3)} frames=[${inlierFrames}]`);
}
writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`registered: ${registered}/${index.entities.length}`);
