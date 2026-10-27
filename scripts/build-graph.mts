/**
 * Stage 4 scene graph: relationships with provenance (PRD §10).
 * Run: npx tsx scripts/build-graph.mts --scene <id> [--yes]
 * - near: pairwise registered positions within threshold (provenance: geometry).
 * - contains/connects_to: Spark proposes regions from the entity list;
 *   stored as INFERRED, never verified. No invented rooms: regions must
 *   reference only indexed entities.
 * Writes entities (appends region entities) + relationships into the index.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sceneId = arg('scene');
if (!sceneId) {
  console.error('Usage: build-graph.mts --scene <id> [--yes]');
  process.exit(2);
}
const confirmed = process.argv.includes('--yes');
const root = join(new URL('.', import.meta.url).pathname, '..');
const storage = process.env.STORAGE_DIR ?? join(root, 'data');

type Vec3 = [number, number, number];
interface Entity {
  id: string; type: string; label: string; status: string;
  position: Vec3 | null; spatialRegistrationStatus?: string;
  coordinateProvenance?: string | null; evidence: { frames: number[] };
}
interface Relationship { source: string; target: string; type: string; status: string }

const indexPath = join(storage, 'index', `${sceneId}.json`);
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  entities: Entity[]; relationships: Relationship[];
};
const registered = index.entities.filter((e) => e.position !== null);
if (registered.length === 0) {
  console.log('No registered entities; nothing to relate. Run register-entities first.');
  process.exit(0);
}
// Scene scale from registered spread.
const mean: Vec3 = [0, 1, 2].map((i) =>
  registered.reduce((s, e) => s + (e.position as Vec3)[i], 0) / registered.length) as Vec3;
const radius = Math.max(...registered.map((e) => {
  const p = e.position as Vec3;
  return Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]);
}), 1e-6);

// near: geometric proximity (provenance: approximate geometry -> inferred).
const near: Relationship[] = [];
// "Beside" = each entity's 2 nearest registered neighbors within half the
// scene span. Bounded (~2N edges) and local, unlike a radius threshold which
// turns the whole room into one clique.
{
  const seen = new Set<string>();
  for (const a of registered) {
    const ap = a.position as Vec3;
    const others = registered
      .filter((b) => b.id !== a.id)
      .map((b) => {
        const bp = b.position as Vec3;
        return { b, d: Math.hypot(ap[0] - bp[0], ap[1] - bp[1], ap[2] - bp[2]) };
      })
      .filter(({ d }) => d <= radius * 0.5)
      .sort((x, y) => x.d - y.d)
      .slice(0, 2);
    for (const { b, d } of others) {
      const k1 = `${a.id}|${b.id}`;
      const k2 = `${b.id}|${a.id}`;
      if (seen.has(k1) || seen.has(k2)) continue;
      seen.add(k1);
      near.push({ source: a.id, target: b.id, type: 'near', status: 'inferred' });
      console.log(`  near: ${a.label} <-> ${b.label} (${d.toFixed(2)})`);
    }
  }
}

// Regions via Spark (inferred; constrained to indexed entities only).
const { chat } = await import('@worldlens/model-adapters');
const listing = index.entities.map((e) => `- ${e.label} [${e.type}] id=${e.id}`).join('\n');
console.log('--- spark region proposal ---');
const r = await chat({
  messages: [{
    role: 'user',
    content: `You are organizing a room's indexed objects into regions. Entities:\n${listing}\n\nReturn JSON: {"regions": [{"label": "...", "memberIds": ["..."]}], "connections": [{"from": "<region label>", "to": "<region label>", "via": "<entity id of a doorway or opening>"}]}. Rules: use ONLY the listed entity ids; 1-4 regions; every region needs >=1 member; connections only where a doorway/opening plausibly links two regions, else []. No explanation.`,
  }],
  responseFormat: {
    type: 'json_schema',
    json_schema: {
      name: 'regions',
      schema: {
        type: 'object',
        properties: {
          regions: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, memberIds: { type: 'array', items: { type: 'string' } } }, required: ['label', 'memberIds'], additionalProperties: false } },
          connections: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, via: { type: 'string' } }, required: ['from', 'to', 'via'], additionalProperties: false } },
        },
        required: ['regions', 'connections'],
        additionalProperties: false,
      },
    },
  },
  maxTokens: 2048,
});
let proposal: { regions: { label: string; memberIds: string[] }[]; connections: { from: string; to: string; via: string }[] } = { regions: [], connections: [] };
try {
  const parsed = JSON.parse(r.content ?? '{}') as Partial<typeof proposal>;
  if (Array.isArray(parsed.regions) && Array.isArray(parsed.connections)) {
    proposal = { regions: parsed.regions, connections: parsed.connections };
  } else {
    console.log('region proposal has unexpected shape; keeping geometric relations only');
  }
} catch {
  console.log('region proposal unparseable; keeping geometric relations only');
}
const validIds = new Set(index.entities.map((e) => e.id));
const newEntities: Entity[] = [];
const rels: Relationship[] = [...near];
const regionIdByLabel = new Map<string, string>();
proposal.regions.slice(0, 4).forEach((rg, i) => {
  const members = [...new Set(rg.memberIds)].filter((id) => validIds.has(id));
  if (!rg.label || members.length === 0) return;
  const rid = `region_${String(index.entities.length + i + 1).padStart(2, '0')}`;
  regionIdByLabel.set(rg.label, rid);
  const frames = [...new Set(members.flatMap((m) => index.entities.find((e) => e.id === m)?.evidence.frames ?? []))].sort((a, b) => a - b);
  newEntities.push({ id: rid, type: 'region', label: rg.label.trim(), status: 'inferred', position: null, evidence: { frames } });
  for (const m of members) rels.push({ source: rid, target: m, type: 'contains', status: 'inferred' });
  console.log(`  region: ${rg.label} <- ${members.join(', ')}`);
});
for (const c of proposal.connections ?? []) {
  const a = regionIdByLabel.get(c.from); const b = regionIdByLabel.get(c.to);
  if (!a || !b || !validIds.has(c.via)) continue;
  rels.push({ source: a, target: b, type: 'connects_to', status: 'inferred' });
  console.log(`  connects: ${c.from} -> ${c.to} via ${c.via}`);
}
console.log(`geometric near: ${near.length}, regions: ${newEntities.length}`);
if (!confirmed) {
  console.log('Dry run. Re-run with --yes to write.');
  process.exit(0);
}
// Rebuilds are idempotent: drop previously inferred regions + their edges
// first (fresh proposal each run), but NEVER drop geometric edges or objects.
// If the proposal failed this run, keep the previous regions.
if (newEntities.length > 0) {
  const newLabels = new Set(newEntities.map((e) => e.label));
  const dropIds = new Set(
    index.entities.filter((e) => e.type === 'region' && newLabels.has(e.label)).map((e) => e.id),
  );
  index.entities = index.entities.filter((e) => !dropIds.has(e.id));
  index.relationships = index.relationships.filter(
    (r) => !dropIds.has(r.source) && !dropIds.has(r.target),
  );
  for (const e of newEntities) index.entities.push(e);
} else {
  console.log('keeping previous regions (no fresh proposal)');
}
// Dedupe remaining (geometric) relationships.
const key = (x: Relationship) => `${x.source}|${x.target}|${x.type}`;
const existing = new Set(index.relationships.map(key));
for (const rel of rels) if (!existing.has(key(rel))) index.relationships.push(rel);
for (const e of newEntities) index.entities.push(e);
writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(`wrote ${index.relationships.length} relationships, ${index.entities.length} entities`);
