import { h, icon, icons } from "../shared/dom";
import { stateText } from "../shared/errors";
import { formatDuration, t } from "../shared/i18n";
import { ask } from "../shared/messages";
import { idleMinuteChoices, type BooleanSetting, type IdleMinutes, type Settings, type VaultState } from "../shared/types";
import { currentBrowser } from "../shared/platform";
import { fillShortcut, shortcutHelp } from "../shared/shortcut";
import { replaceKeepingFocus } from "../popup/focus";
import { othersSection } from "./others";

document.title = t("optionsTitle");
const root = document.getElementById("app") as HTMLElement;
const others = othersSection();

const toggle = (
  settings: Settings,
  key: BooleanSetting,
  title: string,
  hint: string,
): HTMLElement => {
  // The setting key names the checkbox, so focus finds it again after the page re-renders; the hint is
  // read as its description rather than run into its name.
  const input = h("input", {
    id: key,
    type: "checkbox",
    checked: settings[key],
    "aria-labelledby": `${key}-title`,
    "aria-describedby": hint === "" ? undefined : `${key}-hint`,
  });
  input.addEventListener("change", () => {
    void ask({ type: "saveSettings", settings: { ...settings, [key]: input.checked } }).then(render);
  });
  return h(
    "label",
    { className: "toggle" },
    h("div", { className: "grow" }, h("div", { id: `${key}-title` }, title), hint === "" ? null : h("div", { className: "muted small", id: `${key}-hint` }, hint)),
    input,
  );
};

const save = (settings: Settings): void => {
  void ask({ type: "saveSettings", settings }).then(render);
};

const idleMinutesSelect = (settings: Settings): HTMLElement => {
  const select = h(
    "select",
    { id: "idle-minutes", disabled: !settings.lockOnIdle },
    ...idleMinuteChoices.map((minutes) =>
      h("option", { value: String(minutes), selected: minutes === settings.idleMinutes }, t("optionsIdleAfter", formatDuration(minutes, "minute", "long"))),
    ),
  );
  select.addEventListener("change", () => save({ ...settings, idleMinutes: Number(select.value) as IdleMinutes }));
  return h(
    "div",
    { className: "toggle" },
    h("label", { className: "grow", for: "idle-minutes" }, t("optionsIdleTime")),
    select,
  );
};

const lockingSection = (settings: Settings): HTMLElement =>
  h(
    "section",
    { className: "card", id: "locking" },
    h("h2", {}, t("optionsLocking")),
    h("p", { className: "muted small" }, t("optionsLockingIntroFirefox")),
    toggle(settings, "lockOnIdle", t("optionsLockOnIdle"), t("optionsLockOnIdleHint")),
    idleMinutesSelect(settings),
  );

const openShortcuts = (url: string): void => {
  void chrome.tabs.create({ url });
};

const shortcutSection = (shortcut: string): HTMLElement => {
  const help = shortcutHelp(currentBrowser(), shortcut);
  return h(
    "section",
    { className: "card", id: "shortcut" },
    h("h2", {}, t("optionsShortcut")),
    h(
      "div",
      { className: "toggle" },
      h(
        "div",
        { className: "grow" },
        h("div", {}, t("optionsFillLogin")),
        h("div", { className: "muted small" }, t("optionsShortcutHint", help.steps)),
      ),
      h("span", { className: "mono" }, help.label),
      help.url === null
        ? null
        : h("button", { className: "secondary", type: "button", onclick: (() => openShortcuts(help.url ?? "")) as EventListener }, help.bound ? t("optionsChangeShortcut") : t("optionsSetShortcut")),
    ),
  );
};

const neverSaveSection = (hosts: readonly string[]): HTMLElement =>
  h(
    "section",
    { className: "card", id: "never-save" },
    h("h2", {}, t("optionsNeverSave")),
    ...(hosts.length === 0
      ? [h("p", { className: "muted small" }, t("optionsNeverSaveNone"))]
      : hosts.map((host) =>
          h(
            "div",
            { className: "toggle" },
            h("div", { className: "grow mono" }, host),
            h(
              "button",
              { className: "secondary", type: "button", "aria-label": t("removeName", host), onclick: (() => void ask({ type: "removeNeverSave", host }).then(render)) as EventListener },
              t("remove"),
            ),
          ),
        )),
  );

const connection = (state: VaultState): HTMLElement => {
  const signedIn = state.kind !== "disconnected" && state.kind !== "signedOut";
  return h(
    "section",
    { className: "card", id: "connection" },
    h("h2", {}, t("optionsConnection")),
    h(
      "div",
      { className: "row" },
      h(
        "div",
        { className: "grow" },
        h("div", { className: "mono" }, "server" in state ? state.server : t("optionsNoQuark")),
        h("div", { className: "muted small" }, signedIn ? t("optionsSignedIn", stateText(state)) : t("optionsConnectHint")),
      ),
      signedIn
        ? h("button", { className: "secondary", type: "button", onclick: (() => void ask({ type: "signOut" }).then(() => render())) as EventListener }, t("signOut"))
        : null,
    ),
  );
};

const render = async (): Promise<void> => {
  const [state, settings, commands, neverSave] = await Promise.all([
    ask({ type: "state" }),
    ask({ type: "settings" }),
    chrome.commands.getAll(),
    ask({ type: "neverSaveList" }),
  ]);
  const shortcut = fillShortcut(commands);
  replaceKeepingFocus(
    root,
    h(
      "main",
      { className: "page" },
      h("div", { className: "title" }, h("div", { className: "brand-mark large" }, icon(document, icons.quark, 20)), h("h1", {}, t("optionsTitle"))),
      connection(state),
      h(
        "section",
        { className: "card", id: "autofill" },
        h("h2", {}, t("optionsAutofill")),
        toggle(settings, "inlineButton", t("optionsInlineButton"), t("optionsInlineButtonHint")),
        toggle(settings, "badge", t("optionsBadge"), ""),
        toggle(settings, "autoSubmit", t("optionsAutoSubmit"), t("optionsAutoSubmitHint")),
      ),
      lockingSection(settings),
      shortcutSection(shortcut),
      neverSaveSection(neverSave),
      others,
      h("p", { className: "muted small" }, t("optionsServerAutoLock")),
    ),
  );
};

// A link from the popup lands on its section with focus there too, so keyboard and screen-reader users start in the right place.
const showSection = (section: HTMLElement | null): void => {
  if (section === null) {
    return;
  }
  section.tabIndex = -1;
  section.scrollIntoView();
  section.focus({ preventScroll: true });
};

void render().then(() => {
  if (location.hash === "#others") {
    showSection(others);
  } else if (location.hash === "#shortcut") {
    showSection(document.getElementById("shortcut"));
  }
  void ask({ type: "settings" }).then((settings) =>
    settings.othersReviewed ? settings : ask({ type: "saveSettings", settings: { ...settings, othersReviewed: true } }),
  );
});
