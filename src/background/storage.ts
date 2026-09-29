import { defaultSettings, type Connection, type Settings } from "../shared/types";

const keys = {
  server: "server",
  connection: "connection",
  settings: "settings",
} as const;

const isConnection = (value: unknown): value is Connection =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Connection).server === "string" &&
  typeof (value as Connection).token === "string";

export const loadServer = async (): Promise<string> => {
  const stored = await chrome.storage.local.get(keys.server);
  const server = stored[keys.server];
  return typeof server === "string" ? server : "";
};

export const loadConnection = async (): Promise<Connection | null> => {
  const [session, local] = await Promise.all([
    chrome.storage.session.get(keys.connection),
    chrome.storage.local.get(keys.connection),
  ]);
  const found = [session[keys.connection], local[keys.connection]].find(isConnection);
  return found ?? null;
};

export const saveConnection = async (connection: Connection, persist: boolean): Promise<void> => {
  await clearConnection();
  await chrome.storage.local.set({ [keys.server]: connection.server });
  await (persist ? chrome.storage.local : chrome.storage.session).set({ [keys.connection]: connection });
};

export const clearConnection = async (): Promise<void> => {
  await Promise.all([
    chrome.storage.session.remove(keys.connection),
    chrome.storage.local.remove(keys.connection),
  ]);
};

export const loadSettings = async (): Promise<Settings> => {
  const stored = await chrome.storage.local.get(keys.settings);
  const value: unknown = stored[keys.settings];
  const partial = typeof value === "object" && value !== null ? (value as Partial<Settings>) : {};
  return {
    inlineButton: typeof partial.inlineButton === "boolean" ? partial.inlineButton : defaultSettings.inlineButton,
    badge: typeof partial.badge === "boolean" ? partial.badge : defaultSettings.badge,
    autoSubmit: typeof partial.autoSubmit === "boolean" ? partial.autoSubmit : defaultSettings.autoSubmit,
    othersReviewed:
      typeof partial.othersReviewed === "boolean" ? partial.othersReviewed : defaultSettings.othersReviewed,
  };
};

export const saveSettings = async (settings: Settings): Promise<Settings> => {
  await chrome.storage.local.set({ [keys.settings]: settings });
  return settings;
};
