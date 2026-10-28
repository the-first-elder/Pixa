import { NextResponse } from 'next/server';
import { getRecording, recordingStatus } from '@/lib/recordings';
import { canRead, sessionUser } from '@/lib/authz';

/** GET /api/recordings/:id — recording + live segment/job status. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rec = getRecording(id);
  const user = await sessionUser();
  if (!rec || !canRead(rec, user?.uid ?? null)) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  }
  return NextResponse.json({ ...rec, computedStatus: recordingStatus(rec) });
}
