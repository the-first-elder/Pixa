import { NextResponse } from 'next/server';
import { getScene, latestJobForScene } from '@/lib/store';

/**
 * GET /api/scenes/:sceneId — scene manifest + supported capabilities.
 * Until Stage 1 produces a real asset, capabilities are honestly all-false
 * and there is no manifest — never a fabricated scene.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  if (!scene) return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  return NextResponse.json({
    scene,
    manifest: null,
    capabilities: {
      navigation: false,
      objectHighlight: false,
      routes: false,
      measurement: false,
      coverage: false,
    },
    viewpoints: [],
    latestJob: latestJobForScene(scene.id),
  });
}
