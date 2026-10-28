/**
 * Shared COLMAP sparse-model parsing + projection (single source of truth).
 * Used by register-entities.mts, verify-registration.mts, verify-poses.mts.
 * Convention (verified by round-trip test, 1e-16): X_cam = R * X_world + t,
 * R from w-first unit quaternion (Hamilton/Eigen), u = fx*xc/zc + cx.
 */
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export type Vec3 = [number, number, number];
export interface Box { xMin: number; yMin: number; xMax: number; yMax: number }
export interface Intr { fx: number; fy: number; cx: number; cy: number }
export interface Pose { center: Vec3; R: number[][]; t: Vec3; cameraId: number }

const PARAM_COUNTS: Record<number, number> = { 0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 8, 7: 12, 8: 4, 9: 5, 10: 12 };

export function parseCameras(path: string): Map<number, Intr> {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const out = new Map<number, Intr>();
  for (let k = 0; k < n; k++) {
    const id = data.readInt32LE(off); off += 4;
    const model = data.readInt32LE(off); off += 4;
    off += 16; // w, h (uint64 each)
    const count = PARAM_COUNTS[model];
    if (count === undefined) throw new Error(`Unsupported camera model ${model}`);
    const p: number[] = [];
    for (let i = 0; i < count; i++, off += 8) p.push(data.readDoubleLE(off));
    // SIMPLE_PINHOLE (f,cx,cy) and PINHOLE (fx,fy,cx,cy) share leading layout.
    out.set(id, model === 0 ? { fx: p[0], fy: p[0], cx: p[1], cy: p[2] } : { fx: p[0], fy: p[1], cx: p[2], cy: p[3] });
  }
  return out;
}

export function parseImages(path: string): Map<string, Pose> {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const out = new Map<string, Pose>();
  for (let k = 0; k < n; k++) {
    off += 4; // image_id
    const qw = data.readDoubleLE(off), qx = data.readDoubleLE(off + 8);
    const qy = data.readDoubleLE(off + 16), qz = data.readDoubleLE(off + 24);
    off += 32;
    const tx = data.readDoubleLE(off), ty = data.readDoubleLE(off + 8), tz = data.readDoubleLE(off + 24);
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
    out.set(basename(s), {
      center: [
        -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
        -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
        -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
      ],
      R, t, cameraId,
    });
  }
  return out;
}

/** World -> pixel. Null when behind the camera. Distortion NOT modeled. */
export function project(p: Vec3, pose: Pose, K: Intr): [number, number] | null {
  const xc = pose.R[0][0] * p[0] + pose.R[0][1] * p[1] + pose.R[0][2] * p[2] + pose.t[0];
  const yc = pose.R[1][0] * p[0] + pose.R[1][1] * p[1] + pose.R[1][2] * p[2] + pose.t[1];
  const zc = pose.R[2][0] * p[0] + pose.R[2][1] * p[1] + pose.R[2][2] * p[2] + pose.t[2];
  if (zc <= 0) return null;
  return [K.fx * (xc / zc) + K.cx, K.fy * (yc / zc) + K.cy];
}

/** Pixel -> world ray (origin, unit dir) through (u, v). */
export function rayFromPixel(u: number, v: number, pose: Pose, K: Intr): { origin: Vec3; dir: Vec3 } {
  const nx = (u - K.cx) / K.fx, ny = (v - K.cy) / K.fy;
  const inv = Math.hypot(nx, ny, 1);
  const cd: Vec3 = [nx / inv, ny / inv, 1 / inv];
  const R = pose.R;
  return {
    origin: pose.center,
    dir: [
      R[0][0] * cd[0] + R[1][0] * cd[1] + R[2][0] * cd[2],
      R[0][1] * cd[0] + R[1][1] * cd[1] + R[2][1] * cd[2],
      R[0][2] * cd[0] + R[1][2] * cd[1] + R[2][2] * cd[2],
    ],
  };
}

/** Px distance from uv to box (0 inside). For scoring positions. */
export function missDistance(uv: [number, number] | null, box: Box): number {
  if (uv === null) return 1e9;
  const dx = uv[0] < box.xMin ? box.xMin - uv[0] : uv[0] > box.xMax ? uv[0] - box.xMax : 0;
  const dy = uv[1] < box.yMin ? box.yMin - uv[1] : uv[1] > box.yMax ? uv[1] - box.yMax : 0;
  return Math.hypot(dx, dy);
}

export function loadSparse(storage: string, sceneId: string): { sparse: string; intrinsics: Map<number, Intr>; poses: Map<string, Pose> } {
  const jobs = JSON.parse(readFileSync(join(storage, 'jobs.json'), 'utf8')) as Record<string, { sceneId: string; status: string; asset?: { posesPath?: string } }>;
  const job = Object.values(jobs).find((j) => j.sceneId === sceneId && j.status === 'ready' && j.asset?.posesPath);
  if (!job?.asset?.posesPath) throw new Error('No ready job with poses for scene');
  return {
    sparse: job.asset.posesPath,
    intrinsics: parseCameras(join(job.asset.posesPath, 'cameras.bin')),
    poses: parseImages(join(job.asset.posesPath, 'images.bin')),
  };
}
