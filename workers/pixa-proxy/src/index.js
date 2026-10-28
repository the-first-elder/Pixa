/**
 * pixa proxy — public edge name for the Pixa Mac server.
 * Forwards everything to ORIGIN (the Cloudflare Tunnel URL).
 * Streams bodies both ways; no buffering.
 */
export default {
  async fetch(request, env) {
    const origin = env.ORIGIN.replace(/\/$/, '');
    const url = new URL(request.url);
    const target = origin + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', url.host);
    headers.set('X-Forwarded-Proto', 'https');
    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
      init.duplex = 'half';
    }
    return fetch(target, init);
  },
};
