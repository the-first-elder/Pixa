import { NextRequest, NextResponse } from 'next/server';
import { handlers } from '@/auth';

async function handle(req: NextRequest) {
  const url = new URL(req.url);
  // Restrict post-login destinations to in-app paths (no open redirects).
  const callbackUrl = url.searchParams.get('callbackUrl');
  if (callbackUrl && !(callbackUrl.startsWith('/') && !callbackUrl.startsWith('//'))) {
    url.searchParams.set('callbackUrl', '/worlds');
    req = new NextRequest(url, req);
  }
  return handlers.GET(req);
}

export { handle as GET };

async function handlePost(req: NextRequest) {
  return handlers.POST(req);
}

export { handlePost as POST };
