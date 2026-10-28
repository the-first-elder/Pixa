import { NextRequest, NextResponse } from 'next/server';
import { openSync, writeSync, closeSync } from 'node:fs';
import { getSession, markReceived } from '@/lib/uploads';

/**
 * PUT /api/uploads/:id/chunks/:index — one bounded chunk (raw bytes).
 * Out-of-order and duplicate-safe: written at its offset, bitmap idempotent.
 * Only the chunk (≤64 MB) is buffered — never the whole file.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index: indexRaw } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
  if (s.status !== 'active') {
    return NextResponse.json({ error: `Upload is ${s.status}, not active` }, { status: 409 });
  }
  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0 || index >= s.chunks) {
    return NextResponse.json({ error: `Invalid chunk index (0..${s.chunks - 1})` }, { status: 400 });
  }
  const expected =
    index === s.chunks - 1 ? s.size - index * s.chunkSize : s.chunkSize;
  let buf: Buffer;
  try {
    buf = Buffer.from(await req.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'Unreadable chunk body' }, { status: 400 });
  }
  if (buf.length !== expected) {
    return NextResponse.json(
      { error: `Wrong chunk size: got ${buf.length}, expected ${expected}` },
      { status: 400 },
    );
  }
  try {
    const fd = openSync(s.tmpPath, 'r+');
    try {
      writeSync(fd, buf, 0, buf.length, index * s.chunkSize);
    } finally {
      closeSync(fd);
    }
  } catch {
    return NextResponse.json({ error: 'Chunk write failed (disk?)' }, { status: 500 });
  }
  const updated = markReceived(id, index, buf.length);
  return NextResponse.json({ uploadId: id, index, receivedBytes: updated.receivedBytes, complete: updated.received.every(Boolean) });
}
