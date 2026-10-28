/**
 * Storage path resolution WITHOUT the server-only guard, so pure logic
 * (notifications sweep) can be unit-tested in plain node. Exposes no
 * secrets — just the directory path. App code should keep using
 * lib/config (server-only) unless testability is required.
 */
export function storageDir(): string {
  return process.env.STORAGE_DIR ?? './data';
}
