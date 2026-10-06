import { h$, icon, icons } from "../shared/dom";
import type { EntrySummary } from "../shared/types";

const css = `
:host { all: initial; }
.anchor { position: absolute; z-index: 2147483646; font-family: "IBM Plex Sans", system-ui, sans-serif; }
.trigger {
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: #0EA5E9; color: #FFFFFF; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.trigger:focus-visible { outline: 2px solid #7DD3FC; outline-offset: 2px; }
.panel {
  position: absolute; top: 30px; right: 0; width: 300px; box-sizing: border-box; padding: 6px;
  background: #0F172A; border: 1px solid #1E293B; border-radius: 12px;
  box-shadow: 0 16px 40px rgba(2, 6, 23, 0.35);
  display: flex; flex-direction: column; gap: 2px;
}
.head { padding: 8px 10px 6px; display: flex; gap: 8px; align-items: center; }
.label { flex-grow: 1; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #94A3B8; }
.host { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; color: #38BDF8; }
.item {
  min-height: 52px; padding: 0 10px; border: none; border-radius: 8px; background: transparent;
  display: flex; align-items: center; gap: 10px; text-align: left; cursor: pointer; font: inherit;
}
.item:hover, .item:focus-visible { background: #1E293B; outline: none; }
.avatar {
  width: 32px; height: 32px; flex-shrink: 0; border-radius: 8px; background: #1E293B; color: #E2E8F0;
  font-weight: 600; font-size: 14px; display: flex; align-items: center; justify-content: center;
}
.item:hover .avatar, .item:focus-visible .avatar { background: #0EA5E9; color: #FFFFFF; }
.name { font-size: 14px; font-weight: 500; color: #E2E8F0; }
.error { padding: 10px; font-size: 13px; line-height: 1.4; color: #FCA5A5; }
`;

export type PickerHandlers = Readonly<{
  onPick: (entry: EntrySummary) => Promise<string | null>;
}>;

export type PickerHandle = Readonly<{
  open: () => void;
  destroy: () => void;
}>;

const initial = (name: string): string => (name.trim()[0] ?? "?").toUpperCase();

export const attachPicker = (
  field: HTMLInputElement,
  matches: readonly EntrySummary[],
  pageHost: string,
  { onPick }: PickerHandlers,
): PickerHandle => {
  const doc = field.ownerDocument;
  const view = doc.defaultView ?? window;
  const host = h$(doc, "div");
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(css);
  shadow.adoptedStyleSheets = [sheet];

  const anchor = h$(doc, "div", { className: "anchor" });
  const trigger = h$(doc, "button", {
    className: "trigger",
    type: "button",
    "aria-label": "Fill from Quark Vault",
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
    title: "Fill from Quark Vault",
  });
  trigger.append(icon(doc, icons.quark, 12));
  anchor.append(trigger);
  shadow.append(anchor);

  const place = (): void => {
    const rect = field.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && field.isConnected;
    anchor.style.display = visible ? "block" : "none";
    anchor.style.top = `${rect.top + view.scrollY + (rect.height - 22) / 2}px`;
    anchor.style.left = `${rect.right + view.scrollX - 22 - 6}px`;
  };

  const closePanel = (): void => {
    shadow.querySelector(".panel")?.remove();
    trigger.setAttribute("aria-expanded", "false");
  };

  const showError = (panel: HTMLElement, message: string): void => {
    panel.querySelector(".error")?.remove();
    panel.append(h$(doc, "div", { className: "error", role: "alert" }, message));
  };

  const item = (panel: HTMLElement, entry: EntrySummary): HTMLButtonElement =>
    h$(
      doc,
      "button",
      {
        className: "item",
        type: "button",
        role: "option",
        onclick: (() => {
          void onPick(entry).then((failure) => (failure === null ? closePanel() : showError(panel, failure)));
        }) as EventListener,
      },
      h$(doc, "div", { className: "avatar", "aria-hidden": "true" }, initial(entry.name)),
      h$(doc, "div", { className: "name" }, entry.name),
    );

  const openPanel = (): void => {
    const panel = h$(
      doc,
      "div",
      { className: "panel", role: "listbox", "aria-label": "Logins for this site" },
      h$(doc, "div", { className: "head" }, h$(doc, "div", { className: "label" }, "Quark Vault"), h$(doc, "div", { className: "host" }, pageHost)),
    );
    matches.forEach((entry) => panel.append(item(panel, entry)));
    anchor.append(panel);
    trigger.setAttribute("aria-expanded", "true");
    panel.querySelector<HTMLButtonElement>(".item")?.focus();
  };

  const toggle = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (shadow.querySelector(".panel") === null) {
      openPanel();
    } else {
      closePanel();
    }
  };

  const onOutside = (event: Event): void => {
    if (!event.composedPath().includes(host)) {
      closePanel();
    }
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      closePanel();
      field.focus();
    }
  };

  let frame = 0;
  const schedule = (): void => {
    view.cancelAnimationFrame(frame);
    frame = view.requestAnimationFrame(place);
  };

  trigger.addEventListener("click", toggle);
  anchor.addEventListener("keydown", onKey);
  doc.addEventListener("mousedown", onOutside, true);
  view.addEventListener("scroll", schedule, true);
  view.addEventListener("resize", schedule);
  doc.body.append(host);
  place();

  return {
    open: () => {
      if (shadow.querySelector(".panel") === null) {
        place();
        openPanel();
      }
    },
    destroy: () => {
      view.cancelAnimationFrame(frame);
      doc.removeEventListener("mousedown", onOutside, true);
      view.removeEventListener("scroll", schedule, true);
      view.removeEventListener("resize", schedule);
      host.remove();
    },
  };
};
