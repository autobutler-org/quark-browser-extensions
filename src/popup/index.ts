import { h, icon, icons } from "../shared/dom";
import { errorText, legacyUpgradeNeeded, stateText } from "../shared/errors";
import {
  hostOf,
  insecureServerWarning,
  isFallback,
  mayHaveOtp,
  needsInsecureConfirmation,
  normalizeServer,
  searchEntries,
  serverTransport,
  type SiteMatch,
} from "../shared/host";
import { formatDuration, formatNumber, t } from "../shared/i18n";
import { upgradeLedger } from "../shared/authKey";
import { ask } from "../shared/messages";
import type { SaveAction, SaveOffer } from "../background/save";
import { currentBrowser, siteOrigins } from "../shared/platform";
import { unreachableHint } from "./address";
import { focusFallback, replaceKeepingFocus } from "./focus";
import { showWelcome, welcomeSections } from "./welcome";
import { saveBarCopy } from "../shared/saveCopy";
import { fillShortcut, shortcutHelp } from "../shared/shortcut";
import type { ApiError, EntrySummary, LegacyUpgrade, Result, VaultState } from "../shared/types";

type Tab = Readonly<{ id: number | null; url: string }>;

type Model = Readonly<{
  state: VaultState | null;
  tab: Tab;
  error: string;
  busy: boolean;
  entries: readonly EntrySummary[];
  matches: readonly SiteMatch[];
  query: string;
  generated: string;
  notice: string;
  showOthers: boolean;
  shortcut: string;
  saveOffer: SaveOffer | null;
  needsSiteAccess: boolean;
  // The connect form is open over an unreachable Quark, so the address can be fixed without signing out.
  editingAddress: boolean;
  // offered: the first-run banner shows on the connect form; reading: the welcome itself is open.
  welcome: "hidden" | "offered" | "reading";
  // The entry whose "Fill anyway" warning is open: one saved for another site than this page.
  confirming: number | null;
  // The Quark called this account legacy and wants its password once; the connect form asks before sending it.
  legacyUpgrade: LegacyUpgrade | null;
}>;

document.title = t("extName");
const root = document.getElementById("app") as HTMLElement;
// Lives outside the re-rendered tree, so a screen reader hears each notice once, however often the view is rebuilt.
const announcer = h("div", { className: "visually-hidden", role: "status" });
document.body.append(announcer);

let model: Model = {
  state: null,
  tab: { id: null, url: "" },
  error: "",
  busy: false,
  entries: [],
  matches: [],
  query: "",
  generated: "",
  notice: "",
  showOthers: false,
  shortcut: "",
  saveOffer: null,
  needsSiteAccess: false,
  editingAddress: false,
  welcome: "hidden",
  confirming: null,
  legacyUpgrade: null,
};

const update = (patch: Partial<Model>): void => {
  model = { ...model, ...patch };
  render();
};

const text = (result: Result<unknown>): string => (result.ok ? "" : errorText(result.error));

const iconButton = (label: string, paths: readonly string[], onclick: () => void): HTMLButtonElement => {
  const button = h("button", { className: "icon-button", type: "button", "aria-label": label, title: label, onclick: onclick as EventListener });
  button.append(icon(document, paths, 18));
  return button;
};

const header = (actions: readonly HTMLElement[] = [], subtitle = ""): HTMLElement =>
  h(
    "header",
    { className: "bar" },
    h("div", { className: "brand-mark" }, icon(document, icons.quark, 16)),
    h("div", { className: "brand" }, h("div", { className: "brand-name" }, t("extName")), subtitle === "" ? null : h("div", { className: "mono muted small" }, subtitle)),
    ...actions,
  );

const field = (id: string, label: string, input: HTMLInputElement): HTMLElement =>
  h("div", { className: "field" }, h("label", { for: id }, label), input);

const errorBox = (): HTMLElement | null => (model.error === "" ? null : h("div", { className: "error-box", role: "alert" }, model.error));

const serverOf = (state: VaultState | null): string => (state !== null && "server" in state ? state.server : "");

// Stays on screen for as long as the extension talks to a non-loopback Quark over plain http.
const insecureBanner = (state: VaultState): HTMLElement | null =>
  serverTransport(serverOf(state)) === "insecure" ? h("div", { className: "error-box", role: "status" }, insecureServerWarning()) : null;

const loadEntries = async (): Promise<void> => {
  const [entries, matches, settings, saveOffer] = await Promise.all([
    ask({ type: "entries" }),
    ask({ type: "matches", pageUrl: model.tab.url }),
    ask({ type: "settings" }),
    model.tab.id === null ? Promise.resolve(null) : ask({ type: "pendingOffer", tabId: model.tab.id }),
  ]);
  update({
    entries: entries.ok ? entries.value : [],
    matches: matches.ok ? matches.value : [],
    error: text(entries),
    showOthers: !settings.othersReviewed,
    saveOffer,
  });
};

const applyState = async (result: Result<VaultState>): Promise<void> => {
  if (!result.ok) {
    const legacyUpgrade = (result.error.kind === "refused" ? result.error.legacyUpgrade : undefined) ?? null;
    update({ busy: false, error: legacyUpgrade === null ? errorText(result.error) : "", legacyUpgrade });
    return;
  }
  update({ busy: false, error: "", state: result.value, editingAddress: false, legacyUpgrade: null });
  if (result.value.kind === "unlocked") {
    await loadEntries();
  }
};

const connectView = (): HTMLElement => {
  const legacy = model.legacyUpgrade;
  const server = h("input", { id: "server", type: "url", placeholder: "https://quark.local", value: legacy?.server ?? serverOf(model.state), autocomplete: "url", required: true });
  const username = h("input", { id: "username", type: "text", autocomplete: "username", value: legacy?.username ?? "", required: true });
  const password = h("input", { id: "password", type: "password", autocomplete: "current-password", required: true });
  const persist = h("input", { id: "persist", type: "checkbox" });
  const allowInsecure = h("input", { id: "allow-insecure", type: "checkbox" });
  const insecure = h(
    "div",
    { className: "error-box", role: "alert" },
    h("div", {}, t("popupInsecureAddress")),
    h("label", { className: "check" }, allowInsecure, t("popupInsecureConfirm")),
  );
  const syncInsecure = (): void => {
    insecure.hidden = !needsInsecureConfirmation(server.value);
    allowInsecure.required = !insecure.hidden;
  };
  server.addEventListener("input", syncInsecure);
  syncInsecure();
  // Shown only while the form still names the server and account that asked, so the consent can't go elsewhere.
  const allowUpgrade = h("input", { id: "legacy-upgrade", type: "checkbox" });
  const upgrade =
    legacy === null
      ? null
      : h(
          "div",
          { className: "error-box", role: "alert" },
          h("div", {}, legacyUpgradeNeeded(legacy.server)),
          h("label", { className: "check" }, allowUpgrade, t("popupLegacyUpgradeConfirm", hostOf(legacy.server))),
        );
  const syncUpgrade = (): void => {
    if (legacy !== null && upgrade !== null) {
      upgrade.hidden = normalizeServer(server.value) !== legacy.server || username.value !== legacy.username;
      allowUpgrade.required = !upgrade.hidden;
    }
  };
  server.addEventListener("input", syncUpgrade);
  username.addEventListener("input", syncUpgrade);
  syncUpgrade();
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    update({ busy: true, error: "" });
    if (legacy !== null && upgrade?.hidden === false && allowUpgrade.checked) {
      await upgradeLedger.giveConsent(legacy.server, legacy.username);
    }
    await applyState(
      await ask({
        type: "connect",
        server: server.value,
        username: username.value,
        password: password.value,
        persist: persist.checked,
        allowInsecure: !insecure.hidden && allowInsecure.checked,
      }),
    );
  };
  return h(
    "div",
    { className: "screen" },
    header(),
    h(
      "form",
      { className: "body", onsubmit: ((event: Event) => void submit(event)) as EventListener },
      h(
        "div",
        { className: "intro" },
        h("h1", {}, t("popupConnectTitle")),
        // The first-run banner takes the revoke line's room; the welcome says it instead.
        h(
          "p",
          { className: "muted" },
          model.welcome === "offered" ? t("popupConnectIntro") : t("popupConnectIntroRevoke"),
        ),
      ),
      welcomeBanner(),
      field("server", t("popupServer"), server),
      insecure,
      field("username", t("popupUsername"), username),
      field("password", t("popupPassword"), password),
      upgrade,
      h("label", { className: "check" }, persist, t("popupPersist")),
      errorBox(),
      h("div", { className: "spacer" }),
      h("button", { className: "primary", type: "submit", disabled: model.busy }, model.busy ? t("popupConnecting") : t("popupConnect")),
      model.editingAddress
        ? h("button", { className: "secondary", type: "button", onclick: (() => update({ editingAddress: false, error: "" })) as EventListener }, t("cancel"))
        : null,
    ),
  );
};

const finishWelcome = async (): Promise<void> => {
  const settings = await ask({ type: "settings" });
  await ask({ type: "saveSettings", settings: { ...settings, welcomeSeen: true } });
  update({ welcome: "hidden" });
};

const welcomeBanner = (): HTMLElement | null =>
  model.welcome === "offered"
    ? h(
        "div",
        { className: "banner", role: "status" },
        h("div", { className: "grow" }, t("popupWelcomeBanner")),
        h("button", { className: "link", type: "button", onclick: (() => update({ welcome: "reading" })) as EventListener }, t("popupWelcomeRead")),
        h("button", { className: "link muted", type: "button", onclick: (() => void finishWelcome()) as EventListener }, t("dismiss")),
      )
    : null;

const welcomeView = (): HTMLElement =>
  h(
    "div",
    { className: "screen" },
    header(),
    h(
      "div",
      { className: "scroll" },
      h(
        "div",
        { className: "body" },
        h("div", { className: "intro" }, h("h1", {}, t("popupWelcomeTitle")), h("p", { className: "muted" }, t("popupWelcomeIntro"))),
        ...welcomeSections(currentBrowser()).map((section) =>
          h("div", { className: "intro" }, h("div", { className: "section-label" }, section.title), ...section.lines.map((line) => h("p", { className: "muted" }, line))),
        ),
        h("button", { className: "primary", type: "button", onclick: (() => void finishWelcome()) as EventListener }, t("popupWelcomeDone")),
      ),
    ),
  );

const unlockView = (): HTMLElement => {
  const master = h("input", { id: "master", type: "password", autocomplete: "current-password", required: true, "data-autofocus": true });
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    update({ busy: true, error: "" });
    await applyState(await ask({ type: "unlock", masterPassword: master.value }));
  };
  return h(
    "div",
    { className: "screen" },
    header([iconButton(t("popupOptions"), icons.settings, () => void chrome.runtime.openOptionsPage())], hostOf(serverOf(model.state))),
    model.state === null ? null : insecureBanner(model.state),
    h(
      "form",
      { className: "body", onsubmit: ((event: Event) => void submit(event)) as EventListener },
      h("div", { className: "lock-mark" }, icon(document, icons.lock, 28)),
      h(
        "div",
        { className: "intro center" },
        h("h1", {}, t("popupLockedTitle")),
        h("p", { className: "muted" }, t("popupLockedIntro")),
      ),
      field("master", t("popupMasterPassword"), master),
      errorBox(),
      h("div", { className: "spacer" }),
      h("button", { className: "primary", type: "submit", disabled: model.busy }, model.busy ? t("popupUnlocking") : t("unlock")),
    ),
  );
};

const copy = async (entry: EntrySummary, what: "username" | "password" = "password"): Promise<void> => {
  const result = await ask({ type: "reveal", entryId: entry.id });
  if (!result.ok) {
    update({ error: errorText(result.error) });
    return;
  }
  await navigator.clipboard.writeText(result.value[what]);
  update({ notice: what === "username" ? t("popupCopiedUsername", entry.name) : t("popupCopiedPassword", entry.name), error: "" });
};

const copyCode = async (entry: EntrySummary): Promise<void> => {
  const result = await ask({ type: "otp", entryId: entry.id });
  if (!result.ok) {
    handleError(result.error);
    return;
  }
  await navigator.clipboard.writeText(result.value.code);
  update({ notice: t("popupCopiedCode", entry.name, formatDuration(result.value.secondsLeft, "second", "narrow")), error: "" });
};

const fillEntry = async (entry: EntrySummary): Promise<void> => {
  if (model.tab.id === null) {
    return;
  }
  const result = await ask({ type: "fillInTab", tabId: model.tab.id, entryId: entry.id });
  if (result.ok) {
    window.close();
    return;
  }
  handleError(result.error);
};

// Only after the user confirmed the warning that names both hosts; see fillAnywayBox.
const fillAnyway = async (entry: EntrySummary): Promise<void> => {
  const pageHost = pageSite(model.tab.url);
  if (model.tab.id === null || pageHost === "") {
    return;
  }
  const result = await ask({ type: "fillAnyway", tabId: model.tab.id, entryId: entry.id, pageHost });
  if (result.ok) {
    window.close();
    return;
  }
  model = { ...model, confirming: null };
  handleError(result.error);
};

const handleError = (error: ApiError): void => {
  if (error.kind === "locked" || error.kind === "signedOut") {
    void refresh();
    return;
  }
  update({ error: errorText(error) });
};

const generate = async (): Promise<void> => {
  const result = await ask({ type: "generate" });
  if (!result.ok) {
    handleError(result.error);
    return;
  }
  await navigator.clipboard.writeText(result.value);
  update({ generated: result.value, notice: t("popupGenerated") });
};

const lock = async (): Promise<void> => {
  update({ busy: true });
  await applyState(await ask({ type: "lock" }));
};

const reviewOthers = (): void => {
  void chrome.tabs.create({ url: `${chrome.runtime.getURL("options.html")}#others` });
  window.close();
};

const dismissOthers = async (): Promise<void> => {
  const settings = await ask({ type: "settings" });
  await ask({ type: "saveSettings", settings: { ...settings, othersReviewed: true } });
  update({ showOthers: false });
};

const resolveSave = async (action: SaveAction): Promise<void> => {
  if (model.tab.id === null) {
    return;
  }
  const result = await ask({ type: "resolveSave", action, tabId: model.tab.id });
  if (!result.ok) {
    handleError(result.error);
    return;
  }
  update({ saveOffer: null, notice: action === "save" ? t("popupSaved") : action === "update" ? t("popupUpdated") : "" });
  await loadEntries();
};

const saveBanner = (): HTMLElement | null => {
  if (model.saveOffer === null || model.saveOffer.kind === "unlock") {
    return null;
  }
  const copy = saveBarCopy(model.saveOffer);
  return h(
    "div",
    { className: "banner save", role: "status" },
    h("div", { className: "grow" }, h("div", { className: "name" }, copy.title), h("div", { className: "muted small" }, copy.sub)),
    ...copy.actions
      .filter(([action]) => action !== "never")
      .map(([action, label]) =>
        h("button", { className: action === "dismiss" ? "link muted" : "link", type: "button", onclick: (() => void resolveSave(action)) as EventListener }, label),
      ),
  );
};

const allowSites = async (): Promise<void> => {
  const granted = await chrome.permissions.request({ origins: [...siteOrigins] });
  update({ needsSiteAccess: !granted });
};

const siteAccessBanner = (): HTMLElement | null =>
  model.needsSiteAccess
    ? h(
        "div",
        { className: "banner save", role: "status" },
        h("div", { className: "grow" }, t("popupSiteAccess")),
        h("button", { className: "link", type: "button", onclick: (() => void allowSites()) as EventListener }, t("popupAllow")),
      )
    : null;

const othersBanner = (): HTMLElement | null =>
  model.showOthers
    ? h(
        "div",
        { className: "banner", role: "status" },
        h("div", { className: "grow" }, t("popupOthers")),
        h("button", { className: "link", type: "button", onclick: reviewOthers as EventListener }, t("popupReview")),
        h("button", { className: "link muted", type: "button", onclick: (() => void dismissOthers()) as EventListener }, t("dismiss")),
      )
    : null;

// Chrome pages and Firefox's about:addons can't be linked from an extension page, so open them with tabs.create;
// Firefox doesn't allow even that, so it gets the steps on the options page.
const openShortcutSettings = (): void => {
  const { url } = shortcutHelp(currentBrowser(), model.shortcut);
  void chrome.tabs.create({ url: url ?? `${chrome.runtime.getURL("options.html")}#shortcut` });
  window.close();
};

const shortcutBadge = (): HTMLElement =>
  model.shortcut === ""
    ? h("button", { className: "link small", type: "button", title: shortcutHelp(currentBrowser(), "").steps, onclick: openShortcutSettings as EventListener }, t("popupShortcutNotSet"))
    : h("span", { className: "mono", title: t("popupShortcut") }, model.shortcut);

const initial = (name: string): string => (name.trim()[0] ?? "?").toUpperCase();

// The first exact or same-site match is the one to fill; a fallback is never highlighted.
const matchCard = (entry: SiteMatch, index: number): HTMLElement => {
  const first = index === 0 && !isFallback(entry);
  return h(
    "div",
    { className: first ? "match first" : "match" },
    h("div", { className: "avatar", "aria-hidden": "true" }, initial(entry.name)),
    h(
      "div",
      { className: "grow" },
      h("div", { className: "name" }, entry.name),
      h("div", { className: "mono muted small" }, entry.note === "" ? entry.where : `${entry.where} · ${entry.note}`),
    ),
    mayHaveOtp(entry) ? iconButton(t("popupCopyCode", entry.name), icons.clock, () => void copyCode(entry)) : null,
    h(
      "button",
      { className: first ? "fill primary" : "fill", type: "button", "aria-label": t("fillName", entry.name), onclick: (() => void fillEntry(entry)) as EventListener },
      t("fill"),
    ),
  );
};

const pageSite = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

const matchSections = (): readonly HTMLElement[] => {
  const pageHost = pageSite(model.tab.url);
  const primary = model.matches.filter((entry) => !isFallback(entry));
  const fallbacks = model.matches.filter(isFallback);
  const section = (label: string, matches: readonly SiteMatch[]): HTMLElement =>
    h(
      "section",
      { className: "matches" },
      h("div", { className: "section-head" }, h("div", { className: "section-label grow" }, label), h("div", { className: "mono accent small" }, pageHost)),
      ...matches.map(matchCard),
    );
  return [
    ...(primary.length === 0 ? [] : [section(t("popupOnThisSite"), primary)]),
    ...(fallbacks.length === 0 ? [] : [section(t("popupOtherPort"), fallbacks)]),
  ];
};

const isWebPage = (url: string): boolean => /^https?:\/\//i.test(url) && pageSite(url) !== "";

// An entry that matches this page fills with one click, as on its match card. Any other entry needs "Fill anyway"
// and then a second click on a warning that names both hosts.
const fillButton = (entry: EntrySummary): HTMLElement | null => {
  if (model.tab.id === null || !isWebPage(model.tab.url)) {
    return null;
  }
  const match = model.matches.find((found) => found.id === entry.id);
  if (match !== undefined) {
    return h("button", { className: "fill", type: "button", "aria-label": t("fillName", entry.name), onclick: (() => void fillEntry(match)) as EventListener }, t("fill"));
  }
  return h(
    "button",
    {
      className: "fill",
      type: "button",
      "aria-label": t("popupFillAnywayName", entry.name),
      "aria-expanded": String(model.confirming === entry.id),
      onclick: (() => update({ confirming: model.confirming === entry.id ? null : entry.id, error: "" })) as EventListener,
    },
    t("popupFillAnyway"),
  );
};

const fillAnywayBox = (entry: EntrySummary): HTMLElement => {
  const pageHost = pageSite(model.tab.url);
  return h(
    "div",
    { className: "error-box", role: "alert", id: `fill-anyway-${entry.id}` },
    h("div", {}, entry.urlHost === "" ? t("popupFillAnywayNoSite", entry.name, pageHost) : t("popupFillAnywaySavedFor", entry.name, entry.urlHost, pageHost)),
    /^http:/i.test(model.tab.url) ? h("div", {}, t("popupFillAnywayHttp", pageHost)) : null,
    h("div", {}, t("popupFillAnywayTrust", pageHost)),
    h(
      "button",
      { className: "primary", type: "button", onclick: (() => void fillAnyway(entry)) as EventListener },
      t("popupFillOn", pageHost),
    ),
    h("button", { className: "secondary", type: "button", onclick: (() => update({ confirming: null })) as EventListener }, t("cancel")),
  );
};

const entryRow = (entry: EntrySummary): readonly HTMLElement[] => [
  h(
    "div",
    { className: "row" },
    h("div", { className: "grow" }, h("div", { className: "name" }, entry.name), h("div", { className: "mono muted small" }, entry.urlHost === "" ? t("popupNoSite") : entry.urlHost)),
    iconButton(t("popupCopyUsername", entry.name), icons.user, () => void copy(entry, "username")),
    iconButton(t("popupCopyPassword", entry.name), icons.copy, () => void copy(entry)),
    iconButton(t("popupCopyCode", entry.name), icons.clock, () => void copyCode(entry)),
    fillButton(entry),
  ),
  ...(model.confirming === entry.id && isWebPage(model.tab.url) ? [fillAnywayBox(entry)] : []),
];

const autoLockText = (state: VaultState): string =>
  state.kind === "unlocked" && state.autoLockSeconds > 0
    ? t("popupAutoLock", formatDuration(Math.round(state.autoLockSeconds / 60), "minute", "short"))
    : t("stateUnlocked");

const entriesView = (state: VaultState): HTMLElement => {
  const search = h("input", { id: "search", type: "search", placeholder: t("popupSearch"), value: model.query, autocomplete: "off", "data-autofocus": true });
  const list = h("div", { className: "list" });
  const renderList = (): void => {
    const found = searchEntries(model.entries, search.value);
    list.replaceChildren(
      h("div", { className: "section-label" }, t("popupAllEntries", formatNumber(found.length))),
      ...found.flatMap(entryRow),
    );
  };
  search.addEventListener("input", () => {
    model = { ...model, query: search.value };
    renderList();
  });
  renderList();

  return h(
    "div",
    { className: "screen" },
    header([iconButton(t("generatePassword"), icons.key, () => void generate()), iconButton(t("popupLock"), icons.lock, () => void lock())]),
    h("div", { className: "search" }, icon(document, icons.search, 16), h("label", { for: "search", className: "visually-hidden" }, t("popupSearch")), search),
    insecureBanner(state),
    siteAccessBanner(),
    saveBanner(),
    othersBanner(),
    model.notice === "" ? null : h("div", { className: "notice" }, model.notice),
    errorBox(),
    h(
      "div",
      { className: "scroll" },
      ...(model.query === "" ? matchSections() : []),
      list,
    ),
    h("footer", { className: "status" }, h("span", { className: "dot" }), h("span", { className: "grow" }, autoLockText(state)), shortcutBadge()),
  );
};

const messageView = (state: VaultState): HTMLElement =>
  h(
    "div",
    { className: "screen" },
    header([], hostOf(serverOf(state))),
    insecureBanner(state),
    h(
      "div",
      { className: "body" },
      h(
        "div",
        { className: "intro" },
        h("h1", {}, stateText(state)),
        state.kind === "unreachable" ? h("p", { className: "muted" }, unreachableHint(state.server)) : null,
      ),
      h("div", { className: "spacer" }),
      h("button", { className: "primary", type: "button", onclick: (() => void refresh()) as EventListener }, t("popupTryAgain")),
      state.kind === "unreachable"
        ? h("button", { className: "secondary", type: "button", onclick: (() => update({ editingAddress: true, error: "" })) as EventListener }, t("popupEditAddress"))
        : null,
      h("button", { className: "secondary", type: "button", onclick: (() => void ask({ type: "signOut" }).then(applyState)) as EventListener }, t("signOut")),
    ),
  );

const loadingView = (): HTMLElement => h("div", { className: "screen" }, header(), h("div", { className: "body center muted" }, t("popupChecking")));

const view = (): HTMLElement => {
  const { state } = model;
  if (state === null) {
    return loadingView();
  }
  switch (state.kind) {
    case "disconnected":
      return model.welcome === "reading" ? welcomeView() : connectView();
    case "signedOut":
      return connectView();
    case "locked":
      return unlockView();
    case "unlocked":
      return entriesView(state);
    case "unreachable":
      return model.editingAddress ? connectView() : messageView(state);
    case "notAdmin":
    case "notInitialized":
    case "driveDisconnected":
      return messageView(state);
  }
};

let announced = "";

const render = (): void => {
  const focus = replaceKeepingFocus(root, view());
  if (focus === "lost") {
    focusFallback(root);
  } else if (focus === "none") {
    root.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }
  if (model.notice !== announced) {
    announced = model.notice;
    announcer.textContent = model.notice;
  }
};

const currentTab = async (): Promise<Tab> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id ?? null, url: tab?.url ?? "" };
};

const refresh = async (): Promise<void> => {
  const [state, settings] = await Promise.all([ask({ type: "state" }), ask({ type: "settings" })]);
  update({ state, error: "", welcome: showWelcome(state, settings) ? "offered" : "hidden" });
  if (state.kind === "unlocked") {
    await loadEntries();
  }
};

render();
const needsSiteAccess = async (): Promise<boolean> =>
  currentBrowser() === "firefox" && !(await chrome.permissions.contains({ origins: [...siteOrigins] }));

void Promise.all([currentTab(), chrome.commands.getAll().then(fillShortcut), needsSiteAccess()]).then(([tab, shortcut, siteAccess]) => {
  model = { ...model, tab, shortcut, needsSiteAccess: siteAccess };
  return refresh();
});
