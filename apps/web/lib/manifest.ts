/**
 * Manifest builder (server-only). Turns the latest READY reconstruction job
 * into a versioned SceneManifest (packages/scene-schema). No ready job with
 * a verified asset -> manifest is null, and the viewer shows an honest
 * empty state. Never a fabricated scene.
 */
import 'server-only';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_VERSION, type SceneManifest } from '@pixa/scene-schema';
import { readyAssetForScene } from './store';
import { STORAGE_DIR } from './config';

export function manifestForScene(sceneId: string): SceneManifest | null {
  const asset = readyAssetForScene(sceneId);
  // Only formats verified end-to-end (PLY, SPZ). Anything else -> no manifest.
  if (!asset || !['ply', 'spz'].includes(asset.format)) return null;
  const meshPath = join(STORAGE_DIR, 'assets', sceneId, 'mesh.glb');
  const meshLocation = existsSync(meshPath)
    ? `/api/scenes/${encodeURIComponent(sceneId)}/mesh`
    : null;
  let viewpoints: SceneManifest['viewpoints'] = [];
  let upCorrection: SceneManifest['upCorrection'] = null;
  try {
    const index = JSON.parse(
      readFileSync(join(STORAGE_DIR, 'index', `${sceneId}.json`), 'utf8'),
    ) as { viewpoints?: SceneManifest['viewpoints']; upCorrection?: SceneManifest['upCorrection'] };
    if (Array.isArray(index.viewpoints)) viewpoints = index.viewpoints;
    if (index.upCorrection && Array.isArray(index.upCorrection.quaternion)) {
      upCorrection = index.upCorrection;
    }
  } catch {
    viewpoints = [];
  }
  return {
    version: MANIFEST_VERSION,
    sceneId,
    asset: {
      assetId: asset.jobId,
      assetType: 'splat',
      format: asset.format as SceneManifest['asset']['format'],
      location: `/api/scenes/${encodeURIComponent(sceneId)}/asset`,
      meshLocation,
      sizeBytes: null,
    },
    coordinateSystem: asset.posesFormat ?? 'unknown',
    upCorrection,
    viewpoints,
    capabilities: {
      navigation: true, // orbit + camera transitions on the real asset
      objectHighlight: false, // needs registered positions (Stage 3)
      routes: false, // needs scene graph (Stage 4)
      measurement: false, // needs validated metric geometry (Stage 8)
      coverage: false, // needs coverage map (Stage 7)
    },
    sceneIndexStatus: 'pending',
    diagnosticsChecksum: null,
    createdAt: new Date().toISOString(),
  };
}
