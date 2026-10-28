'use client';

/**
 * Preserve a user-selected file across the sign-in redirect (IndexedDB —
 * never localStorage, which cannot hold video). Best-effort: if the browser
 * refreshes mid-redirect or storage is unavailable, the caller falls back to
 * asking the user to select the file again. Cleared immediately after use.
 */

const DB = 'pixa-capture';
const STORE = 'pending-files';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function stashFile(key: string, file: File): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(
        { blob: file, name: file.name, type: file.type, at: Date.now() },
        key,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function unstashFile(key: string): Promise<File | null> {
  try {
    const db = await openDb();
    const rec = await new Promise<{
      blob: Blob;
      name: string;
      type: string;
    } | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const get = tx.objectStore(STORE).get(key);
      get.onsuccess = () => resolve((get.result as typeof rec) ?? null);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => {};
    });
    // Always clear after attempting restore — one-shot handoff.
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
    db.close();
    if (!rec) return null;
    return new File([rec.blob], rec.name, { type: rec.type });
  } catch {
    return null;
  }
}
