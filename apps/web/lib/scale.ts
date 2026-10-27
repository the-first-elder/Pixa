/**
 * Scale calibration + object measurement (server-only logic, pure inputs).
 * Units → meters happens ONLY after calibrateSceneScale with a user-provided
 * reference. Until then every size answer stays in reconstruction units with
 * an explicit uncalibrated warning.
 */
import 'server-only';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { STORAGE_DIR } from './config';
import { getScale, setScale, type SceneScale } from './store';
import {
  parseCameras,
  parseImages,
  pixelRay,
  pointsBbox,
  sparsePaths,
  triangulate,
  type Box,
  type Intrinsics,
  type Pose,
  type Ray,
  type Vec3,
} from './measure';

interface Detection { frame: string; frameIdx: number; label: string; boxes: Box[] }
interface IndexEntity {
  id: string; type: string; label: string; status: string;
  position: Vec3 | null; evidence: { frames: number[] };
}

function loadIndex(sceneId: string): { entities: IndexEntity[]; detections: Detection[] } {
  const entities = (JSON.parse(readFileSync(join(STORAGE_DIR, 'index', `${sceneId}.json`), 'utf8')) as {
    entities: IndexEntity[];
  }).entities;
  const detections: Detection[] = JSON.parse(
    readFileSync(join(STORAGE_DIR, 'index', `${sceneId}.detections.json`), 'utf8') as string,
  );
  return { entities, detections };
}

function loadGeometry(sceneId: string): { poses: Map<string, Pose>; intrinsics: Map<number, Intrinsics>; radius: number; sparseRoot: string } {
  const jobs = JSON.parse(readFileSync(join(STORAGE_DIR, 'jobs.json'), 'utf8')) as Record<
    string, { sceneId: string; status: string; asset?: { posesPath?: string } | null }
  >;
  const job = Object.values(jobs).find((j) => j.sceneId === sceneId && j.status === 'ready' && j.asset?.posesPath);
  if (!job?.asset?.posesPath) throw new Error('No poses for scene');
  const paths = sparsePaths(job.asset.posesPath);
  const poses = parseImages(paths.images);
  const intrinsics = parseCameras(paths.cameras);
  const centers = [...poses.values()].map((p) => p.center);
  const mean: Vec3 = [0, 1, 2].map((i) => centers.reduce((s, c) => s + c[i], 0) / centers.length) as Vec3;
  const radius = Math.max(...centers.map((c) => Math.hypot(c[0] - mean[0], c[1] - mean[1], c[2] - mean[2])), 1e-6);
  return { poses, intrinsics, radius, sparseRoot: job.asset.posesPath };
}

export interface ExtentResult {
  units: number;
  residual: number;
  frames: number[];
  inliers: number;
}

/** Triangulate an entity's box-edge extent (height|width) in reconstruction units.
 * Robust method: per-frame size = (box pixels / focal) × depth from the
 * already-triangulated entity center; median across frames with 25% inlier
 * band. Multi-instance frames (four doors, pick-another) become outliers
 * instead of breaking convergence. Requires a registered position. */
export function measureExtentUnits(
  sceneId: string,
  label: string,
  dimension: 'height' | 'width',
): ExtentResult {
  const { entities, detections } = loadIndex(sceneId);
  const ent = entities.find((e) => e.label.toLowerCase() === label.toLowerCase()) ??
    entities.find((e) => e.label.toLowerCase().includes(label.toLowerCase()));
  if (!ent) throw new Error(`"${label}" is not an indexed entity`);
  if (!ent.position) throw new Error(`"${ent.label}" has no registered 3D position yet`);
  const center: Vec3 = ent.position;
  const { poses, intrinsics } = loadGeometry(sceneId);
  const estimates: { v: number; frame: number }[] = [];
  for (const d of detections.filter((x) => x.label === ent.label)) {
    const box = [...d.boxes].sort((a, b) => (b.xMax - b.xMin) * (b.yMax - b.yMin) - (a.xMax - a.xMin) * (a.yMax - a.yMin))[0];
    if (!box) continue;
    const bName = String(2 * d.frameIdx - 1).padStart(4, '0') + '.jpg';
    const pose = poses.get(bName);
    const K = pose ? intrinsics.get(pose.cameraId) : undefined;
    if (!pose || !K) continue;
    const depth = Math.hypot(center[0] - pose.center[0], center[1] - pose.center[1], center[2] - pose.center[2]);
    if (!(depth > 1e-6)) continue;
    const px = dimension === 'height' ? box.yMax - box.yMin : box.xMax - box.xMin;
    const f = dimension === 'height' ? K.fy : K.fx;
    if (!(px > 0) || !(f > 0)) continue;
    estimates.push({ v: (px / f) * depth, frame: d.frameIdx });
  }
  if (estimates.length < 2) throw new Error(`Not enough posed views of "${ent.label}" to measure ${dimension}`);
  // Dominant-instance clustering: views may mix several same-label objects
  // (four doors). Keep the largest subset agreeing within 25%.
  const sorted = [...estimates].sort((a, b) => a.v - b.v);
  let best: typeof estimates = [];
  for (const cand of sorted) {
    const set = estimates.filter((e) => Math.abs(e.v - cand.v) / cand.v <= 0.25);
    if (set.length > best.length) best = set;
  }
  if (best.length < 2) throw new Error(`Views of "${ent.label}" disagree too much to measure ${dimension} (possible mixed instances)`);
  const vals = best.map((e) => e.v).sort((a, b) => a - b);
  const size = vals[Math.floor(vals.length / 2)];
  const mad = vals.reduce((s, v) => s + Math.abs(v - size), 0) / vals.length;
  return { units: size, residual: mad, frames: best.map((e) => e.frame), inliers: best.length };
}

/** Room-contents extent from the sparse point cloud (units). */
export function roomExtentUnits(sceneId: string): { x: number; y: number; z: number; points: number } {
  const { sparseRoot } = loadGeometry(sceneId);
  const bbox = pointsBbox(join(sparseRoot, 'points3D.bin'));
  if (!bbox) throw new Error('No point cloud for scene');
  return {
    x: bbox.max[0] - bbox.min[0],
    y: bbox.max[1] - bbox.min[1],
    z: bbox.max[2] - bbox.min[2],
    points: bbox.count,
  };
}

export function uncertaintyPct(residual: number, size: number): number {
  return Math.min(50, Math.round(100 * (residual / Math.max(size, 1e-9) + 0.08)));
}

/** Calibrate units→meters from a user-provided reference. The ONLY path to meters. */
export function calibrateSceneScale(
  sceneId: string,
  referenceLabel: string,
  dimension: 'height' | 'width',
  knownMeters: number,
): SceneScale {
  if (!(knownMeters > 0) || knownMeters > 100) throw new Error('knownMeters must be a positive real-world size');
  const m = measureExtentUnits(sceneId, referenceLabel, dimension);
  const scale = m.units / knownMeters; // units per meter
  return setScale({
    sceneId,
    scale,
    referenceLabel,
    dimension,
    knownMeters,
    measuredUnits: m.units,
    uncertaintyPct: uncertaintyPct(m.residual, m.units),
    method: `median-of-frame-sizes-v1 (frames ${m.frames.join(',')})`,
  });
}

export interface Measurement {
  label: string;
  dimension: string;
  meters: number | null;
  units: number;
  uncertaintyPct: number;
  calibrated: boolean;
  frames: number[];
}

/** Measure an entity or '__room'; meters only when calibrated. */
export function measureLabel(sceneId: string, label: string, dimension: 'height' | 'width' = 'height'): Measurement {
  if (label === '__room') {
    const e = roomExtentUnits(sceneId);
    const size = dimension === 'height' ? e.y : Math.max(e.x, e.z);
    const scale = getScale(sceneId);
    return {
      label: 'room contents', dimension,
      meters: scale ? size / scale.scale : null,
      units: size, uncertaintyPct: 20, calibrated: !!scale, frames: [],
    };
  }
  const m = measureExtentUnits(sceneId, label, dimension);
  const scale = getScale(sceneId);
  return {
    label, dimension,
    meters: scale ? m.units / scale.scale : null,
    units: m.units,
    uncertaintyPct: scale ? Math.min(50, scale.uncertaintyPct + uncertaintyPct(m.residual, m.units)) : uncertaintyPct(m.residual, m.units),
    calibrated: !!scale,
    frames: m.frames,
  };
}
