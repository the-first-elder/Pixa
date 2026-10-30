import { NextResponse } from 'next/server';
import { sessionUser } from '@/lib/authz';
import { markAllRead } from '@/lib/notifications';

/** POST /api/notifications/read — acknowledge all own notifications. */
export async function POST() {
  const user = await sessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to manage notifications.' }, { status: 401 });
  }
  return NextResponse.json({ marked: markAllRead(user.uid) });
}
