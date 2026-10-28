/**
 * Validate COLMAP poses + parsing against the model's own ground truth:
 * project sparse 3D points into their track images and compare with the
 * recorded 2D keypoint locations. Median error < 3px = poses and parse are
 * valid; anything larger means the SfM solution or our parsing is broken.
 * Run: npx tsx scripts/verify-poses.mts --scene <id>
 * Reads the ready job's posesPath (sparse/0). No API calls.
 */
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sceneId = arg('scene');
if (!sceneId) {
  console.error('Usage: verify-poses.mts --scene <id>');
  process.exit(2);
}
const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');

const jobs = JSON.parse(readFileSync(join(storage, 'jobs.json'), 'utf8')) as Record<string, { sceneId: string; status: string; asset?: { posesPath?: string } }>;
const job = Object.values(jobs).find((j) => j.sceneId === sceneId && j.status === 'ready' && j.asset?.posesPath);
if (!job?.asset?.posesPath) {
  console.error('No ready job with poses');
  process.exit(2);
}
const sparse = job.asset.posesPath;

const PARAM_COUNTS: Record<number, number> = { 0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 8, 7: 12, 8: 4, 9: 5, 10: 12 };
type Vec3 = [number, number, number];
const cdata = readFileSync(join(sparse, 'cameras.bin'));
{
  // header sanity only; full parse below shares register-entities' code path
  const n = Number(cdata.readBigUInt64LE(0));
  console.log(`cameras: ${n}`);
}
interface Intr { fx: number; fy: number; cx: number; cy: number }
function parseCameras(path: string): Map<number, Intr> {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const out = new Map<number, Intr>();
  for (let k = 0; k < n; k++) {
    const id = data.readInt32LE(off); off += 4;
    const model = data.readInt32LE(off); off += 4;
    const w = data.readBigUInt64LE(off); off += 8; // width (sanity)
    off += 8; // height
    void w;
    const count = PARAM_COUNTS[model];
    if (count === undefined) throw new Error(`Unsupported camera model ${model}`);
    const p: number[] = [];
    for (let i = 0; i < count; i++, off += 8) p.push(data.readDoubleLE(off));
    out.set(id, model === 0 ? { fx: p[0], fy: p[0], cx: p[1], cy: p[2] } : { fx: p[0], fy: p[1], cx: p[2], cy: p[3] });
  }
  return out;
}
interface Pose { t: Vec3; R: number[][]; cameraId: number; pts2d: [number, number][] }
function parseImages(path: string): { byName: Map<string, Pose>; byId: Map<number, Pose> } {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const byName = new Map<string, Pose>();
  const byId = new Map<number, Pose>();
  for (let k = 0; k < n; k++) {
    const imageId = data.readInt32LE(off); off += 4;
    const qw = data.readDoubleLE(off), qx = data.readDoubleLE(off + 8);
    const qy = data.readDoubleLE(off + 16), qz = data.readDoubleLE(off + 24);
    off += 32;
    const tx = data.readDoubleLE(off), ty = data.readDoubleLE(off + 8), tz = data.readDoubleLE(off + 24);
    off += 24;
    const cameraId = data.readInt32LE(off); off += 4;
    let s = '';
    while (data[off] !== 0) { s += String.fromCharCode(data[off]); off++; }
    off += 1;
    const npts = Number(data.readBigUInt64LE(off)); off += 8;
    const pts2d: [number, number][] = [];
    for (let i = 0; i < npts; i++) {
      const x = data.readDoubleLE(off), y = data.readDoubleLE(off + 8);
      off += 24; // x, y, point3D_id
      pts2d.push([x, y]);
    }
    const [w, x, y, z] = [qw, qx, qy, qz];
    const pose: Pose = {
      t: [tx, ty, tz],
      R: [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
      ],
      cameraId, pts2d,
    };
    byName.set(basename(s), pose);
    byId.set(imageId, pose);
  }
  return { byName, byId };
}
interface P3 { xyz: Vec3; err: number; track: { imageId: number; idx: number }[] }
function parsePoints3D(path: string): P3[] {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const out: P3[] = [];
  for (let k = 0; k < n; k++) {
    off += 8; // point3D_id is uint64 in COLMAP's binary format
    const xyz: Vec3 = [data.readDoubleLE(off), data.readDoubleLE(off + 8), data.readDoubleLE(off + 16)];
    off += 24;
    off += 3; // rgb
    const err = data.readDoubleLE(off); off += 8;
    const tlen = Number(data.readBigUInt64LE(off)); off += 8;
    const track: P3['track'] = [];
    for (let i = 0; i < tlen; i++) {
      const imageId = data.readInt32LE(off); off += 4;
      const idx = data.readInt32LE(off); off += 4;
      track.push({ imageId, idx });
    }
    out.push({ xyz, err, track });
  }
  return out;
}

const intrinsics = parseCameras(join(sparse, 'cameras.bin'));
const { byName, byId } = parseImages(join(sparse, 'images.bin'));
const points = parsePoints3D(join(sparse, 'points3D.bin'));
console.log(`images: ${byName.size}, points3D: ${points.length}`);
console.log(`sample names: ${[...byName.keys()].slice(0, 3).join(',')} ... ${[...byName.keys()].slice(-2).join(',')}`);

// Try pose-convention hypotheses: COLMAP stores world-to-camera (Xcam=R*X+t)
// with w-first quaternions, but a wrong assumption anywhere is catastrophic.
// Test {w-first, w-last} x {as-stored w2c, inverted c2c} and let pixels decide.
function quatToR(qw: number, qx: number, qy: number, qz: number): number[][] {
  const [w, x, y, z] = [qw, qx, qy, qz];
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
function transpose(R: number[][]): number[][] {
  return [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
}
// Re-read raw qvec/tvec per image (parseImages baked one convention).
interface RawQT { q: [number, number, number, number]; t: Vec3; cameraId: number; pts2d: [number, number][] }
function parseRawQT(path: string): Map<number, RawQT> {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const out = new Map<number, RawQT>();
  for (let k = 0; k < n; k++) {
    const imageId = data.readInt32LE(off); off += 4;
    const q: [number, number, number, number] = [data.readDoubleLE(off), data.readDoubleLE(off + 8), data.readDoubleLE(off + 16), data.readDoubleLE(off + 24)];
    off += 32;
    const t: Vec3 = [data.readDoubleLE(off), data.readDoubleLE(off + 8), data.readDoubleLE(off + 24)];
    off += 24;
    const cameraId = data.readInt32LE(off); off += 4;
    while (data[off] !== 0) off++;
    off += 1;
    const npts = Number(data.readBigUInt64LE(off)); off += 8;
    const pts2d: [number, number][] = [];
    for (let i = 0; i < npts; i++) {
      pts2d.push([data.readDoubleLE(off), data.readDoubleLE(off + 8)]);
      off += 24;
    }
    out.set(imageId, { q, t, cameraId, pts2d });
  }
  return out;
}
const rawQT = parseRawQT(join(sparse, 'images.bin'));
function trial(label: string, wFirst: boolean, invert: boolean): void {
  const errs: number[] = [];
  let behind = 0, used = 0;
  const SAMPLE = 400;
  for (let i = 0; i < points.length && used < SAMPLE; i += Math.max(1, Math.floor(points.length / SAMPLE))) {
    const p = points[i];
    for (const tr of p.track.slice(0, 2)) {
      if (used >= SAMPLE) break;
      const raw = rawQT.get(tr.imageId);
      const K = raw ? intrinsics.get(raw.cameraId) : undefined;
      const obs = raw?.pts2d[tr.idx];
      if (!raw || !K || !obs) continue;
      const [a, b, c, d] = raw.q;
      let R = wFirst ? quatToR(a, b, c, d) : quatToR(d, a, b, c);
      let t: Vec3 = [...raw.t];
      if (invert) {
        const Rt = transpose(R);
        t = [-(Rt[0][0] * t[0] + Rt[0][1] * t[1] + Rt[0][2] * t[2]),
             -(Rt[1][0] * t[0] + Rt[1][1] * t[1] + Rt[1][2] * t[2]),
             -(Rt[2][0] * t[0] + Rt[2][1] * t[1] + Rt[2][2] * t[2])];
        R = Rt;
      }
      const [X, Y, Z] = p.xyz;
      const xc = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
      const yc = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];
      const zc = R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2];
      if (zc <= 0) { behind++; continue; }
      errs.push(Math.hypot(K.fx * (xc / zc) + K.cx - obs[0], K.fy * (yc / zc) + K.cy - obs[1]));
      used++;
    }
  }
  errs.sort((a, b2) => a - b2);
  console.log(`${label}: n=${errs.length} median=${errs[Math.floor(errs.length / 2)].toFixed(2)}px p95=${errs[Math.floor(errs.length * 0.95)].toFixed(2)}px behind=${behind}`);
}
trial('w-first as-stored (COLMAP textbook)', true, false);
trial('w-first inverted (c2w stored?)     ', true, true);
trial('w-last as-stored                  ', false, false);
trial('w-last inverted                   ', false, true);
