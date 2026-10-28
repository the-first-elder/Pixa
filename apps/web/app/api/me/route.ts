import { NextResponse } from 'next/server';
import { authEnabled, sessionUser } from '@/lib/authz';

/** GET /api/me — current session (null user when signed out or auth disabled). */
export async function GET() {
  const user = await sessionUser();
  return NextResponse.json({ enabled: authEnabled(), user });
}
