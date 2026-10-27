/**
 * Coverage map from real registration data (Stage 7 / Feature 11, basic).
 * Run: npx tsx scripts/coverage.mts --scene <id>
 * Reads the job's sparse model (registered frames) + extracted frame count,
 * writes index.coverage = {registered/total/ranges/gaps}. Derived ONLY from
 * processing diagnostics — never from model prose.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sceneId = arg('scene');
if (!sceneId) {
  console.error('Usage: coverage.mts --scene <id>');
  process.exit(2);
}
const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');

const jobs = JSON.parse(readFileSync(join(storage, 'jobs.json'), 'utf8')) as Record<
  string,
  { sceneId: string; status: string; asset?: { posesPath?: string } | null; diagnostics?: { framesB?: number } | null }
>;
const job = Object.values(jobs).find((j) => j.sceneId === sceneId && j.status === 'ready');
if (!job) {
  console.error('No ready job for scene');
  process.exit(2);
}
// Registered B-frames from images.bin names.
const registered: number[] = [];
const sparse = job.asset?.posesPath;
if (sparse && existsSync(join(sparse, 'images.bin'))) {
  const data = readFileSync(join(sparse, 'images.bin'));
  let off = 8;
  const n = Number(data.readBigUInt64LE(0));
  for (let k = 0; k < n; k++) {
    off += 4 + 32 + 24 + 4;
    let s = '';
    while (data[off] !== 0) { s += String.fromCharCode(data[off]); off++; }
    off += 1;
    const npts = Number(data.readBigUInt64LE(off)); off += 8 + npts * 24;
    const m = basename(s).match(/^(\d+)\.jpg$/);
    if (m) registered.push(parseInt(m[1], 10));
  }
}
registered.sort((a, b) => a - b);
// Total extracted B-frames: highest frame number seen in the job workdir.
const workBase = join(storage, 'work');
let total = 0;
try {
  for (const jid of readdirSync(workBase)) {
    const imgDir = join(workBase, jid, 'spirula', 'workspace', 'images');
    if (!existsSync(imgDir)) continue;
    for (const f of readdirSync(imgDir)) {
      const m = f.match(/^(\d+)\.jpg$/);
      if (m) total = Math.max(total, parseInt(m[1], 10));
    }
  }
  } catch { /* no local workdirs (e.g. imported asset) */ }
if (typeof job.diagnostics?.framesB === 'number' && job.diagnostics.framesB > total) {
  total = job.diagnostics.framesB;
}
if (total === 0 && registered.length > 0) total = Math.max(...registered);
const regSet = new Set(registered);
// Ranges + gaps over 1..total.
function ranges(nums: number[]): [number, number][] {
  const out: [number, number][] = [];
  let s = -1; let p = -2;
  for (const v of nums) {
    if (v !== p + 1) { if (s >= 0) out.push([s, p]); s = v; }
    p = v;
  }
  if (s >= 0) out.push([s, p]);
  return out;
}
const gaps: number[] = [];
for (let i = 1; i <= total; i++) if (!regSet.has(i)) gaps.push(i);
const coverage = {
  registeredFrames: registered.length,
  totalFrames: total,
  percent: total > 0 ? Math.round((registered.length / total) * 100) : 0,
  registeredRanges: ranges(registered),
  gapRanges: ranges(gaps),
  derivedFrom: 'sparse-model registration + extracted frame count',
};
const indexPath = join(storage, 'index', `${sceneId}.json`);
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
index.coverage = coverage;
writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`coverage: ${coverage.registeredFrames}/${coverage.totalFrames} (${coverage.percent}%)`);
console.log(`gaps: ${coverage.gapRanges.map(([a, b]) => `${a}-${b}`).join(', ') || 'none'}`);
