/**
 * On-device persistence of the last verified bundle (offline-first start).
 *
 * The SDK stores one value per SDK key and edge under `nanoflags:bundle:<fingerprint>`. The value is the bundle plus
 * the signature it was accepted with; on the next start it is verified again before it is used.
 */
import type { Store } from "@nanoflags/sdk";

/**
 * Key-value storage the SDK persists through. `@react-native-async-storage/async-storage` matches it as is; wrap
 * MMKV, SecureStore, SQLite… in a three-line object. Methods may be synchronous or return promises.
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null | undefined> | string | null | undefined;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem?(key: string): Promise<void> | void;
}

/** The part of `@react-native-async-storage/async-storage`'s default export the SDK uses. */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Persistence through AsyncStorage (optional peer dependency `@react-native-async-storage/async-storage`):
 *
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 * createClient({ sdkKey, storage: asyncStorage(AsyncStorage) });
 * ```
 *
 * Note: Android's AsyncStorage refuses single values above ~2 MB by default; very large configurations are then not
 * persisted (the SDK keeps working from the network and reports a `store` error).
 */
export function asyncStorage(storage: AsyncStorageLike): StorageAdapter {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
}

/** In-memory storage: nothing survives a restart. The default when no `storage` is given. Useful for tests. */
export function memoryStorage(initial?: Record<string, string>): StorageAdapter & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

/** Storage key for a client (fingerprint = non-secret hash of edge URL + SDK key, as the JS SDK computes it). */
export function storageKey(fingerprint: string): string {
  return `nanoflags:bundle:${fingerprint}`;
}

/** Adapts a `StorageAdapter` to the core SDK's single-slot `Store`. Failures read as "nothing stored" / are reported by the core. */
export function toStore(adapter: StorageAdapter, key: string): Store {
  return {
    async get() {
      const v = await adapter.getItem(key);
      return typeof v === "string" ? v : null;
    },
    async set(value) {
      await adapter.setItem(key, value);
    },
  };
}
