import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getScene } from '@/lib/store';
import { STORAGE_DIR } from '@/lib/config';

/**
 * GET /api/scenes/:sceneId/mesh — stream the collision mesh (invisible proxy).
 * Same access rules as the visual asset. 404 when no mesh has been built yet.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getScene(id)) return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  const path = join(STORAGE_DIR, 'assets', id, 'mesh.glb');
  if (!existsSync(path)) {
    return NextResponse.json({ error: 'No collision mesh for this scene yet' }, { status: 404 });
  }
  return new Response(readFileSync(path), {
    headers: {
      'Content-Type': 'model/gltf-binary',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
