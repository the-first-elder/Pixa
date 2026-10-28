/**
 * Auth + authorization helpers (server-only).
 *
 * Modes:
 * - Auth ENABLED (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + AUTH_SECRET set):
 *   writes require a session; private records require owner match.
 * - Auth DISABLED (default local dev): single-user mode, everything allowed.
 *   This preserves existing functionality without credentials and is
 *   documented — not a bypass. Never deploy multi-user without creds.
 *
 * Legacy records (no ownerId, created before auth) are grandfathered:
 * readable/writable by anyone, same as before auth existed. Documented in
 * docs/auth-audit.md. New records always stamp ownerId when auth is enabled.
 */
import 'server-only';
import { auth } from '@/auth';

export function authEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.AUTH_SECRET,
  );
}

export interface SessionUser {
  uid: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export async function sessionUser(): Promise<SessionUser | null> {
  if (!authEnabled()) return null;
  const session = await auth();
  const uid = (session as { uid?: string } | null)?.uid;
  if (!session?.user || !uid) return null;
  return {
    uid,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  };
}

export type Ownable = {
  ownerId?: string | null;
  visibility?: string;
};

/**
 * Read access: public records are open; legacy records (no ownerId) are
 * grandfathered; otherwise the session uid must match ownerId.
 */
export function canRead(record: Ownable | null, uid: string | null): boolean {
  if (!record) return false;
  if (!authEnabled()) return true;
  if (record.visibility === 'public') return true;
  if (record.ownerId == null) return true; // legacy, pre-auth record
  return uid != null && record.ownerId === uid;
}

/**
 * Write access: session required when auth is enabled (except legacy
 * grandfathered records); single-user mode allows everything.
 */
export function canWrite(record: Ownable | null, uid: string | null): boolean {
  if (!record) return false;
  if (!authEnabled()) return true;
  if (uid == null) return false;
  if (record.ownerId == null) return true; // legacy, pre-auth record
  return record.ownerId === uid;
}

/** Mutating endpoints with no existing record (create flows). */
export function canCreate(uid: string | null): boolean {
  if (!authEnabled()) return true;
  return uid != null;
}
