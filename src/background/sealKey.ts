// The key that seals a "stay signed in" token at rest. It lives in the extension origin's IndexedDB, which
// content scripts can't open (theirs is the page's), and it is non-extractable, so script can only use it
// through WebCrypto, never read its bytes. See docs/security.md for what this does and doesn't protect.

const dbName = "quark-vault";
const storeName = "keys";
const keyName = "seal";

const opened = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });

const inStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await opened();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(storeName, mode).objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
    });
  } finally {
    db.close();
  }
};

export const loadSealKey = async (): Promise<CryptoKey | null> => {
  const found: unknown = await inStore("readonly", (store) => store.get(keyName));
  return found instanceof CryptoKey ? found : null;
};

export const createSealKey = async (): Promise<CryptoKey> => {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await inStore("readwrite", (store) => store.put(key, keyName));
  return key;
};

export const deleteSealKey = async (): Promise<void> => {
  await inStore("readwrite", (store) => store.delete(keyName));
};
