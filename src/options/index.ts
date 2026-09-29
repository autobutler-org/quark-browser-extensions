import { h, icon, icons } from "../shared/dom";
import { stateText } from "../shared/errors";
import { ask } from "../shared/messages";
import { idleMinuteChoices, type BooleanSetting, type IdleMinutes, type Settings, type VaultState } from "../shared/types";
import { othersSection } from "./others";

const root = document.getElementById("app") as HTMLElement;
const others = othersSection();

const toggle = (
  settings: Settings,
  key: BooleanSetting,
  title: string,
  hint: string,
): HTMLElement => {
  const input = h("input", { type: "checkbox", checked: settings[key] });
  input.addEventListener("change", () => {
    void ask({ type: "saveSettings", settings: { ...settings, [key]: input.checked } }).then(render);
  });
  return h(
    "label",
    { className: "toggle" },
    h("div", { className: "grow" }, h("div", {}, title), hint === "" ? null : h("div", { className: "muted small" }, hint)),
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
      h("option", { value: String(minutes), selected: minutes === settings.idleMinutes }, `After ${minutes} minutes`),
    ),
  );
  select.addEventListener("change", () => save({ ...settings, idleMinutes: Number(select.value) as IdleMinutes }));
  return h(
    "div",
    { className: "toggle" },
    h("label", { className: "grow", for: "idle-minutes" }, "Idle time before locking"),
    select,
  );
};

const lockingSection = (settings: Settings): HTMLElement =>
  h(
    "section",
    { className: "card" },
    h("h2", {}, "Locking"),
    h("p", { className: "muted small" }, "Locking from this browser locks the vault on your Quark for every device. The vault always locks when this computer's screen locks."),
    toggle(settings, "lockOnIdle", "Lock the vault when this computer is idle", "Off by default, so someone else mid-task isn't locked out"),
    idleMinutesSelect(settings),
  );

const shortcutSection = (shortcut: string): HTMLElement =>
  h(
    "section",
    { className: "card" },
    h("h2", {}, "Shortcut"),
    h(
      "div",
      { className: "toggle" },
      h(
        "div",
        { className: "grow" },
        h("div", {}, "Fill a login"),
        h("div", { className: "muted small" }, "One match fills right away; several open the picker. Right-click a field for the same list. Change it at chrome://extensions/shortcuts."),
      ),
      h("span", { className: "mono" }, shortcut === "" ? "Not set" : shortcut),
    ),
  );

const connection = (state: VaultState): HTMLElement => {
  const signedIn = state.kind !== "disconnected" && state.kind !== "signedOut";
  return h(
    "section",
    { className: "card" },
    h("h2", {}, "Connection"),
    h(
      "div",
      { className: "row" },
      h(
        "div",
        { className: "grow" },
        h("div", { className: "mono" }, "server" in state ? state.server : "No Quark connected"),
        h("div", { className: "muted small" }, signedIn ? `Signed in · ${stateText(state)}` : "Open the Quark Vault toolbar button to connect."),
      ),
      signedIn
        ? h("button", { className: "secondary", type: "button", onclick: (() => void ask({ type: "signOut" }).then(() => render())) as EventListener }, "Sign out")
        : null,
    ),
  );
};

const render = async (): Promise<void> => {
  const [state, settings, commands] = await Promise.all([ask({ type: "state" }), ask({ type: "settings" }), chrome.commands.getAll()]);
  const shortcut = commands.find((command) => command.name === "fill-login")?.shortcut ?? "";
  root.replaceChildren(
    h(
      "main",
      { className: "page" },
      h("div", { className: "title" }, h("div", { className: "brand-mark large" }, icon(document, icons.quark, 20)), h("h1", {}, "Quark Vault options")),
      connection(state),
      h(
        "section",
        { className: "card" },
        h("h2", {}, "Autofill"),
        toggle(settings, "inlineButton", "Show the Quark button in password fields", "Only when the vault has an entry for the site"),
        toggle(settings, "badge", "Show the match count on the toolbar icon", ""),
        toggle(settings, "autoSubmit", "Submit the form after filling", "Off by default. Some sites need a second look first."),
      ),
      lockingSection(settings),
      shortcutSection(shortcut),
      others,
      h("p", { className: "muted small" }, "The vault also auto-locks on the schedule set on your Quark."),
    ),
  );
};

void render().then(() => {
  if (location.hash === "#others") {
    others.scrollIntoView();
  }
  void ask({ type: "settings" }).then((settings) =>
    settings.othersReviewed ? settings : ask({ type: "saveSettings", settings: { ...settings, othersReviewed: true } }),
  );
});
