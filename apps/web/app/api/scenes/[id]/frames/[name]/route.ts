import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getScene } from '@/lib/store';
import { STORAGE_DIR } from '@/lib/config';

/**
 * GET /api/scenes/:sceneId/frames/:name — serve an indexed evidence frame.
 * Only files previously copied by the indexing pipeline are reachable;
 * the name is restricted to %04d.jpg to block path traversal.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await params;
  if (!getScene(id)) return NextResponse.json({ error: 'Scene not found' }, { status: 404 });
  if (!/^\d{4}\.jpg$/.test(name)) {
    return NextResponse.json({ error: 'Invalid frame name' }, { status: 400 });
  }
  const path = join(STORAGE_DIR, 'assets', id, 'frames', name);
  if (!existsSync(path)) {
    return NextResponse.json({ error: 'Frame not found' }, { status: 404 });
  }
  return new Response(readFileSync(path), {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
  });
}
