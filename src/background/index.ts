import { createApi } from "../shared/api";
import {
  frameMayFill,
  hostMatches,
  hostOf,
  insecureServerRefusal,
  matchEntries,
  normalizeHost,
  normalizeServer,
  primaryMatches,
  serverTransport,
  type SiteMatch,
} from "../shared/host";
import type { Hello, PageCommand, PageReply, Request, Responses } from "../shared/messages";
import { err, ok, type Connection, type EntrySummary, type Result, type Settings, type VaultState } from "../shared/types";
import { parseOtpSecret, totp } from "../shared/totp";
import { entryIdFromMenu, generateMenuId, menuItems, menuRoot, shortcutPlan } from "../shared/menu";
import { detectionIntervalSeconds, idleAction, type IdleState } from "./idle";
import {
  decideOffer,
  isFresh,
  isNeverSaved,
  newEntryFor,
  type Pending,
  type SaveAction,
  type SaveOffer,
} from "./save";
import { isTopFrame, route, type ContentScriptHandlers, type ExtensionPageHandlers, type Sender } from "./gate";
import { createCache, deriveState, stateFromError } from "./state";
import {
  clearConnection,
  loadConnection,
  loadServer,
  loadNeverSave,
  loadSettings,
  restrictSessionStorage,
  saveConnection,
  saveNeverSave,
  saveSettings,
} from "./storage";

const api = createApi((input, init) => fetch(input, init));
const entriesCache = createCache<readonly EntrySummary[]>(30_000);
// Each entry's full URL, which the list leaves out, so matches can be ranked by origin. Kept in memory only
// and dropped with the list; an edited entry gets a new updatedAt and is looked up again.
const entryUrls = new Map<number, Readonly<{ updatedAt: string; url: string }>>();

const forgetEntries = (): void => {
  entriesCache.clear();
  entryUrls.clear();
};

const tabTopUrl = async (tabId: number): Promise<string> => {
  const reply: unknown = await chrome.tabs.sendMessage(tabId, { type: "whereAmI" }, { frameId: 0 }).catch(() => undefined);
  return typeof reply === "string" ? reply : "";
};

const topFrameUrl = async (sender: Sender): Promise<string> => {
  if (isTopFrame(sender)) {
    return sender.url ?? "";
  }
  const tabId = sender.tab?.id;
  return tabId === undefined ? "" : tabTopUrl(tabId);
};

const embeddedRefusal = (topUrl: string): string =>
  `This login form is embedded in ${hostOf(topUrl) || "another page"}, so Quark Vault won't fill it.`;

const withConnection = async <T>(run: (connection: Connection) => Promise<Result<T>>): Promise<Result<T>> => {
  const connection = await loadConnection();
  if (connection === null) {
    return err({ kind: "signedOut" });
  }
  const result = await run(connection);
  if (!result.ok && result.error.kind === "signedOut") {
    forgetEntries();
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
  forgetEntries();
  menuOrigin = null;
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

const knownUrl = (entry: EntrySummary): string | undefined => {
  const known = entryUrls.get(entry.id);
  return known?.updatedAt === entry.updatedAt ? known.url : undefined;
};

const learnUrls = async (candidates: readonly EntrySummary[]): Promise<void> => {
  const missing = candidates.filter((entry) => knownUrl(entry) === undefined);
  await Promise.all(
    missing.map(async (entry) => {
      const detail = await withConnection((conn) => api.getEntry(conn, entry.id));
      if (detail.ok) {
        entryUrls.set(entry.id, { updatedAt: entry.updatedAt, url: detail.value.url });
      }
    }),
  );
};

const matchesFor = async (pageUrl: string): Promise<Result<readonly SiteMatch[]>> => {
  const result = await entries();
  if (!result.ok) {
    return result;
  }
  const pageHost = hostOf(pageUrl);
  await learnUrls(result.value.filter((entry) => hostMatches(entry.urlHost, pageHost)));
  return ok(matchEntries(result.value, pageUrl, knownUrl));
};

const refused = (reason: string) => err({ kind: "refused", reason } as const);

const fillFromPage = async (
  sender: Sender,
  entryId: number,
): Promise<Responses["fillFromPage"]> => {
  const pageUrl = sender.url ?? "";
  const [settings, entry, topUrl] = await Promise.all([
    loadSettings(),
    withConnection((conn) => api.getEntry(conn, entryId)),
    topFrameUrl(sender),
  ]);
  if (!entry.ok) {
    return entry;
  }
  if (!frameMayFill(pageUrl, pageUrl, entry.value.url, entry.value.urlHost)) {
    return refused("This login doesn't belong to this site.");
  }
  if (!frameMayFill(pageUrl, topUrl, entry.value.url, entry.value.urlHost)) {
    return refused(embeddedRefusal(topUrl));
  }
  return ok({ username: entry.value.username, password: entry.value.password, autoSubmit: settings.autoSubmit });
};

const otpFor = async (entryId: number, sender: Sender | null): Promise<Responses["otp"]> => {
  const [entry, topUrl] = await Promise.all([
    withConnection((conn) => api.getEntry(conn, entryId)),
    sender === null ? Promise.resolve("") : topFrameUrl(sender),
  ]);
  if (!entry.ok) {
    return entry;
  }
  const pageUrl = sender?.url ?? "";
  if (sender !== null && !frameMayFill(pageUrl, pageUrl, entry.value.url, entry.value.urlHost)) {
    return refused("This login doesn't belong to this site.");
  }
  if (sender !== null && !frameMayFill(pageUrl, topUrl, entry.value.url, entry.value.urlHost)) {
    return refused(embeddedRefusal(topUrl));
  }
  const params = parseOtpSecret(entry.value.totpSecret);
  return params === null ? refused("This login has no one-time code saved.") : ok(await totp(params, Date.now()));
};

// Credentials never ride on this message, because it reaches every frame in the tab. The frame that has the
// login form asks for them with fillFromPage, which checks that frame's own URL in the worker.
const fillInTab = async (tabId: number, entryId: number): Promise<Responses["fillInTab"]> => {
  const [entry, topUrl] = await Promise.all([
    withConnection((conn) => api.getEntry(conn, entryId)),
    tabTopUrl(tabId),
  ]);
  if (!entry.ok) {
    return entry;
  }
  const command: PageCommand = {
    type: "fill",
    entryId,
    entryUrl: entry.value.url,
    entryHost: entry.value.urlHost,
    topUrl,
  };
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, command)) as PageReply | undefined;
    if (reply === undefined) {
      return refused("Couldn't find login fields on this page. If it just loaded, reload it and try again.");
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

// The origin the context menu was last built for; the menu differs between ports on one host.
let menuOrigin: string | null = null;

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

const pendings = new Map<number, Pending>();

const freshPending = (tabId: number): Pending | null => {
  const pending = pendings.get(tabId);
  if (pending === undefined || !isFresh(pending, Date.now())) {
    pendings.delete(tabId);
    return null;
  }
  return pending;
};

const offerFor = async (tabId: number): Promise<SaveOffer | null> => {
  const pending = freshPending(tabId);
  const connection = await loadConnection();
  if (pending === null || connection === null) {
    return null;
  }
  const [status, matches] = await Promise.all([api.status(connection), matchesFor(pending.pageUrl)]);
  return decideOffer({
    pageUrl: pending.pageUrl,
    credentials: pending.credentials,
    matches: matches.ok ? matches.value : [],
    locked: !status.ok || status.value.locked,
    loadDetail: (id) => api.getEntry(connection, id),
  });
};

const captured = async (sender: Sender, username: string, password: string): Promise<SaveOffer | null> => {
  const tabId = sender.tab?.id;
  const pageUrl = sender.url ?? "";
  if (tabId === undefined || isNeverSaved(await loadNeverSave(), pageUrl)) {
    return null;
  }
  pendings.set(tabId, { pageUrl, credentials: { username, password }, at: Date.now() });
  return offerFor(tabId);
};

const relatedHosts = (a: string, b: string): boolean => hostMatches(a, b) || hostMatches(b, a);

const myOffer = async (sender: Sender): Promise<SaveOffer | null> => {
  const tabId = sender.tab?.id;
  const pending = tabId === undefined ? null : freshPending(tabId);
  return tabId !== undefined && pending !== null && relatedHosts(hostOf(pending.pageUrl), hostOf(sender.url ?? ""))
    ? offerFor(tabId)
    : null;
};

const resolveSave = async (tabId: number, action: SaveAction): Promise<Result<null>> => {
  const pending = freshPending(tabId);
  if (pending === null) {
    return refused("That login is no longer waiting to be saved.");
  }
  const finish = <T>(result: Result<T>): Result<null> => {
    if (result.ok) {
      pendings.delete(tabId);
      forgetEntries();
      menuOrigin = null;
      return ok(null);
    }
    return result;
  };
  switch (action) {
    case "dismiss":
      return finish(ok(null));
    case "never":
      return finish(ok(await saveNeverSave([...(await loadNeverSave()), normalizeHost(hostOf(pending.pageUrl))])));
    case "unlock":
      await openPopup();
      return ok(null);
    case "save":
      return finish(await withConnection((conn) => api.createEntry(conn, newEntryFor(pending.pageUrl, pending.credentials))));
    case "update": {
      const offer = await offerFor(tabId);
      if (offer?.kind !== "update") {
        return refused("There's nothing to update for this login.");
      }
      return finish(await withConnection((conn) => api.replacePassword(conn, offer.entryId, pending.credentials.password)));
    }
  }
};

const rebuildMenu = async (pageUrl: string): Promise<void> => {
  const origin = originOf(pageUrl);
  if (origin === menuOrigin) {
    return;
  }
  menuOrigin = origin;
  const result = await matchesFor(pageUrl);
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: menuRoot, title: "Quark Vault", contexts: ["editable"] });
  menuItems(result.ok ? result.value : []).forEach((item) =>
    chrome.contextMenus.create({ id: item.id, parentId: menuRoot, title: item.title, enabled: item.enabled, contexts: ["editable"] }),
  );
  chrome.contextMenus.create({ id: "sep", parentId: menuRoot, type: "separator", contexts: ["editable"] });
  chrome.contextMenus.create({ id: generateMenuId, parentId: menuRoot, title: "Generate password", contexts: ["editable"] });
};

const openPopup = async (): Promise<void> => {
  try {
    await chrome.action.openPopup();
  } catch {
    return;
  }
};

const onShortcut = async (tab: chrome.tabs.Tab | undefined): Promise<void> => {
  if (tab?.id === undefined || tab.url === undefined) {
    await openPopup();
    return;
  }
  const result = await matchesFor(tab.url);
  const plan = shortcutPlan(result.ok ? result.value : []);
  switch (plan.kind) {
    case "fill": {
      const filled = await fillInTab(tab.id, plan.entryId);
      if (!filled.ok) {
        await openPopup();
      }
      return;
    }
    case "picker": {
      const reply = (await chrome.tabs.sendMessage(tab.id, { type: "openPicker" }).catch(() => undefined)) as
        | PageReply
        | undefined;
      if (reply === undefined || !reply.ok) {
        await openPopup();
      }
      return;
    }
    case "popup":
      await openPopup();
  }
};

const hello = async (sender: Sender): Promise<Hello> => {
  const settings = await loadSettings();
  const result = await matchesFor(sender.url ?? "");
  const matches = result.ok ? result.value : [];
  if (sender.tab?.id !== undefined && isTopFrame(sender)) {
    await setBadge(sender.tab.id, primaryMatches(matches).length, settings.badge);
  }
  return { settings, matches, connected: (await loadConnection()) !== null };
};

const connect = async (
  request: Extract<Request, { type: "connect" }>,
): Promise<Responses["connect"]> => {
  const server = normalizeServer(request.server);
  if (server === "") {
    return err({ kind: "network", message: "invalid address" });
  }
  if (serverTransport(server) === "insecure" && !request.allowInsecure) {
    return refused(insecureServerRefusal);
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
  forgetEntries();
  await clearConnection();
  return ok(await currentState());
};

const forExtensionPages: ExtensionPageHandlers = {
  state: () => currentState(),
  connect: (request) => connect(request),
  signOut: () => signOut(),
  unlock: (request) =>
    withConnection((conn) => api.unlock(conn, request.masterPassword)).then(async (result) =>
      result.ok || result.error.kind !== "locked"
        ? stateAfter(result)
        : ok(stateFromError(await loadServer(), result.error)),
    ),
  lock: () => withConnection((conn) => api.lock(conn)).then(stateAfter),
  entries: () => entries(),
  matches: (request) => matchesFor(request.pageUrl ?? ""),
  fillInTab: (request) => fillInTab(request.tabId, request.entryId),
  reveal: (request) =>
    withConnection((conn) => api.getEntry(conn, request.entryId)).then((entry) =>
      entry.ok ? ok({ username: entry.value.username, password: entry.value.password }) : entry,
    ),
  generate: () => withConnection((conn) => api.generate(conn)),
  otp: (request) => otpFor(request.entryId, null),
  pendingOffer: (request) => offerFor(request.tabId),
  resolveSave: (request) =>
    request.tabId === undefined ? Promise.resolve(refused("No tab to save from.")) : resolveSave(request.tabId, request.action),
  neverSaveList: () => loadNeverSave(),
  removeNeverSave: (request) => loadNeverSave().then((hosts) => saveNeverSave(hosts.filter((host) => host !== request.host))),
  settings: () => loadSettings(),
  saveSettings: (request) => saveSettings(request.settings).then(applyIdleInterval),
};

const forContentScripts: ContentScriptHandlers = {
  hello: (sender) => hello(sender),
  fieldFocused: (sender) => rebuildMenu(sender.url ?? "").then(() => null),
  otpFromPage: (request, sender) => otpFor(request.entryId, sender),
  generateForPage: (request) => withConnection((conn) => api.generate(conn, Math.max(12, Math.min(64, request.length)))),
  captured: (request, sender) => captured(sender, request.username, request.password),
  myOffer: (sender) => myOffer(sender),
  resolveSave: (request, tabId) => resolveSave(tabId, request.action),
  matches: (sender) => matchesFor(sender.url ?? ""),
  fillFromPage: (request, sender) => fillFromPage(sender, request.entryId),
};

const applyIdleInterval = (settings: Settings): Settings => {
  chrome.idle.setDetectionInterval(detectionIntervalSeconds(settings));
  return settings;
};

const onIdleState = async (state: IdleState): Promise<void> => {
  const settings = await loadSettings();
  if (idleAction(state, settings) === "lock" && (await loadConnection()) !== null) {
    forgetEntries();
    await withConnection((conn) => api.lock(conn));
  }
};

const fillGenerated = async (tabId: number): Promise<void> => {
  const password = await withConnection((conn) => api.generate(conn));
  if (password.ok) {
    await chrome.tabs.sendMessage(tabId, { type: "fillGenerated", password: password.value }).catch(() => undefined);
  }
};

export const main = (): void => {
  void restrictSessionStorage();

  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === "fill-login") {
      void onShortcut(tab);
    }
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === generateMenuId && tab?.id !== undefined) {
      void fillGenerated(tab.id);
      return;
    }
    const entryId = entryIdFromMenu(info.menuItemId);
    if (entryId !== null && tab?.id !== undefined) {
      void fillInTab(tab.id, entryId);
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "complete" && freshPending(tabId) !== null) {
      void chrome.tabs.sendMessage(tabId, { type: "offerCheck" }, { frameId: 0 }).catch(() => undefined);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    pendings.delete(tabId);
  });

  chrome.idle.onStateChanged.addListener((state) => void onIdleState(state as IdleState));
  void loadSettings().then(applyIdleInterval);

  chrome.runtime.onMessage.addListener((request: Request, sender, sendResponse) => {
    const self = { id: chrome.runtime.id, pagesUrl: chrome.runtime.getURL("") };
    const pending = route(request, sender, self, { pages: forExtensionPages, content: forContentScripts });
    if (pending === null) {
      return false;
    }
    pending.then(sendResponse, (cause: unknown) =>
      sendResponse(err({ kind: "network", message: cause instanceof Error ? cause.message : String(cause) })),
    );
    return true;
  });
};
