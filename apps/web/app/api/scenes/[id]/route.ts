import { NextRequest, NextResponse } from 'next/server';
import { assertManifestVersion } from '@pixa/scene-schema';
import { getScene, latestJobForScene, updateScene } from '@/lib/store';
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

/**
 * PATCH /api/scenes/:sceneId — update name or visibility.
 * Body: { "name"?: string, "visibility"?: "public"|"private" }
 * Public sharing is explicit; scenes default to private.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  if (!scene) return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  let body: { name?: unknown; visibility?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const patch: { name?: string; visibility?: 'public' | 'private' } = {};
  if (typeof body.name === 'string' && body.name.trim()) {
    patch.name = body.name.trim().slice(0, 200);
  }
  if (body.visibility === 'public' || body.visibility === 'private') {
    patch.visibility = body.visibility;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update (name, visibility)' }, { status: 400 });
  }
  const updated = updateScene(id, patch);
  return NextResponse.json({ sceneId: updated.id, name: updated.name, visibility: updated.visibility });
}
