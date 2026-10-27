import { pendingTtlMs, type SaveAction, type SaveOffer } from "../background/save";
import { h$, icon, icons } from "../shared/dom";
import { adoptStyles } from "./styles";
import { saveBarCopy } from "../shared/saveCopy";

const css = `
:host { all: initial; }
.bar {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 340px; box-sizing: border-box;
  max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow-y: auto;
  padding: 14px; border-radius: 12px; background: var(--card); border: 1px solid var(--border);
  box-shadow: 0 16px 40px rgba(2, 6, 23, 0.35); color: var(--fg);
  font: 14px/1.4 "IBM Plex Sans", system-ui, sans-serif; display: flex; flex-direction: column; gap: 10px;
}
.bar:focus { outline: none; }
.bar:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
@media (max-width: 372px) {
  .bar { top: 8px; right: 8px; }
}
.head { display: flex; gap: 10px; align-items: flex-start; }
.mark {
  width: 28px; height: 28px; flex-shrink: 0; border-radius: 8px; background: var(--primary); color: var(--primary-fg);
  display: flex; align-items: center; justify-content: center;
}
.head > div:last-child { min-width: 0; }
.title { font-weight: 600; overflow-wrap: anywhere; }
.sub { font-size: 12px; color: var(--muted); word-break: break-all; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.spacer { flex-grow: 1; }
button {
  min-height: 36px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--control); background: var(--card);
  color: var(--fg); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
button.primary { border-color: var(--primary); background: var(--primary); color: var(--primary-fg); }
button.quiet { padding: 6px 0; border-color: transparent; background: transparent; color: var(--muted); font-weight: 500; }
button.quiet:hover { color: var(--fg); }
button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.error { font-size: 13px; color: var(--error-fg); }
`;

let current: HTMLElement | null = null;
let previous: HTMLElement | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;

export const hideSaveBar = (): void => {
  clearTimeout(expiry);
  expiry = undefined;
  // Hand focus back to wherever it was before the bar took it, unless the user has moved on.
  const hadFocus = current !== null && current.ownerDocument.activeElement === current;
  current?.remove();
  current = null;
  if (hadFocus && previous?.isConnected === true) {
    previous.focus({ preventScroll: true });
  }
  previous = null;
};

export const showSaveBar = (
  doc: Document,
  offer: SaveOffer,
  onAction: (action: SaveAction) => Promise<string | null>,
): void => {
  hideSaveBar();
  const host = h$(doc, "div");
  const shadow = host.attachShadow({ mode: "closed" });
  adoptStyles(shadow, css);

  const copy = saveBarCopy(offer);
  const mark = h$(doc, "div", { className: "mark", "aria-hidden": "true" });
  mark.append(icon(doc, icons.quark, 16));
  const bar = h$(
    doc,
    "div",
    { className: "bar", role: "dialog", "aria-labelledby": "quark-save-title", "aria-describedby": "quark-save-sub", tabindex: "-1" },
    h$(
      doc,
      "div",
      { className: "head" },
      mark,
      h$(doc, "div", {}, h$(doc, "div", { className: "title", id: "quark-save-title" }, copy.title), h$(doc, "div", { className: "sub", id: "quark-save-sub" }, copy.sub)),
    ),
  );
  const actions = h$(doc, "div", { className: "actions" });
  const quiet = copy.actions.filter(([action]) => action === "never");
  const main = copy.actions.filter(([action]) => action !== "never");
  const ordered = [...quiet, null, ...main];
  ordered.forEach((entry) => {
    if (entry === null) {
      actions.append(h$(doc, "div", { className: "spacer" }));
      return;
    }
    const [action, label] = entry;
    const className = action === "never" ? "quiet" : action === main.at(-1)?.[0] ? "primary" : "";
    const button = h$(doc, "button", { type: "button", className }, label);
    button.addEventListener("click", () => {
      void onAction(action).then((failure) => {
        if (failure === null) {
          hideSaveBar();
          return;
        }
        bar.querySelector(".error")?.remove();
        bar.append(h$(doc, "div", { className: "error", role: "alert" }, failure));
      });
    });
    actions.append(button);
  });
  bar.append(actions);
  bar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void onAction("dismiss").then(hideSaveBar);
    }
  });
  shadow.append(bar);
  const active = doc.activeElement;
  doc.body.append(host);
  current = host;
  // The worker forgets the login after pendingTtlMs; a bar left up past that could only fail, so it goes too.
  expiry = setTimeout(hideSaveBar, pendingTtlMs);
  previous = active instanceof HTMLElement && active !== doc.body ? active : null;
  // Move focus to the bar so a keyboard or screen-reader user lands on it (and hears its name)
  // instead of having to Tab through the whole page; Escape dismisses it.
  bar.focus({ preventScroll: true });
};
