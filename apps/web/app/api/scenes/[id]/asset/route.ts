import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'node:fs';
import { getScene } from '@/lib/store';
import { canRead, sessionUser } from '@/lib/authz';
import { readyAssetForScene } from '@/lib/store';

/**
 * GET /api/scenes/:sceneId/asset — stream the verified reconstruction asset.
 * Dev equivalent of the production signed-URL path (PRD §26.3): private scenes
 * are served by the backend, never by a public static URL. No ready asset ->
 * 404, never a substitute file.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const scene = getScene(id);
  const user = await sessionUser();
  if (!scene || !canRead(scene, user?.uid ?? null)) {
    return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  }
  const asset = readyAssetForScene(id);
  if (!asset || !existsSync(asset.assetPath)) {
    return NextResponse.json({ error: 'No visual asset for this scene yet' }, { status: 404 });
  }
  const bytes = readFileSync(asset.assetPath);
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
