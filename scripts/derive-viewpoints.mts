/**
 * Derive navigation viewpoints from real COLMAP sparse poses (Stage 4).
 * Run: npx tsx scripts/derive-viewpoints.mts --scene <id>
 * Reads the job's posesPath (sparse/0/images.bin), computes camera centers,
 * writes viewpoints[] into STORAGE_DIR/index/<scene>.json. Pure geometry —
 * no invented positions; empty poses -> no viewpoints.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sceneId = arg('scene');
if (!sceneId) {
  console.error('Usage: derive-viewpoints.mts --scene <id>');
  process.exit(2);
}
const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');

const jobs = JSON.parse(readFileSync(join(storage, 'jobs.json'), 'utf8')) as Record<
  string,
  { sceneId: string; status: string; asset?: { posesPath?: string } | null }
>;
const job = Object.values(jobs).find(
  (j) => j.sceneId === sceneId && j.status === 'ready' && j.asset?.posesPath,
);
if (!job?.asset?.posesPath || !existsSync(join(job.asset.posesPath, 'images.bin'))) {
  console.log('No COLMAP poses for scene; writing no viewpoints.');
  process.exit(0);
}
const data = readFileSync(join(job.asset.posesPath, 'images.bin'));
let off = 8;
const n = Number(data.readBigUInt64LE(0));
type Vec3 = [number, number, number];
const centers: Vec3[] = [];
const forwards: Vec3[] = [];
for (let k = 0; k < n; k++) {
  off += 4; // image_id
  const qw = data.readDoubleLE(off); const qx = data.readDoubleLE(off + 8);
  const qy = data.readDoubleLE(off + 16); const qz = data.readDoubleLE(off + 24);
  off += 32;
  const tx = data.readDoubleLE(off); const ty = data.readDoubleLE(off + 8); const tz = data.readDoubleLE(off + 16);
  off += 24;
  off += 4; // camera_id
  while (data[off] !== 0) off++;
  off += 1; // name
  const npts = Number(data.readBigUInt64LE(off)); off += 8 + npts * 24;
  // R from unit quaternion (COLMAP world->cam), C = -R^T t
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
  centers.push(C);
  forwards.push([R[0][2], R[1][2], R[2][2]]);
}
const mean: Vec3 = [
  centers.reduce((s, c) => s + c[0], 0) / centers.length,
  centers.reduce((s, c) => s + c[1], 0) / centers.length,
  centers.reduce((s, c) => s + c[2], 0) / centers.length,
];
const radius = Math.max(...centers.map((c) => Math.hypot(c[0] - mean[0], c[1] - mean[1], c[2] - mean[2])), 0.5);
// Overview: above-outside the capture volume, looking at its center.
// Listed LAST: the initial camera should be a real interior capture pose,
// not an exterior view through sparse walls.
const overview = {
  id: 'vp_overview',
  label: 'Overview',
  position: [mean[0], mean[1] + radius * 0.9, mean[2] + radius * 1.8] as Vec3,
  target: mean,
};
const viewpoints: typeof overview[] = [];
// A few capture-faithful viewpoints: evenly spaced real camera positions,
// all looking at the scene center. (Per-frame recorded view directions can
// tilt at floors/ceilings; the center-look is robust for an initial view.)
const step = Math.max(1, Math.floor(centers.length / 4));
for (let i = 0; i < centers.length && viewpoints.length < 5; i += step) {
  viewpoints.push({
    id: `vp_capture_${viewpoints.length + 1}`,
    label: `Captured view ${viewpoints.length + 1}`,
    position: centers[i],
    target: mean,
  });
}
const indexPath = join(storage, 'index', `${sceneId}.json`);
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { viewpoints?: unknown[] };
viewpoints.push(overview);
index.viewpoints = viewpoints;
writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`viewpoints: ${viewpoints.length} (from ${n} poses, radius ${radius.toFixed(2)})`);
for (const v of viewpoints) console.log(`  ${v.id}: pos=${v.position.map((p) => p.toFixed(2)).join(',')}`);
