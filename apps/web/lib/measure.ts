/**
 * Measurement core: real 3D extents from COLMAP geometry (no server-only deps,
 * so scripts and routes can both use it). Everything in reconstruction units
 * until calibrated against a known reference — never presented as meters.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Vec3 = [number, number, number];
export interface Box { xMin: number; yMin: number; xMax: number; yMax: number }
export interface Ray { origin: Vec3; dir: Vec3 }

const PARAM_COUNTS: Record<number, number> = { 0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 8, 7: 12, 8: 4, 9: 5, 10: 12 };
export interface Intrinsics { fx: number; fy: number; cx: number; cy: number }
export interface Pose { center: Vec3; R: number[][]; cameraId: number }

export function parseCameras(path: string): Map<number, Intrinsics> {
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  const out = new Map<number, Intrinsics>();
  for (let k = 0; k < n; k++) {
    const id = data.readInt32LE(off); off += 4;
    const model = data.readInt32LE(off); off += 4;
    off += 16;
    const count = PARAM_COUNTS[model];
    if (count === undefined) throw new Error(`Unsupported camera model ${model}`);
    const p: number[] = [];
    for (let i = 0; i < count; i++, off += 8) p.push(data.readDoubleLE(off));
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
    off += 4;
    const qw = data.readDoubleLE(off); const qx = data.readDoubleLE(off + 8);
    const qy = data.readDoubleLE(off + 16); const qz = data.readDoubleLE(off + 24);
    off += 32;
    const tx = data.readDoubleLE(off); const ty = data.readDoubleLE(off + 8); const tz = data.readDoubleLE(off + 16);
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
    const parts = s.split('/');
    out.set(parts[parts.length - 1], { center: C, R, cameraId });
  }
  return out;
}

/** Sparse point bbox (units). Skips track data after reading lengths. */
/** Sparse point bbox (units). NOTE: Spirula writes uint64 point ids (classic
 *  COLMAP uses int32) — verified against real output. Track elements stay int32. */
export function pointsBbox(path: string): { min: Vec3; max: Vec3; count: number } | null {
  if (!existsSync(path)) return null;
  const data = readFileSync(path);
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (let k = 0; k < n; k++) {
    off += 8; // point id (uint64 in Spirula output)
    const x = data.readDoubleLE(off); const y = data.readDoubleLE(off + 8); const z = data.readDoubleLE(off + 16);
    off += 24 + 3 + 8; // xyz + rgb + error
    const tlen = Number(data.readBigUInt64LE(off)); off += 8 + tlen * 8;
    if (!min || !max) { min = [x, y, z]; max = [x, y, z]; }
    else {
      min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
      max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];
    }
  }
  return min && max ? { min, max, count: n } : null;
}

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

export interface Triangulation { point: Vec3; residual: number; inliers: number }

function pairMidpoint(a: Ray, b: Ray): { mid: Vec3 } | null {
  const dot = Math.min(1, Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2]));
  if (Math.acos(dot) * 180 / Math.PI < 1.5) return null;
  const w0: Vec3 = [a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]];
  const b1 = a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2];
  const d1 = a.dir[0] * w0[0] + a.dir[1] * w0[1] + a.dir[2] * w0[2];
  const e1 = b.dir[0] * w0[0] + b.dir[1] * w0[1] + b.dir[2] * w0[2];
  const denom = 1 - b1 * b1;
  if (Math.abs(denom) < 1e-12) return null;
  const s = (b1 * e1 - d1) / denom;
  const t = (e1 - b1 * d1) / denom;
  return {
    mid: [
      (a.origin[0] + s * a.dir[0] + b.origin[0] + t * b.dir[0]) / 2,
      (a.origin[1] + s * a.dir[1] + b.origin[1] + t * b.dir[1]) / 2,
      (a.origin[2] + s * a.dir[2] + b.origin[2] + t * b.dir[2]) / 2,
    ],
  };
}

function distToRay(p: Vec3, r: Ray): number {
  const v: Vec3 = [p[0] - r.origin[0], p[1] - r.origin[1], p[2] - r.origin[2]];
  const along = v[0] * r.dir[0] + v[1] * r.dir[1] + v[2] * r.dir[2];
  if (along <= 0) return Infinity;
  return Math.hypot(v[0] - r.dir[0] * along, v[1] - r.dir[1] * along, v[2] - r.dir[2] * along);
}

/** RANSAC-consensus least-squares triangulation. Null when not converging. */
export function triangulate(rays: Ray[], tol: number): Triangulation | null {
  let best: Ray[] | null = null;
  for (let i = 0; i < rays.length; i++) for (let j = i + 1; j < rays.length; j++) {
    const pm = pairMidpoint(rays[i], rays[j]);
    if (!pm) continue;
    const inliers = rays.filter((r) => distToRay(pm.mid, r) < tol);
    if (inliers.length >= 2 && (!best || inliers.length > best.length)) best = inliers;
  }
  const consensus = best ?? rays;
  if (consensus.length < 2) return null;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b: Vec3 = [0, 0, 0];
  for (const { origin: C, dir: d } of consensus) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const delta = (i === j ? 1 : 0) - d[i] * d[j];
      A[i][j] += delta;
      b[i] += delta * C[j];
    }
  }
  const p = solve3(A, b);
  if (!p || !p.every(Number.isFinite)) return null;
  let res = 0;
  for (const r of consensus) {
    const d = distToRay(p, r);
    if (!Number.isFinite(d)) return null;
    res += d;
  }
  return { point: p, residual: res / consensus.length, inliers: consensus.length };
}

/** Pixel -> world ray through a pose. */
export function pixelRay(pose: Pose, K: Intrinsics, u: number, v: number): Ray {
  const nx = (u - K.cx) / K.fx;
  const ny = (v - K.cy) / K.fy;
  const inv = Math.hypot(nx, ny, 1);
  const c: Vec3 = [nx / inv, ny / inv, 1 / inv];
  const R = pose.R;
  const dir: Vec3 = [
    R[0][0] * c[0] + R[1][0] * c[1] + R[2][0] * c[2],
    R[0][1] * c[0] + R[1][1] * c[1] + R[2][1] * c[2],
    R[0][2] * c[0] + R[1][2] * c[1] + R[2][2] * c[2],
  ];
  return { origin: pose.center, dir };
}

/** Convenience: resolve standard COLMAP sparse paths. */
export function sparsePaths(sparseRoot: string): { images: string; cameras: string; points: string } {
  return {
    images: join(sparseRoot, 'images.bin'),
    cameras: join(sparseRoot, 'points.bin').replace('points.bin', 'cameras.bin'),
    points: join(sparseRoot, 'points3D.bin'),
  };
}
