/**
 * Minimal user store (server-only). JSON file, same conventions as store.ts.
 * Identity key: `provider:providerAccountId` (Google `sub` — stable).
 * Data minimization: only what the app needs (id, provider ids, email?,
 * name?, image?, createdAt). No phone, no demographics.
 */
import 'server-only';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORAGE_DIR } from './config';

export interface User {
  id: string; // `${provider}:${providerAccountId}`
  provider: string;
  providerAccountId: string;
  email: string | null;
  name: string | null;
  image: string | null;
  createdAt: string;
}

function load(): Record<string, User> {
  try {
    return JSON.parse(readFileSync(join(STORAGE_DIR, 'users.json'), 'utf8')) as Record<string, User>;
  } catch {
    return {};
  }
}

function save(all: Record<string, User>): void {
  mkdirSync(STORAGE_DIR, { recursive: true });
  const tmp = join(tmpdir(), `wl-u-${Date.now()}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, join(STORAGE_DIR, 'users.json'));
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function upsertUser(input: {
  provider: string;
  providerAccountId: string;
  email: string | null;
  name: string | null;
  image: string | null;
}): User {
  const all = load();
  const id = `${input.provider}:${input.providerAccountId}`;
  const existing = all[id];
  const user: User = {
    id,
    provider: input.provider,
    providerAccountId: input.providerAccountId,
    email: input.email ?? existing?.email ?? null,
    name: input.name ?? existing?.name ?? null,
    image: input.image ?? existing?.image ?? null,
    createdAt: existing?.createdAt ?? now(),
  };
  all[id] = user;
  save(all);
  return user;
}

export function getUser(id: string): User | null {
  return load()[id] ?? null;
}
