/** Persistence for the last bundle. Values are opaque strings owned by the SDK. */
export interface Store {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

const DB = "nanoflags";
const OBJECT_STORE = "bundles";

/**
 * Browser default: IndexedDB when available. Everywhere else (Node, edge runtimes, serverless):
 * no persistence — there is no safe default location and cold starts should not touch disk.
 */
export function defaultStore(id: string): Store | null {
  if (typeof window === "undefined" || typeof indexedDB === "undefined" || indexedDB === null) return null;
  return indexedDbStore(id);
}

export function indexedDbStore(id: string): Store {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(OBJECT_STORE)) req.result.createObjectStore(OBJECT_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    });
  const run = async <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(OBJECT_STORE, mode);
        const req = op(tx.objectStore(OBJECT_STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
        tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
      });
    } finally {
      db.close();
    }
  };
  return {
    // Unavailable storage (private mode, quota, blocked) behaves like an empty store.
    async get() {
      try {
        const v = await run<unknown>("readonly", (s) => s.get(id));
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    },
    async set(value) {
      try {
        await run("readwrite", (s) => s.put(value, id));
      } catch {
        /* ignore */
      }
    },
  };
}
