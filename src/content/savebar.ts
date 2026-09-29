import type { SaveAction, SaveOffer } from "../background/save";
import { h$, icon, icons } from "../shared/dom";
import { saveBarCopy } from "../shared/saveCopy";

const css = `
:host { all: initial; }
.bar {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 340px; box-sizing: border-box;
  padding: 14px; border-radius: 12px; background: #0F172A; border: 1px solid #1E293B;
  box-shadow: 0 16px 40px rgba(2, 6, 23, 0.35); color: #E2E8F0;
  font: 14px/1.4 "IBM Plex Sans", system-ui, sans-serif; display: flex; flex-direction: column; gap: 10px;
}
.head { display: flex; gap: 10px; align-items: flex-start; }
.mark {
  width: 28px; height: 28px; flex-shrink: 0; border-radius: 8px; background: #0EA5E9; color: #FFFFFF;
  display: flex; align-items: center; justify-content: center;
}
.title { font-weight: 600; }
.sub { font-size: 12px; color: #94A3B8; word-break: break-all; }
.actions { display: flex; gap: 8px; align-items: center; }
.spacer { flex-grow: 1; }
button {
  height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid #1E293B; background: #131C2E;
  color: #E2E8F0; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
button.primary { border: none; background: #0284C7; color: #FFFFFF; }
button.quiet { padding: 0; border: none; background: transparent; color: #94A3B8; font-weight: 500; }
button.quiet:hover { color: #E2E8F0; }
button:focus-visible { outline: 2px solid #7DD3FC; outline-offset: 2px; }
.error { font-size: 13px; color: #FCA5A5; }
`;

let current: HTMLElement | null = null;

export const hideSaveBar = (): void => {
  current?.remove();
  current = null;
};

export const showSaveBar = (
  doc: Document,
  offer: SaveOffer,
  onAction: (action: SaveAction) => Promise<string | null>,
): void => {
  hideSaveBar();
  const view = doc.defaultView ?? window;
  const host = h$(doc, "div");
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(css);
  shadow.adoptedStyleSheets = [sheet];

  const copy = saveBarCopy(offer);
  const mark = h$(doc, "div", { className: "mark", "aria-hidden": "true" });
  mark.append(icon(doc, icons.quark, 16));
  const bar = h$(
    doc,
    "div",
    { className: "bar", role: "dialog", "aria-label": copy.title },
    h$(doc, "div", { className: "head" }, mark, h$(doc, "div", {}, h$(doc, "div", { className: "title" }, copy.title), h$(doc, "div", { className: "sub" }, copy.sub))),
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
      void onAction("dismiss").then(hideSaveBar);
    }
  });
  shadow.append(bar);
  doc.body.append(host);
  current = host;
};
