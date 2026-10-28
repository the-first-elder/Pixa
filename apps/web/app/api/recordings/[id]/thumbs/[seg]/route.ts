import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRecording } from '@/lib/recordings';
import { STORAGE_DIR } from '@/lib/config';

/**
 * GET /api/recordings/:id/thumbs/:seg — serve a segment thumbnail written by
 * analysis. 404 when analysis hasn't produced one.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; seg: string }> },
) {
  const { id, seg } = await params;
  const rec = getRecording(id);
  if (!rec) return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  if (!/^seg_[0-9a-z+]+$/i.test(seg)) {
    return NextResponse.json({ error: 'Invalid segment id' }, { status: 400 });
  }
  const path = join(STORAGE_DIR, 'work', 'analysis', 'thumbs', `${seg}.jpg`);
  if (!existsSync(path)) {
    return NextResponse.json({ error: 'Thumbnail not available' }, { status: 404 });
  }
  return new Response(readFileSync(path), {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
  });
}
