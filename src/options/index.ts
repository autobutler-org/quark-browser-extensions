import { h, icon, icons } from "../shared/dom";
import { stateText } from "../shared/errors";
import { ask } from "../shared/messages";
import type { Settings, VaultState } from "../shared/types";
import { othersSection } from "./others";

const root = document.getElementById("app") as HTMLElement;
const others = othersSection();

const toggle = (
  settings: Settings,
  key: "inlineButton" | "badge" | "autoSubmit",
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
  const [state, settings] = await Promise.all([ask({ type: "state" }), ask({ type: "settings" })]);
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
      others,
      h("p", { className: "muted small" }, "The vault auto-locks on the schedule set on your Quark."),
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
