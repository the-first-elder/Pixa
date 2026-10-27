/**
 * Server-only config. Secrets never leave the server: this module must only be
 * imported by route handlers / server components, never by client components.
 */
import 'server-only';

export function serverEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const META_API_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';
export const STORAGE_DIR = process.env.STORAGE_DIR ?? './data';
