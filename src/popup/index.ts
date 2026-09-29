import { h, icon, icons } from "../shared/dom";
import { errorText, stateText } from "../shared/errors";
import { hostOf, searchEntries } from "../shared/host";
import { ask } from "../shared/messages";
import type { SaveAction, SaveOffer } from "../background/save";
import { saveBarCopy } from "../shared/saveCopy";
import type { ApiError, EntrySummary, Result, VaultState } from "../shared/types";

type Tab = Readonly<{ id: number | null; url: string }>;

type Model = Readonly<{
  state: VaultState | null;
  tab: Tab;
  error: string;
  busy: boolean;
  entries: readonly EntrySummary[];
  matches: readonly EntrySummary[];
  query: string;
  generated: string;
  notice: string;
  showOthers: boolean;
  shortcut: string;
  saveOffer: SaveOffer | null;
}>;

const root = document.getElementById("app") as HTMLElement;

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
    h("div", { className: "brand" }, h("div", { className: "brand-name" }, "Quark Vault"), subtitle === "" ? null : h("div", { className: "mono muted small" }, subtitle)),
    ...actions,
  );

const field = (id: string, label: string, input: HTMLInputElement): HTMLElement =>
  h("div", { className: "field" }, h("label", { for: id }, label), input);

const errorBox = (): HTMLElement | null => (model.error === "" ? null : h("div", { className: "error-box", role: "alert" }, model.error));

const serverOf = (state: VaultState | null): string => (state !== null && "server" in state ? state.server : "");

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
    update({ busy: false, error: errorText(result.error) });
    return;
  }
  update({ busy: false, error: "", state: result.value });
  if (result.value.kind === "unlocked") {
    await loadEntries();
  }
};

const connectView = (): HTMLElement => {
  const server = h("input", { id: "server", type: "url", placeholder: "https://quark.local", value: serverOf(model.state), autocomplete: "url", required: true });
  const username = h("input", { id: "username", type: "text", autocomplete: "username", required: true });
  const password = h("input", { id: "password", type: "password", autocomplete: "current-password", required: true });
  const persist = h("input", { id: "persist", type: "checkbox" });
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    update({ busy: true, error: "" });
    await applyState(
      await ask({ type: "connect", server: server.value, username: username.value, password: password.value, persist: persist.checked }),
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
        h("h1", {}, "Connect to your Quark"),
        h("p", { className: "muted" }, "Sign in with an admin account. This browser shows up in Settings › Sessions, where you can revoke it any time."),
      ),
      field("server", "Quark address", server),
      field("username", "Username", username),
      field("password", "Password", password),
      h("label", { className: "check" }, persist, "Stay signed in after Chrome closes"),
      errorBox(),
      h("div", { className: "spacer" }),
      h("button", { className: "primary", type: "submit", disabled: model.busy }, model.busy ? "Connecting…" : "Connect"),
    ),
  );
};

const unlockView = (): HTMLElement => {
  const master = h("input", { id: "master", type: "password", autocomplete: "current-password", required: true });
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    update({ busy: true, error: "" });
    await applyState(await ask({ type: "unlock", masterPassword: master.value }));
  };
  const view = h(
    "div",
    { className: "screen" },
    header([iconButton("Options", icons.settings, () => void chrome.runtime.openOptionsPage())], hostOf(serverOf(model.state))),
    h(
      "form",
      { className: "body", onsubmit: ((event: Event) => void submit(event)) as EventListener },
      h("div", { className: "lock-mark" }, icon(document, icons.lock, 28)),
      h(
        "div",
        { className: "intro center" },
        h("h1", {}, "Vault is locked"),
        h("p", { className: "muted" }, "Unlocking here unlocks the vault on your Quark for every device, until it auto-locks."),
      ),
      field("master", "Vault password", master),
      errorBox(),
      h("div", { className: "spacer" }),
      h("button", { className: "primary", type: "submit", disabled: model.busy }, model.busy ? "Unlocking…" : "Unlock"),
    ),
  );
  queueMicrotask(() => master.focus());
  return view;
};

const copy = async (entry: EntrySummary): Promise<void> => {
  const result = await ask({ type: "reveal", entryId: entry.id });
  if (!result.ok) {
    update({ error: errorText(result.error) });
    return;
  }
  await navigator.clipboard.writeText(result.value.password);
  update({ notice: `Copied the password for ${entry.name}`, error: "" });
};

const copyCode = async (entry: EntrySummary): Promise<void> => {
  const result = await ask({ type: "otp", entryId: entry.id });
  if (!result.ok) {
    handleError(result.error);
    return;
  }
  await navigator.clipboard.writeText(result.value.code);
  update({ notice: `Copied the code for ${entry.name}. It changes in ${result.value.secondsLeft}s.`, error: "" });
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
  update({ generated: result.value, notice: "Generated a password and copied it" });
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
  update({ saveOffer: null, notice: action === "save" ? "Saved the login" : action === "update" ? "Updated the password" : "" });
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

const othersBanner = (): HTMLElement | null =>
  model.showOthers
    ? h(
        "div",
        { className: "banner", role: "status" },
        h("div", { className: "grow" }, "Google or another password manager may also try to fill logins."),
        h("button", { className: "link", type: "button", onclick: reviewOthers as EventListener }, "Review"),
        h("button", { className: "link muted", type: "button", onclick: (() => void dismissOthers()) as EventListener }, "Dismiss"),
      )
    : null;

const initial = (name: string): string => (name.trim()[0] ?? "?").toUpperCase();

const matchCard = (entry: EntrySummary, index: number): HTMLElement =>
  h(
    "div",
    { className: index === 0 ? "match first" : "match" },
    h("div", { className: "avatar", "aria-hidden": "true" }, initial(entry.name)),
    h("div", { className: "grow" }, h("div", { className: "name" }, entry.name), h("div", { className: "mono muted small" }, entry.urlHost)),
    iconButton(`Copy one-time code for ${entry.name}`, icons.clock, () => void copyCode(entry)),
    h("button", { className: index === 0 ? "fill primary" : "fill", type: "button", onclick: (() => void fillEntry(entry)) as EventListener }, "Fill"),
  );

const entryRow = (entry: EntrySummary): HTMLElement =>
  h(
    "div",
    { className: "row" },
    h("div", { className: "grow" }, h("div", { className: "name" }, entry.name), h("div", { className: "mono muted small" }, entry.urlHost === "" ? "no site" : entry.urlHost)),
    iconButton(`Copy password for ${entry.name}`, icons.copy, () => void copy(entry)),
  );

const autoLockText = (state: VaultState): string =>
  state.kind === "unlocked" && state.autoLockSeconds > 0
    ? `Unlocked · auto-locks after ${Math.round(state.autoLockSeconds / 60)} min idle`
    : "Unlocked";

const entriesView = (state: VaultState): HTMLElement => {
  const pageHost = hostOf(model.tab.url);
  const search = h("input", { id: "search", type: "search", placeholder: "Search the vault", value: model.query, autocomplete: "off" });
  const list = h("div", { className: "list" });
  const renderList = (): void => {
    const found = searchEntries(model.entries, search.value);
    list.replaceChildren(
      h("div", { className: "section-label" }, `All entries · ${found.length}`),
      ...found.map(entryRow),
    );
  };
  search.addEventListener("input", () => {
    model = { ...model, query: search.value };
    renderList();
  });
  renderList();
  queueMicrotask(() => search.focus());

  return h(
    "div",
    { className: "screen" },
    header([iconButton("Generate password", icons.key, () => void generate()), iconButton("Lock vault", icons.lock, () => void lock())]),
    h("div", { className: "search" }, icon(document, icons.search, 16), h("label", { for: "search", className: "visually-hidden" }, "Search the vault"), search),
    saveBanner(),
    othersBanner(),
    model.notice === "" ? null : h("div", { className: "notice", role: "status" }, model.notice),
    errorBox(),
    h(
      "div",
      { className: "scroll" },
      model.matches.length === 0 || model.query !== ""
        ? null
        : h(
            "section",
            { className: "matches" },
            h("div", { className: "section-head" }, h("div", { className: "section-label grow" }, "On this site"), h("div", { className: "mono accent small" }, pageHost)),
            ...model.matches.map(matchCard),
          ),
      list,
    ),
    h("footer", { className: "status" }, h("span", { className: "dot" }), h("span", { className: "grow" }, autoLockText(state)), h("span", { className: "mono", title: model.shortcut === "" ? "" : "Fill shortcut" }, model.shortcut === "" ? hostOf(serverOf(state)) : model.shortcut)),
  );
};

const messageView = (state: VaultState): HTMLElement =>
  h(
    "div",
    { className: "screen" },
    header([], hostOf(serverOf(state))),
    h(
      "div",
      { className: "body" },
      h("div", { className: "intro" }, h("h1", {}, stateText(state))),
      h("div", { className: "spacer" }),
      h("button", { className: "primary", type: "button", onclick: (() => void refresh()) as EventListener }, "Try again"),
      h("button", { className: "secondary", type: "button", onclick: (() => void ask({ type: "signOut" }).then(applyState)) as EventListener }, "Sign out"),
    ),
  );

const loadingView = (): HTMLElement => h("div", { className: "screen" }, header(), h("div", { className: "body center muted" }, "Checking your Quark…"));

const view = (): HTMLElement => {
  const { state } = model;
  if (state === null) {
    return loadingView();
  }
  switch (state.kind) {
    case "disconnected":
    case "signedOut":
      return connectView();
    case "locked":
      return unlockView();
    case "unlocked":
      return entriesView(state);
    case "notAdmin":
    case "notInitialized":
    case "driveDisconnected":
    case "unreachable":
      return messageView(state);
  }
};

const render = (): void => {
  root.replaceChildren(view());
};

const currentTab = async (): Promise<Tab> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return { id: tab?.id ?? null, url: tab?.url ?? "" };
};

const refresh = async (): Promise<void> => {
  const state = await ask({ type: "state" });
  update({ state, error: "" });
  if (state.kind === "unlocked") {
    await loadEntries();
  }
};

render();
const fillShortcut = async (): Promise<string> =>
  (await chrome.commands.getAll()).find((command) => command.name === "fill-login")?.shortcut ?? "";

void Promise.all([currentTab(), fillShortcut()]).then(([tab, shortcut]) => {
  model = { ...model, tab, shortcut };
  return refresh();
});
