import { NextRequest, NextResponse } from 'next/server';
import { createScene } from '@/lib/store';

/** POST /api/scenes — create a scene record. Body: { "name": "Workspace Capture" } */
export async function POST(req: NextRequest) {
  let name = 'Untitled scene';
  try {
    const body = await req.json();
    if (typeof body?.name === 'string' && body.name.trim()) name = body.name.trim();
  } catch {
    // Empty/invalid JSON body: fall back to default name.
  }
  const scene = createScene(name.slice(0, 200));
  return NextResponse.json({ sceneId: scene.id, status: 'created' }, { status: 201 });
}
