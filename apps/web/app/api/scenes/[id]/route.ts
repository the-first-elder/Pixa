import { NextResponse } from 'next/server';
import { assertManifestVersion } from '@worldlens/scene-schema';
import { getScene, latestJobForScene } from '@/lib/store';
import { getSceneIndex } from '@/lib/scene-index';
import { manifestForScene } from '@/lib/manifest';

/**
 * GET /api/scenes/:sceneId — scene manifest + supported capabilities.
 * Manifest comes from the latest READY job with a verified asset; otherwise
 * null with all-false capabilities — never a fabricated scene.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  if (!scene) return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  const manifest = manifestForScene(scene.id);
  if (manifest) assertManifestVersion(manifest);
  return NextResponse.json({
    scene,
    manifest,
    capabilities: manifest?.capabilities ?? {
      navigation: false,
      objectHighlight: false,
      routes: false,
      measurement: false,
      coverage: false,
    },
    viewpoints: [],
    latestJob: latestJobForScene(scene.id),
    coverage: getSceneIndex(scene.id).coverage ?? null,
  });
}
