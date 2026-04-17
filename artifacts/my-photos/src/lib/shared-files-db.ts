/**
 * IndexedDB helpers for the PWA share-target flow.
 *
 * When the user shares photos from their device gallery into APhoto, the
 * service worker (sw.ts) saves the files here. The React app reads them back
 * on `?shared=1` and pre-populates the upload modal.
 *
 * The DB / store names MUST match the constants in src/sw.ts.
 */

const DB_NAME = "aphoto-pwa";
const SHARE_STORE = "share-queue";

export interface SharedFileEntry {
  key: IDBValidKey;
  name: string;
  type: string;
  data: ArrayBuffer;
  lastModified: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SHARE_STORE)) {
        req.result.createObjectStore(SHARE_STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Read all pending shared files from IndexedDB. */
export async function getSharedFiles(): Promise<SharedFileEntry[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const results: SharedFileEntry[] = [];
    const request = db.transaction(SHARE_STORE, "readonly")
      .objectStore(SHARE_STORE)
      .openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        results.push({
          key: cursor.key,
          ...(cursor.value as Omit<SharedFileEntry, "key">),
        });
        cursor.continue();
      } else {
        db.close();
        resolve(results);
      }
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/** Remove all pending shared files (call after loading them into the upload modal). */
export async function clearSharedFiles(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SHARE_STORE, "readwrite");
    tx.objectStore(SHARE_STORE).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
