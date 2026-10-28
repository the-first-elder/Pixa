import { NextResponse } from 'next/server';
import { unlinkSync, existsSync } from 'node:fs';
import { cancelSession, getSession } from '@/lib/uploads';
import { canRead, canWrite, sessionUser } from '@/lib/authz';

/** GET /api/uploads/:id — status + received bitmap (for resume). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const s = getSession(id);
  const user = await sessionUser();
  if (!s || !canRead(s, user?.uid ?? null)) {
    return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
  }
  return NextResponse.json({
    uploadId: s.id,
    filename: s.filename,
    size: s.size,
    chunkSize: s.chunkSize,
    chunks: s.chunks,
    received: s.received,
    receivedBytes: s.receivedBytes,
    status: s.status,
  });
}

/** DELETE /api/uploads/:id — cancel + delete temp data safely. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const existing = getSession(id);
  if (!existing) return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
  const user = await sessionUser();
  if (!canWrite(existing, user?.uid ?? null)) {
    return NextResponse.json({ error: user ? 'Forbidden' : 'Sign in to manage this upload.' }, { status: user ? 403 : 401 });
  }
  const s = cancelSession(id);
  if (!s) return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
  try {
    if (existsSync(s.tmpPath)) unlinkSync(s.tmpPath);
  } catch {
    // Best effort.
  }
  return NextResponse.json({ uploadId: id, status: 'cancelled' });
}
