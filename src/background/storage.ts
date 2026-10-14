import { fromBase64, toBase64 } from "../shared/authKey";
import { decodeSettings } from "../shared/settings";
import type { Connection, Settings } from "../shared/types";
import { createSealKey, deleteSealKey, loadLastServer, loadSealKey, saveLastServer } from "./sealKey";

const keys = {
  // Older builds kept the last server address here in storage.local. Content scripts can write that area, so
  // it is never read any more; the address lives in the extension's IndexedDB (saveLastServer).
  server: "server",
  // The live connection, in storage.session only. Older builds also kept it here in storage.local, in
  // plaintext. Content scripts can write that too, so it is never read any more, only deleted.
  connection: "connection",
  // "Stay signed in": the token sealed with a key content scripts can't reach. See docs/security.md.
  sealed: "sealedConnection",
  settings: "settings",
  neverSave: "neverSave",
} as const;

const isConnection = (value: unknown): value is Connection =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Connection).server === "string" &&
  typeof (value as Connection).token === "string";

// The live connection's server, or else the last one signed in to. Never anything from storage.local.
export const loadServer = async (): Promise<string> => {
  const live = await loadConnection();
  return live?.server ?? (await loadLastServer().catch(() => ""));
};

const rememberServer = (server: string): Promise<void> => saveLastServer(server).catch(() => undefined);

type Sealed = Readonly<{ server: string; iv: string; data: string }>;

const isSealed = (value: unknown): value is Sealed =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Sealed).server === "string" &&
  typeof (value as Sealed).iv === "string" &&
  typeof (value as Sealed).data === "string";

const encoder = new TextEncoder();

// The server is bound in as associated data, so a sealed token can't be replayed against another address.
const seal = async (key: CryptoKey, { server, token }: Connection): Promise<Sealed> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(server) },
    key,
    encoder.encode(token),
  );
  return { server, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
};

const unseal = async (sealed: Sealed): Promise<Connection | null> => {
  const [key, iv, data] = [await loadSealKey(), fromBase64(sealed.iv), fromBase64(sealed.data)];
  if (key === null || iv === null || data === null) {
    return null;
  }
  const token = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer>, additionalData: encoder.encode(sealed.server) },
    key,
    data as Uint8Array<ArrayBuffer>,
  );
  return { server: sealed.server, token: new TextDecoder().decode(token) };
};

// chrome.storage.session defaults to trusted contexts in Chrome; say so explicitly in case that ever changes.
// Firefox has the same default; where setAccessLevel is missing or throws, the default stands.
export const restrictSessionStorage = async (): Promise<void> => {
  const session = chrome.storage.session as Partial<Pick<chrome.storage.StorageArea, "setAccessLevel">>;
  try {
    await session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    return;
  }
};

const persist = async (connection: Connection): Promise<boolean> => {
  try {
    await chrome.storage.local.set({ [keys.sealed]: await seal(await createSealKey(), connection) });
    return true;
  } catch {
    return false;
  }
};

// After a browser restart storage.session is empty: bring back a sealed "stay signed in" token. Only a sealed
// record counts, since its server is authenticated as associated data. A plaintext connection or server in
// storage.local may have been planted by a content script, so it is deleted and never adopted, and it never
// costs the user the real sealed record (issue #75). An older build's genuine plaintext token goes the same
// way, and that user signs in again.
const restore = async (): Promise<Connection | null> => {
  await Promise.all([chrome.storage.local.remove(keys.connection), chrome.storage.local.remove(keys.server)]);
  const sealed: unknown = (await chrome.storage.local.get(keys.sealed))[keys.sealed];
  if (!isSealed(sealed)) {
    return null;
  }
  const connection = await unseal(sealed).catch(() => null);
  if (connection === null) {
    await clearConnection();
    return null;
  }
  await chrome.storage.session.set({ [keys.connection]: connection });
  await rememberServer(connection.server);
  return connection;
};

// Callers ask for the connection in parallel; one restore at a time keeps them from racing on the seal key.
let restoring: Promise<Connection | null> | null = null;

export const loadConnection = async (): Promise<Connection | null> => {
  const live: unknown = (await chrome.storage.session.get(keys.connection))[keys.connection];
  if (isConnection(live)) {
    return live;
  }
  restoring ??= restore().finally(() => {
    restoring = null;
  });
  return restoring;
};

// Returns whether the connection will outlast the browser session.
export const saveConnection = async (connection: Connection, stay: boolean): Promise<boolean> => {
  await clearConnection();
  await chrome.storage.session.set({ [keys.connection]: connection });
  await rememberServer(connection.server);
  return stay && (await persist(connection));
};

export const clearConnection = async (): Promise<void> => {
  await Promise.all([
    chrome.storage.session.remove(keys.connection),
    chrome.storage.local.remove(keys.connection),
    chrome.storage.local.remove(keys.sealed),
  ]);
  await deleteSealKey().catch(() => undefined);
};

export const loadSettings = async (): Promise<Settings> => {
  const stored = await chrome.storage.local.get(keys.settings);
  return decodeSettings(stored[keys.settings]);
};

export const saveSettings = async (settings: Settings): Promise<Settings> => {
  await chrome.storage.local.set({ [keys.settings]: settings });
  return settings;
};

export const loadNeverSave = async (): Promise<readonly string[]> => {
  const stored = await chrome.storage.local.get(keys.neverSave);
  const value: unknown = stored[keys.neverSave];
  return Array.isArray(value) ? value.filter((host): host is string => typeof host === "string") : [];
};

export const saveNeverSave = async (hosts: readonly string[]): Promise<readonly string[]> => {
  const unique = [...new Set(hosts)].toSorted();
  await chrome.storage.local.set({ [keys.neverSave]: unique });
  return unique;
};
