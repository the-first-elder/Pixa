import { NextRequest, NextResponse } from 'next/server';
import { createScene } from '@/lib/store';
import { ensureUser } from '@/lib/users';
import { canCreate, sessionUser } from '@/lib/authz';
import { clientKey, rateLimit } from '@/lib/ratelimit';

/** POST /api/scenes — create a scene record. Body: { "name": "Workspace Capture" } */
export async function POST(req: NextRequest) {
  const user = await sessionUser();
  const uid = user?.uid ?? null;
  if (!canCreate(uid)) {
    return NextResponse.json({ error: 'Sign in to create a scene.' }, { status: 401 });
  }
  // Owner row must exist before any record references it (see ensureUser).
  ensureUser(user);
  if (!rateLimit(`scenes:${clientKey(req, uid)}`, 20, 60_000)) {
    return NextResponse.json({ error: 'Too many scene creations — slow down.' }, { status: 429 });
  }
  let name = 'Untitled scene';
  try {
    const body = await req.json();
    if (typeof body?.name === 'string' && body.name.trim()) name = body.name.trim();
  } catch {
    // Empty/invalid JSON body: fall back to default name.
  }
  const scene = createScene(name.slice(0, 200), uid);
  return NextResponse.json({ sceneId: scene.id, status: 'created' }, { status: 201 });
}
