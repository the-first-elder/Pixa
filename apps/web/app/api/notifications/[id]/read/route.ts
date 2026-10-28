import { NextResponse } from 'next/server';
import { sessionUser } from '@/lib/authz';
import { markRead } from '@/lib/notifications';

/** POST /api/notifications/:id/read — acknowledge one notification. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await sessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to manage notifications.' }, { status: 401 });
  }
  const n = markRead(user.uid, id);
  if (!n) return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
  return NextResponse.json({ id: n.id, readAt: n.readAt });
}
