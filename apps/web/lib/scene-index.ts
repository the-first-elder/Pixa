/**
 * Scene-index access (server-only). Stages 3–4 populate
 * STORAGE_DIR/index/<sceneId>.json with { entities, relationships, viewpoints }.
 * Until then this returns an explicit `pending` index — the assistant then
 * answers honestly about the scene having no indexed entities yet.
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_DIR } from './config';

export interface IndexEntity {
  id: string;
  type: string;
  label: string;
  status: string;
  position: [number, number, number] | null;
  spatialRegistrationStatus?: 'unregistered' | 'approximate' | 'registered';
  coordinateProvenance?: string | null;
  evidence: { frames: number[] };
}

export interface IndexRelationship {
  source: string;
  target: string;
  type: string;
  status: string;
}

export interface IndexViewpoint {
  id: string;
  label: string;
  position: [number, number, number] | null;
  target: [number, number, number] | null;
}

export interface SceneCoverage {
  registeredFrames: number;
  totalFrames: number;
  percent: number;
  registeredRanges: [number, number][];
  gapRanges: [number, number][];
  derivedFrom: string;
}

export interface SceneIndex {
  status: 'pending' | 'partial' | 'ready';
  entities: IndexEntity[];
  relationships: IndexRelationship[];
  viewpoints: IndexViewpoint[];
  coverage?: SceneCoverage | null;
}

type Vec3 = [number, number, number];

export function getSceneIndex(sceneId: string): SceneIndex {
  const path = join(STORAGE_DIR, 'index', `${sceneId}.json`);
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      entities?: IndexEntity[];
      relationships?: IndexRelationship[];
      viewpoints?: IndexViewpoint[];
      coverage?: SceneCoverage;
    };
    const entities = data.entities ?? [];
    const status = entities.length === 0 ? 'pending' : 'partial';
    return {
      status,
      entities,
      relationships: data.relationships ?? [],
      viewpoints: data.viewpoints ?? [],
      coverage: data.coverage ?? null,
    };
  } catch {
    return { status: 'pending', entities: [], relationships: [], viewpoints: [] };
  }
}

/** First evidence frame with a registered camera pose → viewpoint camera.
 * A-frame N is the same source frame as reconstruction frame 2N-1 (fps grids
 * coincide). Returns null when no evidence frame was posed. */
export function evidenceViewpoint(
  sceneId: string,
  frameIds: number[],
): { position: [number, number, number]; target: [number, number, number] } | null {
  const key = `${sceneId}`;
  let entry = poseCache.get(key);
  if (!entry) {
    entry = loadPoses(sceneId);
    poseCache.set(key, entry);
  }
  if (!entry) return null;
  const { poses, intrinsics, radius } = entry;
  for (const f of [...frameIds].sort((a, b) => a - b)) {
    const pose = poses.get(`${String(2 * f - 1).padStart(4, '0')}.jpg`);
    if (pose) {
      const d = Math.max(0.5, radius * 1.2);
      return {
        position: pose.center,
        target: [
          pose.center[0] + pose.forward[0] * d,
          pose.center[1] + pose.forward[1] * d,
          pose.center[2] + pose.forward[2] * d,
        ],
      };
    }
  }
  return null;
}

const poseCache = new Map<
  string,
  { poses: Map<string, { center: Vec3; forward: Vec3 }>; intrinsics: unknown; radius: number } | null
>();

function loadPoses(
  sceneId: string,
): { poses: Map<string, { center: Vec3; forward: Vec3 }>; intrinsics: unknown; radius: number } | null {
  try {
    const jobs = JSON.parse(readFileSync(join(STORAGE_DIR, 'jobs.json'), 'utf8')) as Record<
      string,
      { sceneId: string; status: string; asset?: { posesPath?: string } | null }
    >;
    const job = Object.values(jobs).find(
      (j) => j.sceneId === sceneId && j.status === 'ready' && j.asset?.posesPath,
    );
    const sparse = job?.asset?.posesPath;
    if (!sparse) return null;
    const data = readFileSync(join(sparse, 'images.bin'));
    let off = 8;
    const n = Number(data.readBigUInt64LE(0));
    const poses = new Map<string, { center: Vec3; forward: Vec3 }>();
    const centers: Vec3[] = [];
    for (let k = 0; k < n; k++) {
      off += 4;
      const qw = data.readDoubleLE(off); const qx = data.readDoubleLE(off + 8);
      const qy = data.readDoubleLE(off + 16); const qz = data.readDoubleLE(off + 24);
      off += 32;
      const tx = data.readDoubleLE(off); const ty = data.readDoubleLE(off + 8); const tz = data.readDoubleLE(off + 16);
      off += 24 + 4;
      let name = '';
      while (data[off] !== 0) { name += String.fromCharCode(data[off]); off++; }
      off += 1;
      const npts = Number(data.readBigUInt64LE(off)); off += 8 + npts * 24;
      const [w, x, y, z] = [qw, qx, qy, qz];
      const R = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
      ];
      const C: Vec3 = [
        -(R[0][0] * tx + R[1][0] * ty + R[2][0] * tz),
        -(R[0][1] * tx + R[1][1] * ty + R[2][1] * tz),
        -(R[0][2] * tx + R[1][2] * ty + R[2][2] * tz),
      ];
      const fwd: Vec3 = [R[0][2], R[1][2], R[2][2]];
      const base = name.split('/').slice(-1)[0];
      poses.set(base, { center: C, forward: fwd });
      centers.push(C);
    }
    const mean: Vec3 = [0, 1, 2].map((i) => centers.reduce((s, c) => s + c[i], 0) / centers.length) as Vec3;
    const radius = Math.max(...centers.map((c) => Math.hypot(c[0] - mean[0], c[1] - mean[1], c[2] - mean[2])), 1e-6);
    return { poses, intrinsics: null, radius };
  } catch {
    return null;
  }
}
export function findByLabel(index: SceneIndex, label: string): IndexEntity[] {
  return matchEntities(index, label).matches;
}

const ATTRIBUTE_WORDS = new Set([
  'blue', 'red', 'green', 'yellow', 'orange', 'purple', 'pink', 'black',
  'white', 'grey', 'gray', 'brown', 'gold', 'golden', 'silver', 'dark',
  'light', 'wooden', 'wood', 'metal', 'steel', 'plastic', 'glass',
  'leather', 'fabric', 'striped', 'floral', 'plain', 'big', 'large',
  'small', 'tall', 'short', 'long', 'round', 'square', 'old', 'new',
]);

function singular(w: string): string {
  if (w.endsWith('ies') && w.length > 3) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && w.length > 2) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 1) return w.slice(0, -1);
  return w;
}

export interface QueryMatch {
  matches: IndexEntity[];
  /** Attribute words the user specified (color/material/size…). */
  attributes: string[];
  /** >1 plausible instance and attributes don't separate them. */
  ambiguous: boolean;
}

/**
 * Attribute-aware entity matching ("the blue towel"): tokenise the query,
 * split attribute adjectives from the noun, match the noun (plural-tolerant)
 * against labels, then rank labels that also carry an attribute word first
 * (SAM/Spark labels often include color: "blue towel"). When several
 * instances remain and nothing separates them, flag ambiguity instead of
 * silently picking one — the caller highlights all and says so.
 */
export function matchEntities(index: SceneIndex, query: string): QueryMatch {
  const tokens = query.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return { matches: [], attributes: [], ambiguous: false };
  const attributes = tokens.filter((t) => ATTRIBUTE_WORDS.has(t));
  const nounTokens = tokens.filter((t) => !ATTRIBUTE_WORDS.has(t)).map(singular);
  const labelSingular = (label: string) =>
    label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);
  const scored: { e: IndexEntity; score: number }[] = [];
  for (const e of index.entities) {
    const lt = labelSingular(e.label);
    const nounHit = nounTokens.length === 0
      ? lt.some((t) => tokens.map(singular).includes(t))
      : nounTokens.some((t) => lt.includes(t));
    if (!nounHit) continue;
    let score = 1;
    if (attributes.some((a) => lt.includes(a))) score += 2;
    if (lt.join(' ') === nounTokens.join(' ')) score += 1;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const matches = scored.map((s) => s.e);
  // Ambiguity clears only when an attribute actually separates instances —
  // two towels are ambiguous even if one label matches the noun exactly.
  const separated =
    attributes.length > 0 && scored.length > 1 && scored[0].score > scored[1].score;
  return { matches, attributes, ambiguous: matches.length > 1 && !separated };
}

/** Nearby entities via explicit graph relationships only — never invented. */
export function relatedEntities(index: SceneIndex, id: string): IndexEntity[] {
  const ids = new Set<string>();
  for (const r of index.relationships) {
    if (r.source === id) ids.add(r.target);
    if (r.target === id) ids.add(r.source);
  }
  return index.entities.filter((e) => ids.has(e.id));
}
