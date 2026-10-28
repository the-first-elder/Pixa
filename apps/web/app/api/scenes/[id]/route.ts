import { NextRequest, NextResponse } from 'next/server';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertManifestVersion } from '@pixa/scene-schema';
import { deleteScene, getScene, latestJobForScene, updateScene } from '@/lib/store';
import { getSceneIndex } from '@/lib/scene-index';
import { manifestForScene } from '@/lib/manifest';
import { canRead, canWrite, sessionUser } from '@/lib/authz';
import { STORAGE_DIR } from '@/lib/config';

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
  const user = await sessionUser();
  // 404 for missing OR forbidden: private scene IDs are not enumerable.
  if (!scene || !canRead(scene, user?.uid ?? null)) {
    return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  }
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
  const user = await sessionUser();
  if (!canWrite(scene, user?.uid ?? null)) {
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to edit this scene.' }, { status: user ? 403 : 401 });
  }
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

/**
 * DELETE /api/scenes/:sceneId — permanently delete a scene, its jobs,
 * index entries, assets, and uploads. Owner-only (or legacy open record
 * in single-user mode). No undo — the client must confirm first.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: 'Invalid scene id' }, { status: 400 });
  }
  const scene = getScene(id);
  if (!scene) return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  const user = await sessionUser();
  if (!canWrite(scene, user?.uid ?? null)) {
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to delete this scene.' }, { status: user ? 403 : 401 });
  }
  const { jobs } = deleteScene(id);
  // Best-effort file cleanup; JSON records are already gone.
  const remove = (p: string) => {
    try {
      rmSync(join(STORAGE_DIR, p), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  };
  remove(`assets/${id}`);
  remove(`uploads/${id}`);
  remove(`index/${id}.json`);
  remove(`index/${id}.detections.json`);
  remove(`index/${id}.tracks.json`);
  for (const jid of jobs) {
    if (/^[A-Za-z0-9_-]+$/.test(jid)) remove(`work/${jid}`);
  }
  return NextResponse.json({ deleted: id });
}
