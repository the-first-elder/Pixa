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
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseCameras, parseImages, project, rayFromPixel, missDistance, type Vec3, type Box, type Pose } from './colmap-utils.mts';
import { loadMeshAnchor } from './mesh-anchor.mts';

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

interface Detection { frame: string; frameIdx: number; label: string; boxes: Box[] }

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
function triangulate(rays: { origin: Vec3; dir: Vec3 }[], weights?: number[]): { point: Vec3; residual: number } | null {
  // Robustify: one bad ray (edge snap) can pull the LS point behind ITS
  // camera and null the whole fit. Prune worst offenders (max 3) and refit;
  // gates still apply to the final fit, so this adds robustness, not laxity.
  let allow = rays.map(() => true);
  for (let round = 0; round <= 3; round++) {
    const kept = rays.filter((_, i) => allow[i]);
    const keptW = weights?.filter((_, i) => allow[i]);
    if (kept.length < 2) return null;
    const fit = triangulateOnce(kept, keptW);
    if (!fit) return null;
    if (!fit.behind) return { point: fit.point, residual: fit.residual };
    // Drop the ray whose camera the point is furthest behind, refit.
    let worst = -1, worstAlong = 0;
    for (let i = 0; i < rays.length; i++) {
      if (!allow[i]) continue;
      const C = rays[i].origin, d = rays[i].dir, p = fit.point;
      const along = (p[0] - C[0]) * d[0] + (p[1] - C[1]) * d[1] + (p[2] - C[2]) * d[2];
      if (along < worstAlong) { worstAlong = along; worst = i; }
    }
    if (worst < 0) return { point: fit.point, residual: fit.residual };
    allow[worst] = false;
  }
  return null;
}

function triangulateOnce(rays: { origin: Vec3; dir: Vec3 }[], weights?: number[]): { point: Vec3; residual: number; behind: boolean } | null {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b: Vec3 = [0, 0, 0];
  for (let k = 0; k < rays.length; k++) {
    const { origin: C, dir: d } = rays[k];
    const w = weights?.[k] ?? 1;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const delta = (i === j ? 1 : 0) - d[i] * d[j];
      A[i][j] += w * delta;
      b[i] += w * delta * C[j];
    }
  }
  const p = solve3(A, b);
  if (!p || !p.every(Number.isFinite)) return null;
  let res = 0, behind = false;
  for (const { origin: C, dir: d } of rays) {
    const v: Vec3 = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
    const along = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
    if (along <= 0) behind = true; // caller decides: prune-and-refit
    const px: Vec3 = [C[0] + d[0] * along, C[1] + d[1] * along, C[2] + d[2] * along];
    res += Math.hypot(p[0] - px[0], p[1] - px[1], p[2] - px[2]);
  }
  return { point: p, residual: res / rays.length, behind };
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
  entities: { id: string; type: string; label: string; status: string; position: Vec3 | null; evidence: { frames: number[] }; trackId?: string; instance?: number }[];
};
let detections: Detection[] = [];
try {
  detections = JSON.parse(readFileSync(join(storage, 'index', `${sceneId}.detections.json`), 'utf8') as string);
} catch { /* track-only scenes have no frame detections */ }
interface TrackObs { j: number; frame: string; m: number; box: Box; c?: number }
interface Track { id: string; label: string; obs: TrackObs[] }
let tracks: { clip: { reconClip?: boolean; W: number; H: number }; tracks: Track[] } | null = null;
try {
  tracks = JSON.parse(readFileSync(join(storage, 'index', `${sceneId}.tracks.json`), 'utf8') as string);
} catch { /* frame-path scenes have no tracks */ }
// Frame-path detection boxes live in the DETECTION images' pixels (usually
// Pipeline-A analysis frames, e.g. 1280px), while poses/K fit the workspace
// B-frames (e.g. 1600px). Derive the scale from the actual files; never 1.0
// by assumption (measured 1.25x on scene_d7259e7e — silently wrong rays).
let frameScale = 1;
let frameScaleReady = false;
function detectionScale(): number {
  if (frameScaleReady) return frameScale;
  frameScaleReady = true;
  if (detections.length === 0) return frameScale;
  const wsImages = join(sparse, '..', '..', 'images');
  const probeFile = join(storage, 'assets', sceneId, 'frames', detections[0].frame);
  try {
    const jp = (f: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', f]).toString()) as { streams: [{ width: number; height: number }] };
    const a = jp(probeFile).streams[0];
    const firstB = readdirSync(wsImages).filter((f: string) => f.endsWith('.jpg')).sort()[0];
    const b = jp(join(wsImages, firstB)).streams[0];
    if (Math.abs((a.width / a.height) - (b.width / b.height)) / (a.width / a.height) > 0.01) {
      throw new Error(`aspect ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    }
    frameScale = b.width / a.width;
    console.log(`frame-path box scale: ${frameScale.toFixed(4)} (detection ${a.width}x${a.height} -> workspace ${b.width}x${b.height})`);
  } catch (e) {
    console.error(`Cannot derive detection-box scale (${(e as Error).message}) — refusing to register frame-path entities on unscaled pixels.`);
    process.exit(2);
  }
  return frameScale;
}

// Recon-clip sidecars only: source-index sidecars encode the (M-1)*15 mapping,
// which is WRONG for VFR/edit-shifted sources (measured +6f). Refuse them.
if (tracks && !tracks.clip.reconClip) {
  console.error('Stale tracks sidecar (source-index mapping — known wrong). Re-run track-scene.mts and retry.');
  process.exit(2);
}
// Track boxes are in workspace-JPEG pixels by construction (recon clip is a
// native-dim re-encode). Assert dims match; no scaling, no mapping.
if (tracks) {
  const wsImages = join(sparse, '..', '..', 'images');
  const first = readdirSync(wsImages).filter((f: string) => f.endsWith('.jpg')).sort()[0];
  const jp = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', join(wsImages, first)]).toString()) as { streams: [{ width: number; height: number }] };
  if (jp.streams[0].width !== tracks.clip.W || jp.streams[0].height !== tracks.clip.H) {
    console.error(`Dims mismatch: tracks ${tracks.clip.W}x${tracks.clip.H} vs frames ${jp.streams[0].width}x${jp.streams[0].height}. Aborting.`);
    process.exit(2);
  }
  console.log(`tracks: recon-clip sidecar, ${tracks.tracks.length} tracks, coords 1:1 with workspace frames`);
}

// Scene scale for relative residual gate.
const centers = [...poses.values()].map((p) => p.center);
const mean: Vec3 = [0, 1, 2].map((i) => centers.reduce((s, c) => s + c[i], 0) / centers.length) as Vec3;
const radius = Math.max(...centers.map((c) => Math.hypot(c[0] - mean[0], c[1] - mean[1], c[2] - mean[2])), 1e-6);

// --- mesh anchoring (shared loader; see mesh-anchor.mts) ---
// Triangulating box centers fails for far/small objects: near-parallel rays
// let RANSAC hallucinate near-path points (measured: "painting" fit 5cm in
// front of the lens with a "tight" 0.027 residual). The reconstruction's own
// surface mesh gives depth directly: cast each box-center ray into the mesh,
// robust median of the hits.
let meshAnchor: Awaited<ReturnType<typeof loadMeshAnchor>> = null;
try {
  meshAnchor = await loadMeshAnchor(storage, sceneId, sparse);
  console.log(meshAnchor ? 'mesh anchor: loaded, BVH ready' : 'mesh anchor: no mesh.glb; triangulation fallback only');
} catch (e) {
  console.log(`mesh anchor unavailable (${(e as Error).message}); triangulation fallback only`);
  meshAnchor = null;
}

let registered = 0;
for (const ent of index.entities) {
  // Observation source: video track (per-instance, confidence-weighted) or
  // frame detections (per-label largest box). Unified into rays + weights.
  interface Ob { box: Box; bName: string; frame: number; w: number }
  const obList: Ob[] = [];
  if (ent.trackId && tracks) {
    const t = tracks.tracks.find((x) => x.id === ent.trackId);
    if (t) {
      for (const o of t.obs) {
        obList.push({
          box: o.box, // already workspace-JPEG pixels (recon clip 1:1)
          bName: o.frame,
          frame: o.m,
          w: o.c ?? 1, // absent confidence = unweighted, never zero-filled
        });
      }
    }
  } else {
    const s = detectionScale();
    for (const d of detections.filter((x) => x.label === ent.label)) {
      // Largest box = most prominent instance in this frame.
      const raw = [...d.boxes].sort((a, b) => (b.xMax - b.xMin) * (b.yMax - b.yMin) - (a.xMax - a.xMin) * (a.yMax - a.yMin))[0];
      if (!raw) continue;
      const box = { xMin: raw.xMin * s, yMin: raw.yMin * s, xMax: raw.xMax * s, yMax: raw.yMax * s };
      obList.push({ box, bName: String(2 * d.frameIdx - 1).padStart(4, '0') + '.jpg', frame: d.frameIdx, w: 1 });
    }
  }
  // Dedupe: adjacent source frames (±1 tolerance) map to the same B-frame.
  // One ray per B-frame (highest confidence) — duplicates overweight frames
  // and double RANSAC cost without adding geometry.
  if (ent.trackId && tracks) {
    const byB = new Map<string, (typeof obList)[number]>();
    for (const ob of obList) {
      const cur = byB.get(ob.bName);
      if (!cur || ob.w > cur.w) byB.set(ob.bName, ob);
    }
    obList.length = 0;
    obList.push(...[...byB.values()].sort((a, b) => a.frame - b.frame));
  }
  interface Ray { origin: Vec3; dir: Vec3; frame: number; w: number; box: Box; pose: Pose; K: { fx: number; fy: number; cx: number; cy: number } }
  const rays: Ray[] = [];
  for (const ob of obList) {
    const pose = poses.get(ob.bName);
    const K = pose ? intrinsics.get(pose.cameraId) : undefined;
    if (!pose || !K) continue;
    const { origin, dir } = rayFromPixel((ob.box.xMin + ob.box.xMax) / 2, (ob.box.yMin + ob.box.yMax) / 2, pose, K);
    rays.push({ origin, dir, frame: ob.frame, w: ob.w, box: ob.box, pose, K });
  }
  const fromTrack = ent.trackId !== undefined && tracks !== null;
  const tag = `${ent.label}${fromTrack ? ` [track ${ent.trackId}]` : ''}`;
  /** Evidence-wide median miss distance (px) — the selector between methods. */
  const score = (p: Vec3): number => {
    const ds = rays.map((r) => missDistance(project(p, r.pose, r.K), r.box)).sort((a, b) => a - b);
    return ds.length ? ds[Math.floor(ds.length / 2)] : Infinity;
  };

  // Candidate 1: mesh-median. Cast every box-center ray into the collision
  // mesh; robust median of surface hits. Immune to parallax collapse; the
  // median tolerates jittered box centers (occlusion shifts extents).
  // Pre-gate: ≥3 hits (absolute — holey meshes shouldn't veto; the
  // reprojection score below judges quality, not the hit count).
  let meshPos: Vec3 | null = null;
  let meshNote = 'mesh unavailable';
  if (meshAnchor && rays.length >= 2) {
    const hits: Vec3[] = [];
    for (const r of rays) {
      const h = meshAnchor.raycast(r.origin, r.dir);
      if (h) hits.push(h);
    }
    meshNote = `mesh hits=${hits.length}/${rays.length}`;
    if (hits.length >= 3) {
      meshPos = [0, 1, 2].map((i) => {
        const s = hits.map((h) => h[i]).sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      }) as Vec3;
    }
  }
  // Candidate 2: RANSAC-lite + weighted least squares over ray pairs.
  // Multi-instance detections produce outlier rays; keep the largest
  // consensus set. Pre-gates are structural (≥3 rays, angle, residual);
  // accuracy is judged by reprojection below, not by proxy thresholds.
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
  // Track obs are dense: afford a tighter consensus (0.05 vs 0.10) so mixed
  // instances (ID drift across similar objects) split instead of poisoning
  // the fit. Strictly more conservative — gates below are unchanged.
  const inlierTol = fromTrack ? radius * 0.05 : radius * 0.1;
  let best: Ray[] | null = null;
  for (let i = 0; i < rays.length; i++) for (let j = i + 1; j < rays.length; j++) {
    const pm = pairMidpoint(rays[i], rays[j]);
    if (!pm) continue;
    const inliers = rays.filter((r) => distToRay(pm.mid, r) < inlierTol);
    if (inliers.length >= 2 && (!best || inliers.length > best.length)) best = inliers;
  }
  const consensus = best ?? rays;
  let triPos: Vec3 | null = null;
  let triNote = '';
  if (consensus.length >= 3) {
    let maxAngle = 0;
    for (let i = 0; i < consensus.length; i++) for (let j = i + 1; j < consensus.length; j++) {
      const dot = Math.min(1, Math.abs(consensus[i].dir[0] * consensus[j].dir[0] + consensus[i].dir[1] * consensus[j].dir[1] + consensus[i].dir[2] * consensus[j].dir[2]));
      maxAngle = Math.max(maxAngle, Math.acos(dot) * 180 / Math.PI);
    }
    if (maxAngle >= 1.5) {
      const tri = triangulate(consensus, fromTrack ? consensus.map((r) => r.w) : undefined);
      if (tri && tri.residual / radius <= 0.15) {
        triPos = tri.point;
        triNote = `residual=${(tri.residual / radius).toFixed(3)} inliers=${consensus.length}/${rays.length}`;
      } else {
        triNote = `residual=${tri ? (tri.residual / radius).toFixed(3) : 'fail'}`;
      }
    } else {
      triNote = `maxAngle=${maxAngle.toFixed(1)}°`;
    }
  } else {
    triNote = 'no consensus triple';
  }
  // Select by evidence-wide reprojection (direct fitness measure): lower
  // median miss wins; near-ties go to mesh (cannot collapse; tri ties at 0px
  // are equally perfect anyway). Register iff the winner reprojects within
  // 100px median (app-grade: flight targets need ~0.5m, this is inside).
  // Exact scores logged; per-position error persisted on the entity.
  const meshScore = meshPos ? score(meshPos) : Infinity;
  const triScore = triPos ? score(triPos) : Infinity;
  const useMesh = meshPos !== null && meshScore <= triScore + 1;
  const winScore = useMesh ? meshScore : triScore;
  const winNote = useMesh ? meshNote : `tri ${triNote}`;
  if ((!meshPos && !triPos) || winScore > 100) {
    console.log(`  ${tag}: unregistered (mesh=${meshScore === Infinity ? meshNote : meshScore.toFixed(0) + 'px'} tri=${triScore === Infinity ? triNote : triScore.toFixed(0) + 'px'})`);
    continue;
  }
  const winner = (useMesh ? meshPos : triPos)!;
  const method = useMesh ? 'mesh-median-sam-v1' : (fromTrack ? 'triangulated-sam-track-v1' : 'triangulated-sam-box-centers-v1');
  if (!fromTrack) {
    // Refresh evidence from current detections (A-indices, as index-scene
    // writes them; registration maps A->B internally for pose lookup).
    ent.evidence = { frames: [...new Set(detections.filter((x) => x.label === ent.label).map((x) => x.frameIdx))].sort((a, b) => a - b) };
  }
  ent.position = winner;
  (ent as Record<string, unknown>).spatialRegistrationStatus = 'registered';
  (ent as Record<string, unknown>).coordinateProvenance = method;
  (ent as Record<string, unknown>).reprojectionMissMedianPx = Math.round(winScore);
  registered++;
  console.log(`  ${tag}: REGISTERED[${useMesh ? 'mesh' : 'tri'}] @(${winner.map((p) => p.toFixed(2)).join(',')}) missMed=${winScore.toFixed(0)}px [${winNote}] (alt=${useMesh ? (triScore === Infinity ? triNote : triScore.toFixed(0) + 'px') : (meshScore === Infinity ? meshNote : meshScore.toFixed(0) + 'px')})`);
}
writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`registered: ${registered}/${index.entities.length}`);
