import { createApi } from "../shared/api";
import { formatNumber, t } from "../shared/i18n";
import {
  hostOf,
  insecureServerRefusal,
  normalizeHost,
  normalizeServer,
  primaryMatches,
  serverTransport,
  type SiteMatch,
} from "../shared/host";
import { frameMayFill, matchEntries } from "../shared/hostMatch";
import type { Hello, PageCommand, PageReply, Request, Responses } from "../shared/messages";
import { err, ok, type Connection, type EntrySummary, type Result, type Settings, type VaultState } from "../shared/types";
import { defaultPlan, drawPassword, generateFor, sanePlan, type PasswordPlan } from "../shared/password";
import { parseOtpSecret, totp } from "../shared/totp";
import { entryIdFromMenu, generateMenuId, menuItems, menuRoot, shortcutPlan } from "../shared/menu";
import { detectionIntervalSeconds, idleAction, type IdleState } from "./idle";
import {
  afterNavigation,
  capturedNow,
  decideOffer,
  isFresh,
  isNeverSaved,
  newEntryFor,
  relatedHosts,
  type Pending,
  type SaveAction,
  type SaveOffer,
} from "./save";
import { isTopFrame, route, type ContentScriptHandlers, type ExtensionPageHandlers, type Sender } from "./gate";
import { frameIsShown, frameReport } from "./frames";
import { grantAllows, grantFor, manualFillCommand, manualFillRefusal, type ManualGrant } from "./manual";
import { upgradeLedger } from "./keyedAccounts";
import { createCache, deriveState } from "./state";
import { createVault } from "./vault";
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

const api = createApi((input, init) => fetch(input, init), upgradeLedger);
const vault = createVault(api);
// The decrypted entries without their secrets, in memory only, for matching pages and the popup's list.
const entriesCache = createCache<readonly EntrySummary[]>(30_000);

// Manual fills the user confirmed in the popup, by tab; see manual.ts.
const manualGrants = new Map<number, ManualGrant>();

const forgetEntries = (): void => {
  entriesCache.clear();
  manualGrants.clear();
};

const sendToFrame = (tabId: number, message: PageCommand, options: { frameId: number }): Promise<unknown> =>
  chrome.tabs.sendMessage(tabId, message, options);

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

const embeddedRefusal = (topUrl: string): string => {
  const host = hostOf(topUrl);
  return host === "" ? t("refuseEmbeddedInPage") : t("refuseEmbeddedIn", host);
};

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
  // The vault was deleted from the app since it was opened here.
  if (!result.ok && result.error.kind === "notInitialized") {
    forgetEntries();
    await vault.lock();
  }
  return result;
};

// Drawn on the device; generateFor keeps a draw only when it has every class asked for (#131).
const generated = (plan: PasswordPlan): Promise<Result<string>> => generateFor(plan, drawPassword);

// Open when this browser holds the vault key. Otherwise the Quark says whether there is a vault to unlock, and
// whether the session still holds.
const currentState = async (): Promise<VaultState> => {
  const [server, connection] = await Promise.all([loadServer(), loadConnection()]);
  if (connection === null) {
    return deriveState(server, false, null);
  }
  if (await vault.isOpen(connection.server)) {
    return deriveState(server, true, ok(true));
  }
  const wrapped = await withConnection((conn) => api.vaultKey(conn));
  const stillSignedIn = (await loadConnection()) !== null;
  return deriveState(server, stillSignedIn, wrapped.ok ? ok(false) : wrapped);
};

const stateAfter = async (result: Result<unknown>): Promise<Result<VaultState>> => {
  forgetEntries();
  menuOrigin = null;
  return result.ok ? ok(await currentState()) : err(result.error);
};

// `touch`: a user opened the list, which keeps the vault from auto-locking; a page asking for matches doesn't.
const entries = (touch = false): Promise<Result<readonly EntrySummary[]>> =>
  withConnection(async (conn) => {
    if (!(await vault.isOpen(conn.server, touch))) {
      entriesCache.clear();
      return err({ kind: "locked" });
    }
    const cached = entriesCache.get();
    if (cached !== undefined) {
      return ok(cached);
    }
    const result = await vault.entries(conn, false);
    if (result.ok) {
      entriesCache.set(result.value);
    }
    return result;
  });

const matchesFor = async (pageUrl: string): Promise<Result<readonly SiteMatch[]>> => {
  const result = await entries();
  return result.ok ? ok(matchEntries(result.value, pageUrl, (found) => found.url)) : result;
};

const entryDetail = (entryId: number) => withConnection((conn) => vault.entry(conn, entryId));

const refused = (reason: string) => err({ kind: "refused", reason } as const);

const fillFromPage = async (
  sender: Sender,
  entryId: number,
): Promise<Responses["fillFromPage"]> => {
  const pageUrl = sender.url ?? "";
  const [settings, entry, topUrl] = await Promise.all([
    loadSettings(),
    entryDetail(entryId),
    topFrameUrl(sender),
  ]);
  if (!entry.ok) {
    return entry;
  }
  // A fill the user confirmed for a site the entry isn't saved for is used once and never submits the form.
  const grant = sender.tab?.id === undefined ? undefined : manualGrants.get(sender.tab.id);
  if (grant !== undefined && grantAllows(grant, sender, entryId, Date.now())) {
    manualGrants.delete(grant.tabId);
    return ok({ username: entry.value.username, password: entry.value.password, autoSubmit: false });
  }
  if (!frameMayFill(pageUrl, pageUrl, entry.value.url, entry.value.urlHost)) {
    return refused(t("refuseWrongSite"));
  }
  if (!frameMayFill(pageUrl, topUrl, entry.value.url, entry.value.urlHost)) {
    return refused(embeddedRefusal(topUrl));
  }
  // A subframe gets the login only if its <iframe>, and each one above it, is shown in its parent (#141).
  const tabId = sender.tab?.id;
  if (!isTopFrame(sender) && (tabId === undefined || !(await frameIsShown(sendToFrame, tabId, sender.frameId ?? -1)))) {
    return refused(t("refuseHiddenFrame"));
  }
  return ok({ username: entry.value.username, password: entry.value.password, autoSubmit: settings.autoSubmit });
};

const otpFor = async (entryId: number, sender: Sender | null): Promise<Responses["otp"]> => {
  const [entry, topUrl] = await Promise.all([
    entryDetail(entryId),
    sender === null ? Promise.resolve("") : topFrameUrl(sender),
  ]);
  if (!entry.ok) {
    return entry;
  }
  const pageUrl = sender?.url ?? "";
  if (sender !== null && !frameMayFill(pageUrl, pageUrl, entry.value.url, entry.value.urlHost)) {
    return refused(t("refuseWrongSite"));
  }
  if (sender !== null && !frameMayFill(pageUrl, topUrl, entry.value.url, entry.value.urlHost)) {
    return refused(embeddedRefusal(topUrl));
  }
  const params = parseOtpSecret(entry.value.totpSecret);
  return params === null ? refused(t("refuseNoOtp")) : ok(await totp(params, Date.now()));
};

// Credentials never ride on this message, because it reaches every frame in the tab. The frame that has the
// login form asks for them with fillFromPage, which checks that frame's own URL in the worker.
const fillInTab = async (tabId: number, entryId: number): Promise<Responses["fillInTab"]> => {
  const [entry, topUrl] = await Promise.all([
    entryDetail(entryId),
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
    const reply = await chrome.tabs.sendMessage<PageCommand, PageReply | undefined>(tabId, command);
    if (reply === undefined) {
      return refused(t("refuseNoFieldsReload"));
    }
    return reply;
  } catch {
    return refused(t("refuseReload"));
  }
};

// The popup's "Fill anyway", after the user confirmed filling an entry into a page on another site. The tab's URL
// comes from the browser, and must still be on the host the user confirmed. Only frame 0 hears about it, and it
// collects the credentials with fillFromPage under a one-time grant.
const fillAnyway = async (tabId: number, entryId: number, pageHost: string): Promise<Responses["fillAnyway"]> => {
  const [entry, tab] = await Promise.all([
    entryDetail(entryId),
    chrome.tabs.get(tabId).catch(() => undefined),
  ]);
  if (!entry.ok) {
    return entry;
  }
  const tabUrl = tab?.url ?? "";
  const refusal = manualFillRefusal(tabUrl, pageHost);
  if (refusal !== null) {
    return refused(refusal);
  }
  if (frameMayFill(tabUrl, tabUrl, entry.value.url, entry.value.urlHost)) {
    return fillInTab(tabId, entryId);
  }
  const grant = grantFor(tabId, entryId, tabUrl, Date.now());
  if (grant === null) {
    return refused(t("refuseCantFill"));
  }
  manualGrants.set(tabId, grant);
  try {
    const reply = await chrome.tabs.sendMessage<PageCommand, PageReply | undefined>(tabId, manualFillCommand(entryId, tabUrl), {
      frameId: 0,
    });
    return reply ?? refused(t("refuseNoFieldsReload"));
  } catch {
    return refused(t("refuseReload"));
  } finally {
    if (manualGrants.get(tabId) === grant) {
      manualGrants.delete(tabId);
    }
  }
};

const setBadge = async (tabId: number, count: number, enabled: boolean): Promise<void> => {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0369A1" });
  await chrome.action.setBadgeText({ tabId, text: enabled && count > 0 ? formatNumber(count) : "" });
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
  const [open, matches] = await Promise.all([vault.isOpen(connection.server), matchesFor(pending.pageUrl)]);
  return decideOffer({
    pageUrl: pending.pageUrl,
    credentials: pending.credentials,
    matches: matches.ok ? matches.value : [],
    locked: !open,
    loadDetail: (id) => vault.entry(connection, id),
  });
};

const captured = async (sender: Sender, username: string, password: string): Promise<SaveOffer | null> => {
  const tabId = sender.tab?.id;
  const pageUrl = sender.url ?? "";
  if (tabId === undefined || isNeverSaved(await loadNeverSave(), pageUrl)) {
    return null;
  }
  pendings.set(tabId, capturedNow(pageUrl, { username, password }, Date.now()));
  return offerFor(tabId);
};

const myOffer = async (sender: Sender): Promise<SaveOffer | null> => {
  const tabId = sender.tab?.id;
  const pending = tabId === undefined ? null : freshPending(tabId);
  if (tabId === undefined || pending === null) {
    return null;
  }
  if (!relatedHosts(hostOf(pending.pageUrl), hostOf(sender.url ?? ""))) {
    // The tab has left the site the login was typed on.
    pendings.delete(tabId);
    return null;
  }
  return offerFor(tabId);
};

const resolveSave = async (tabId: number, action: SaveAction): Promise<Result<null>> => {
  const pending = freshPending(tabId);
  if (pending === null) {
    return refused(t("refuseSaveGone"));
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
      return finish(await withConnection((conn) => vault.create(conn, newEntryFor(pending.pageUrl, pending.credentials))));
    case "update": {
      const offer = await offerFor(tabId);
      if (offer?.kind !== "update") {
        return refused(t("refuseNothingToUpdate"));
      }
      return finish(await withConnection((conn) => vault.replacePassword(conn, offer.entryId, pending.credentials.password)));
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
  chrome.contextMenus.create({ id: menuRoot, title: t("extName"), contexts: ["editable"] });
  menuItems(result.ok ? result.value : []).forEach((item) =>
    chrome.contextMenus.create({ id: item.id, parentId: menuRoot, title: item.title, enabled: item.enabled, contexts: ["editable"] }),
  );
  chrome.contextMenus.create({ id: "sep", parentId: menuRoot, type: "separator", contexts: ["editable"] });
  chrome.contextMenus.create({ id: generateMenuId, parentId: menuRoot, title: t("generatePassword"), contexts: ["editable"] });
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
    return refused(insecureServerRefusal());
  }
  const signedIn = await api.login(server, request.username, request.password);
  if (!signedIn.ok) {
    return signedIn;
  }
  const connection = { server, token: signedIn.value.token };
  await saveConnection(connection, request.persist);
  // The password that just signed in opens the vault too. If it doesn't (no vault yet, or one wrapped under an
  // older password), the state says so and the popup asks.
  await vault.unlock(connection, request.password, signedIn.value);
  return ok(await currentState());
};

const signOut = async (): Promise<Responses["signOut"]> => {
  const connection = await loadConnection();
  if (connection !== null) {
    await api.logout(connection);
  }
  forgetEntries();
  await vault.lock();
  await clearConnection();
  return ok(await currentState());
};

const forExtensionPages: ExtensionPageHandlers = {
  state: () => currentState(),
  connect: (request) => connect(request),
  signOut: () => signOut(),
  unlock: (request) => withConnection((conn) => vault.unlock(conn, request.password)).then(stateAfter),
  lock: () => vault.lock().then(() => stateAfter(ok(null))),
  entries: () => entries(true),
  matches: (request) => matchesFor(request.pageUrl ?? ""),
  fillInTab: (request) => fillInTab(request.tabId, request.entryId),
  fillAnyway: (request) => fillAnyway(request.tabId, request.entryId, request.pageHost),
  reveal: (request) =>
    entryDetail(request.entryId).then((entry) =>
      entry.ok ? ok({ username: entry.value.username, password: entry.value.password }) : entry,
    ),
  generate: () => generated(defaultPlan),
  otp: (request) => otpFor(request.entryId, null),
  pendingOffer: (request) => offerFor(request.tabId),
  resolveSave: (request) =>
    request.tabId === undefined ? Promise.resolve(refused(t("refuseNoTab"))) : resolveSave(request.tabId, request.action),
  neverSaveList: () => loadNeverSave(),
  removeNeverSave: (request) => loadNeverSave().then((hosts) => saveNeverSave(hosts.filter((host) => host !== request.host))),
  settings: () => loadSettings(),
  saveSettings: (request) => saveSettings(request.settings).then(applyIdleInterval),
};

const forContentScripts: ContentScriptHandlers = {
  hello: (sender) => hello(sender),
  fieldFocused: (sender) => rebuildMenu(sender.url ?? "").then(() => null),
  otpFromPage: (request, sender) => otpFor(request.entryId, sender),
  generateForPage: (request) => generated(sanePlan(request.length, request.classes)),
  captured: (request, sender) => captured(sender, request.username, request.password),
  myOffer: (sender) => myOffer(sender),
  resolveSave: (request, tabId) => resolveSave(tabId, request.action),
  matches: (sender) => matchesFor(sender.url ?? ""),
  fillFromPage: (request, sender) => fillFromPage(sender, request.entryId),
  frameReport: (request, sender) => {
    frameReport(sender, request.nonce, request.shown);
    return Promise.resolve(null);
  },
};

const applyIdleInterval = (settings: Settings): Settings => {
  chrome.idle.setDetectionInterval(detectionIntervalSeconds(settings));
  return settings;
};

const onIdleState = async (state: IdleState): Promise<void> => {
  const settings = await loadSettings();
  if (idleAction(state, settings) === "lock") {
    forgetEntries();
    await vault.lock();
  }
};

// Only the frame the user right-clicked gets the password: a broadcast would reach the embedding page and
// every other iframe in the tab.
const fillGenerated = async (tabId: number, frameId: number): Promise<void> => {
  const password = await generated(defaultPlan);
  if (password.ok) {
    await chrome.tabs.sendMessage(tabId, { type: "fillGenerated", password: password.value }, { frameId }).catch(() => undefined);
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
      void fillGenerated(tab.id, info.frameId ?? 0);
      return;
    }
    const entryId = entryIdFromMenu(info.menuItemId);
    if (entryId !== null && tab?.id !== undefined) {
      void fillInTab(tab.id, entryId);
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, info) => {
    const pending = info.status === "loading" ? freshPending(tabId) : null;
    if (pending !== null) {
      const kept = afterNavigation(pending, Date.now());
      if (kept === null) {
        pendings.delete(tabId);
      } else {
        pendings.set(tabId, kept);
      }
    }
    if (info.status === "complete" && freshPending(tabId) !== null) {
      void chrome.tabs.sendMessage(tabId, { type: "offerCheck" }, { frameId: 0 }).catch(() => undefined);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    pendings.delete(tabId);
    manualGrants.delete(tabId);
  });

  chrome.idle.onStateChanged.addListener((state) => void onIdleState(state));
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
