/**
 * @worldlens/scene-schema — versioned scene manifest + graph schema (PRD §§ 10.5, 11.4).
 * Manifest version is checked on load; unknown versions are rejected, never guessed.
 */
import type {
  EntityType,
  ProvenanceStatus,
  RelationshipType,
  SceneCapabilities,
  VisualStatus,
  SpatialRegistrationStatus,
} from '@worldlens/shared-types';

export const MANIFEST_VERSION = 1 as const;
export const GRAPH_VERSION = 1 as const;

export type AssetType = 'splat' | 'mesh-preview';
export type AssetFormat = 'spz' | 'sog' | 'ply' | 'ksplat' | 'splat' | 'glb';

export interface Viewpoint {
  id: string;
  label: string;
  description: string | null;
  /** Camera position/target in scene coordinates. Null when derived viewpoints unavailable. */
  position: [number, number, number] | null;
  target: [number, number, number] | null;
}

export interface SceneManifest {
  version: typeof MANIFEST_VERSION;
  sceneId: string;
  asset: {
    assetId: string;
    assetType: AssetType;
    format: AssetFormat;
    /** Storage key or signed URL. Resolved server-side for private scenes. */
    location: string;
    /** Optional collision mesh for room-scale walking. Same access rules. */
    meshLocation?: string | null;
    sizeBytes: number | null;
  };
  coordinateSystem: string;
  /** Rigid rotation (COLMAP frame -> gravity-levelled frame), if estimated. */
  upCorrection: { quaternion: [number, number, number, number] } | null;
  viewpoints: Viewpoint[];
  capabilities: SceneCapabilities;
  sceneIndexStatus: 'pending' | 'partial' | 'ready' | 'failed';
  diagnosticsChecksum: string | null;
  createdAt: string;
}

export interface GraphEntity {
  id: string;
  type: EntityType;
  label: string;
  status: ProvenanceStatus;
  visualStatus: VisualStatus;
  spatialRegistrationStatus: SpatialRegistrationStatus;
  position: [number, number, number] | null;
  evidence: { frames: number[] };
}

export interface GraphRelationship {
  source: string;
  target: string;
  type: RelationshipType;
  status: ProvenanceStatus;
}

export interface SceneGraph {
  version: typeof GRAPH_VERSION;
  sceneId: string;
  entities: GraphEntity[];
  relationships: GraphRelationship[];
}

/** Reject manifests we cannot understand — never render a guessed layout. */
export function assertManifestVersion(manifest: { version: number }): void {
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `Unsupported manifest version ${manifest.version} (expected ${MANIFEST_VERSION})`,
    );
  }
}
