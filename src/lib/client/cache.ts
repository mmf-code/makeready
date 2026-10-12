import { MakeReadyClientError } from "./errors";

export type CacheStore = "sessions" | "artifacts";

export interface CacheEntry<T> {
  value: T;
  cachedAt: string;
}

/** Optional local cache only. Durable jobs and authoritative artifacts live on the server. */
export interface MakeReadyCache {
  get<T>(store: CacheStore, key: string): Promise<CacheEntry<T> | undefined>;
  put<T>(store: CacheStore, key: string, value: T): Promise<void>;
  remove(store: CacheStore, key: string): Promise<void>;
  clear(): Promise<void>;
}

export function createIndexedDbCache(name = "makeready-cache-v1"): MakeReadyCache {
  let databasePromise: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise;
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new MakeReadyClientError("CACHE_UNAVAILABLE", "IndexedDB is not available in this environment."));
    }
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const store of ["sessions", "artifacts"] as const) {
          if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = undefined;
        };
        resolve(database);
      };
      request.onerror = () => reject(cacheError(request.error));
      request.onblocked = () => reject(cacheError("Close older MakeReady tabs to upgrade the cache."));
    });
    databasePromise.catch(() => { databasePromise = undefined; });
    return databasePromise;
  }

  async function transaction<T>(
    stores: CacheStore | CacheStore[],
    mode: IDBTransactionMode,
    operation: (transaction: IDBTransaction, setValue: (value: T) => void) => void,
  ): Promise<T> {
    const database = await open();
    return new Promise<T>((resolve, reject) => {
      let value: T;
      const tx = database.transaction(stores, mode);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(cacheError(tx.error));
      tx.onabort = () => reject(cacheError(tx.error));
      try { operation(tx, (next) => { value = next; }); }
      catch (cause) { tx.abort(); reject(cacheError(cause)); }
    });
  }

  return {
    get: <T>(store: CacheStore, key: string) => transaction<CacheEntry<T> | undefined>(store, "readonly", (tx, set) => {
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => set(request.result as CacheEntry<T> | undefined);
    }),
    put: (store, key, value) => transaction<void>(store, "readwrite", (tx) => {
      tx.objectStore(store).put({ value, cachedAt: new Date().toISOString() }, key);
    }),
    remove: (store, key) => transaction<void>(store, "readwrite", (tx) => { tx.objectStore(store).delete(key); }),
    clear: () => transaction<void>(["sessions", "artifacts"], "readwrite", (tx) => {
      tx.objectStore("sessions").clear();
      tx.objectStore("artifacts").clear();
    }),
  };
}

function cacheError(cause: unknown): MakeReadyClientError {
  return new MakeReadyClientError("CACHE_ERROR", "The optional local cache could not be accessed.", { cause });
}
