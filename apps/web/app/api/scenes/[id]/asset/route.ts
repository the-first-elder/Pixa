import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { getScene } from '@/lib/store';
import { canRead, sessionUser } from '@/lib/authz';
import { readyAssetForScene } from '@/lib/store';
import { streamFile } from '@/lib/file-response';

/**
 * GET /api/scenes/:sceneId/asset — stream the verified reconstruction asset.
 * Dev equivalent of the production signed-URL path (PRD §26.3): private scenes
 * are served by the backend, never by a public static URL. No ready asset ->
 * 404, never a substitute file.
 */
export async function GET(
  req: Request,
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
  // Streamed, never buffered: a 39MB SPZ (or legacy 452MB PLY) must not
  // block the event loop for every concurrent viewer.
  return streamFile(asset.assetPath, 'application/octet-stream', req);
}
