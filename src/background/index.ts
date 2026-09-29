import { createApi } from "../shared/api";
import { hostOf, matchEntries, mayFill, normalizeServer } from "../shared/host";
import type { Hello, PageCommand, PageReply, Request, Responses } from "../shared/messages";
import { err, ok, type Connection, type EntrySummary, type Result, type Settings, type VaultState } from "../shared/types";
import { detectionIntervalSeconds, idleAction, type IdleState } from "./idle";
import { createCache, deriveState, stateFromError } from "./state";
import {
  clearConnection,
  loadConnection,
  loadServer,
  loadSettings,
  saveConnection,
  saveSettings,
} from "./storage";

const api = createApi((input, init) => fetch(input, init));
const entriesCache = createCache<readonly EntrySummary[]>(30_000);

type Sender = chrome.runtime.MessageSender;

const fromExtensionOrigin = (sender: Sender): boolean => (sender.url ?? "").startsWith(chrome.runtime.getURL(""));

const isExtensionPage = (sender: Sender): boolean => sender.id === chrome.runtime.id && fromExtensionOrigin(sender);

const isTopFrameContent = (sender: Sender): boolean =>
  sender.id === chrome.runtime.id && !fromExtensionOrigin(sender) && sender.tab !== undefined && sender.frameId === 0;

const withConnection = async <T>(run: (connection: Connection) => Promise<Result<T>>): Promise<Result<T>> => {
  const connection = await loadConnection();
  if (connection === null) {
    return err({ kind: "signedOut" });
  }
  const result = await run(connection);
  if (!result.ok && result.error.kind === "signedOut") {
    entriesCache.clear();
    await clearConnection();
  }
  return result;
};

const currentState = async (): Promise<VaultState> => {
  const [server, connection] = await Promise.all([loadServer(), loadConnection()]);
  if (connection === null) {
    return deriveState(server, false, null);
  }
  const status = await withConnection((conn) => api.status(conn));
  const stillSignedIn = (await loadConnection()) !== null;
  return deriveState(server, stillSignedIn, status);
};

const stateAfter = async (result: Result<unknown>): Promise<Result<VaultState>> => {
  entriesCache.clear();
  return result.ok ? ok(await currentState()) : err(result.error);
};

const entries = async (): Promise<Result<readonly EntrySummary[]>> => {
  const cached = entriesCache.get();
  if (cached !== undefined) {
    return ok(cached);
  }
  const result = await withConnection((conn) => api.listEntries(conn));
  if (result.ok) {
    entriesCache.set(result.value);
  }
  return result;
};

const matchesFor = async (pageUrl: string): Promise<Result<readonly EntrySummary[]>> => {
  const result = await entries();
  return result.ok ? ok(matchEntries(result.value, hostOf(pageUrl))) : result;
};

const refused = (reason: string) => err({ kind: "refused", reason } as const);

const fillFromPage = async (
  sender: Sender,
  entryId: number,
): Promise<Responses["fillFromPage"]> => {
  const pageUrl = sender.url ?? "";
  const [settings, entry] = await Promise.all([loadSettings(), withConnection((conn) => api.getEntry(conn, entryId))]);
  if (!entry.ok) {
    return entry;
  }
  if (!mayFill(pageUrl, entry.value.url, entry.value.urlHost)) {
    return refused("This login doesn't belong to this site.");
  }
  return ok({ username: entry.value.username, password: entry.value.password, autoSubmit: settings.autoSubmit });
};

const fillInTab = async (tabId: number, entryId: number): Promise<Responses["fillInTab"]> => {
  const [settings, entry] = await Promise.all([loadSettings(), withConnection((conn) => api.getEntry(conn, entryId))]);
  if (!entry.ok) {
    return entry;
  }
  const command: PageCommand = {
    type: "fill",
    credentials: { username: entry.value.username, password: entry.value.password },
    entryUrl: entry.value.url,
    entryHost: entry.value.urlHost,
    autoSubmit: settings.autoSubmit,
  };
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, command, { frameId: 0 })) as PageReply | undefined;
    if (reply === undefined) {
      return refused("This page can't be filled. Reload it and try again.");
    }
    return reply;
  } catch {
    return refused("This page can't be filled. Reload it and try again.");
  }
};

const setBadge = async (tabId: number, count: number, enabled: boolean): Promise<void> => {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0284C7" });
  await chrome.action.setBadgeText({ tabId, text: enabled && count > 0 ? String(count) : "" });
};

const hello = async (sender: Sender): Promise<Hello> => {
  const settings = await loadSettings();
  const result = await matchesFor(sender.url ?? "");
  const matches = result.ok ? result.value : [];
  if (sender.tab?.id !== undefined) {
    await setBadge(sender.tab.id, matches.length, settings.badge);
  }
  return { settings, matches };
};

const connect = async (
  request: Extract<Request, { type: "connect" }>,
): Promise<Responses["connect"]> => {
  const server = normalizeServer(request.server);
  if (server === "") {
    return err({ kind: "network", message: "invalid address" });
  }
  const token = await api.login(server, request.username, request.password);
  if (!token.ok) {
    return token;
  }
  await saveConnection({ server, token: token.value }, request.persist);
  const state = await currentState();
  return state.kind === "notAdmin" ? err({ kind: "notAdmin" }) : ok(state);
};

const signOut = async (): Promise<Responses["signOut"]> => {
  const connection = await loadConnection();
  if (connection !== null) {
    await api.logout(connection);
  }
  entriesCache.clear();
  await clearConnection();
  return ok(await currentState());
};

type Handler = (request: Request, sender: Sender) => Promise<unknown> | null;

const forExtensionPages: Handler = (request, sender) => {
  if (!isExtensionPage(sender)) {
    return null;
  }
  switch (request.type) {
    case "state":
      return currentState();
    case "connect":
      return connect(request);
    case "signOut":
      return signOut();
    case "unlock":
      return withConnection((conn) => api.unlock(conn, request.masterPassword)).then(async (result) =>
        result.ok || result.error.kind !== "locked"
          ? stateAfter(result)
          : ok(stateFromError(await loadServer(), result.error)),
      );
    case "lock":
      return withConnection((conn) => api.lock(conn)).then(stateAfter);
    case "entries":
      return entries();
    case "matches":
      return matchesFor(request.pageUrl ?? "");
    case "fillInTab":
      return fillInTab(request.tabId, request.entryId);
    case "reveal":
      return withConnection((conn) => api.getEntry(conn, request.entryId)).then((entry) =>
        entry.ok ? ok({ username: entry.value.username, password: entry.value.password }) : entry,
      );
    case "generate":
      return withConnection((conn) => api.generate(conn));
    case "settings":
      return loadSettings();
    case "saveSettings":
      return saveSettings(request.settings).then(applyIdleInterval);
    case "hello":
    case "fillFromPage":
      return null;
  }
};

const forContentScripts: Handler = (request, sender) => {
  if (!isTopFrameContent(sender)) {
    return null;
  }
  switch (request.type) {
    case "hello":
      return hello(sender);
    case "matches":
      return matchesFor(sender.url ?? "");
    case "fillFromPage":
      return fillFromPage(sender, request.entryId);
    default:
      return null;
  }
};

const applyIdleInterval = (settings: Settings): Settings => {
  chrome.idle.setDetectionInterval(detectionIntervalSeconds(settings));
  return settings;
};

const onIdleState = async (state: IdleState): Promise<void> => {
  const settings = await loadSettings();
  if (idleAction(state, settings) === "lock" && (await loadConnection()) !== null) {
    entriesCache.clear();
    await withConnection((conn) => api.lock(conn));
  }
};

chrome.idle.onStateChanged.addListener((state) => void onIdleState(state as IdleState));
void loadSettings().then(applyIdleInterval);

chrome.runtime.onMessage.addListener((request: Request, sender, sendResponse) => {
  const pending = forExtensionPages(request, sender) ?? forContentScripts(request, sender);
  if (pending === null) {
    return false;
  }
  pending.then(sendResponse, (cause: unknown) =>
    sendResponse(err({ kind: "network", message: cause instanceof Error ? cause.message : String(cause) })),
  );
  return true;
});
