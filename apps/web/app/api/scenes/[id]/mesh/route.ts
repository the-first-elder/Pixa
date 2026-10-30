import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getScene } from '@/lib/store';
import { canRead, sessionUser } from '@/lib/authz';
import { STORAGE_DIR } from '@/lib/config';
import { streamFile } from '@/lib/file-response';

/**
 * GET /api/scenes/:sceneId/mesh — stream the collision mesh (invisible proxy).
 * Same access rules as the visual asset. 404 when no mesh has been built yet.
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
  const path = join(STORAGE_DIR, 'assets', id, 'mesh.glb');
  if (!existsSync(path)) {
    return NextResponse.json({ error: 'No collision mesh for this scene yet' }, { status: 404 });
  }
  return streamFile(path, 'model/gltf-binary', req);
}
