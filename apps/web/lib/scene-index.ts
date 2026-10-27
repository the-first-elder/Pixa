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

export interface SceneIndex {
  status: 'pending' | 'partial' | 'ready';
  entities: IndexEntity[];
  relationships: IndexRelationship[];
  viewpoints: IndexViewpoint[];
}

export function getSceneIndex(sceneId: string): SceneIndex {
  const path = join(STORAGE_DIR, 'index', `${sceneId}.json`);
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      entities?: IndexEntity[];
      relationships?: IndexRelationship[];
      viewpoints?: IndexViewpoint[];
    };
    const entities = data.entities ?? [];
    const status = entities.length === 0 ? 'pending' : 'partial';
    return {
      status,
      entities,
      relationships: data.relationships ?? [],
      viewpoints: data.viewpoints ?? [],
    };
  } catch {
    return { status: 'pending', entities: [], relationships: [], viewpoints: [] };
  }
}

/** Find entities by case-insensitive label substring. Empty index → []. */
export function findByLabel(index: SceneIndex, label: string): IndexEntity[] {
  const q = label.trim().toLowerCase();
  if (!q) return [];
  return index.entities.filter((e) => e.label.toLowerCase().includes(q));
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
