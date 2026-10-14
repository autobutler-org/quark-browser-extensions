// Just enough IndexedDB for src/background/sealKey.ts: one database of key-value object stores. Values are
// kept as-is, the way a structured clone keeps a CryptoKey.

type Req<T> = { result: T; error: Error | null; onsuccess: (() => void) | null; onerror: (() => void) | null };

const later = <T>(produce: () => T): Req<T> => {
  const request: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null };
  setTimeout(() => {
    request.result = produce();
    request.onsuccess?.();
  });
  return request;
};

export const fakeIndexedDB = () => {
  const stores = new Map<string, Map<string, unknown>>();
  const db = {
    createObjectStore: (name: string) => {
      stores.set(name, new Map());
    },
    transaction: (name: string) => ({
      objectStore: () => {
        const store = stores.get(name);
        if (store === undefined) {
          throw new Error(`no object store ${name}`);
        }
        return {
          get: (key: string) => later(() => store.get(key)),
          put: (value: unknown, key: string) => later(() => void store.set(key, value)),
          delete: (key: string) => later(() => void store.delete(key)),
        };
      },
    }),
    close: () => undefined,
  };
  const indexedDB = {
    open: () => {
      const request: Req<typeof db> & { onupgradeneeded: (() => void) | null } = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      setTimeout(() => {
        if (stores.size === 0) {
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { indexedDB, stores };
};
