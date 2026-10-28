import { NextResponse } from 'next/server';
import { sessionUser } from '@/lib/authz';
import { ensureNotifications, listNotifications } from '@/lib/notifications';

/** GET /api/notifications — own notifications (sweeps for newly-settled work first). */
export async function GET() {
  const user = await sessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to view notifications.' }, { status: 401 });
  }
  ensureNotifications(user.uid);
  return NextResponse.json({ notifications: listNotifications(user.uid) });
}
