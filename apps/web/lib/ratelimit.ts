/**
 * Tiny in-memory rate limiter for sensitive endpoints (server-only).
 * Per-key sliding window. Single-instance scope — documented; a shared
 * deployment would move this to Redis. Keys should be user ids when known,
 * else client IP.
 */
import 'server-only';

const buckets = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  // Opportunistic cleanup so the map cannot grow unboundedly.
  if (buckets.size > 10000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => t <= cutoff)) buckets.delete(k);
    }
  }
  return true;
}

export function clientKey(req: Request, uid: string | null): string {
  if (uid) return `user:${uid}`;
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return `ip:${fwd || 'unknown'}`;
}
