import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '@/lib/uploads';

/**
 * POST /api/uploads — create a resumable upload session.
 * Body: { filename, size, mime?, chunkSize? } → { uploadId, chunkSize, chunks }
 */
export async function POST(req: NextRequest) {
  let body: { filename?: unknown; size?: unknown; mime?: unknown; chunkSize?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.filename !== 'string' || !body.filename) {
    return NextResponse.json({ error: 'filename (string) required' }, { status: 400 });
  }
  try {
    const s = createSession({
      filename: body.filename,
      size: Number(body.size),
      mime: typeof body.mime === 'string' ? body.mime : undefined,
      chunkSize: typeof body.chunkSize === 'number' ? body.chunkSize : undefined,
    });
    return NextResponse.json(
      { uploadId: s.id, chunkSize: s.chunkSize, chunks: s.chunks, size: s.size },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Cannot create upload' },
      { status: 400 },
    );
  }
}
