import { h$, icon, icons } from "../shared/dom";
import { t } from "../shared/i18n";
import { adoptStyles } from "./styles";
import { isFallback, type SiteMatch } from "../shared/host";
import type { EntrySummary } from "../shared/types";

const css = `
:host { all: initial; }
.anchor { position: absolute; z-index: 2147483646; font-family: "IBM Plex Sans", system-ui, sans-serif; }
.trigger {
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: var(--primary); color: var(--primary-fg); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.trigger:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.panel {
  position: absolute; top: 30px; right: 0; width: 300px; max-width: calc(100vw - 16px);
  max-height: calc(100vh - 48px); overflow-y: auto; box-sizing: border-box; padding: 6px;
  background: var(--card); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 16px 40px rgba(2, 6, 23, 0.35);
  display: flex; flex-direction: column; gap: 2px;
}
.menu, .group { display: flex; flex-direction: column; gap: 2px; }
.head { padding: 8px 10px 6px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.label { flex-grow: 1; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.host { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; color: var(--accent); overflow-wrap: anywhere; }
.item {
  min-height: 52px; padding: 6px 10px; border: none; border-radius: 8px; background: transparent; color: var(--fg);
  display: flex; align-items: center; gap: 10px; text-align: left; cursor: pointer; font: inherit;
}
.item:hover, .item:focus { background: var(--hover); }
.item:focus { outline: none; }
.item:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.avatar {
  width: 32px; height: 32px; flex-shrink: 0; border-radius: 8px; background: var(--hover); color: var(--fg);
  font-weight: 600; font-size: 14px; display: flex; align-items: center; justify-content: center;
}
.item:hover .avatar, .item:focus .avatar { background: var(--primary); color: var(--primary-fg); }
.text { min-width: 0; }
.name { font-size: 14px; font-weight: 500; color: var(--fg); overflow-wrap: anywhere; }
.hint { font-size: 12px; color: var(--muted); }
.where { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.note { color: var(--warn); }
.subhead { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--warn); }
.error { padding: 10px; font-size: 13px; line-height: 1.4; color: var(--error-fg); }
.sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
`;

export type PickerHandlers = Readonly<{
  onPick: (entry: EntrySummary) => Promise<string | null>;
  onSuggest?: () => Promise<string | null>;
}>;

export type PickerHandle = Readonly<{
  open: () => void;
  destroy: () => void;
}>;

const initial = (name: string): string => (name.trim()[0] ?? "?").toUpperCase();

// Where focus goes in a menu of `count` items for a navigation key, or null if the key isn't one.
export const menuTarget = (key: string, current: number, count: number): number | null => {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return current <= 0 ? count - 1 : current - 1;
    case "Home":
    case "PageUp":
      return 0;
    case "End":
    case "PageDown":
      return count - 1;
    default:
      return null;
  }
};

// Keeps the panel inside the viewport when the field sits near the left edge of a narrow window.
const gutter = 8;

export const attachPicker = (
  field: HTMLInputElement,
  matches: readonly SiteMatch[],
  pageHost: string,
  { onPick, onSuggest }: PickerHandlers,
): PickerHandle => {
  const doc = field.ownerDocument;
  const view = doc.defaultView ?? window;
  const host = h$(doc, "div");
  const shadow = host.attachShadow({ mode: "closed" });
  adoptStyles(shadow, css);

  const anchor = h$(doc, "div", { className: "anchor" });
  const trigger = h$(doc, "button", {
    className: "trigger",
    type: "button",
    "aria-label": t("pickerTrigger"),
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    title: t("pickerTrigger"),
  });
  trigger.append(icon(doc, icons.quark, 12));
  const status = h$(doc, "div", { className: "sr", role: "status", "aria-live": "polite" });
  anchor.append(trigger, status);
  shadow.append(anchor);

  const announce = (message: string): void => {
    status.textContent = message;
  };

  const place = (): void => {
    const rect = field.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && field.isConnected;
    anchor.style.display = visible ? "block" : "none";
    anchor.style.top = `${rect.top + view.scrollY + (rect.height - 22) / 2}px`;
    anchor.style.left = `${rect.right + view.scrollX - 22 - 6}px`;
  };

  const fit = (panel: HTMLElement): void => {
    panel.style.right = "0px";
    const left = panel.getBoundingClientRect().left;
    if (left < gutter) {
      panel.style.right = `${left - gutter}px`;
    }
  };

  const items = (): HTMLButtonElement[] => [...shadow.querySelectorAll<HTMLButtonElement>(".item")];

  const focusItem = (index: number): void => {
    items().forEach((button, i) => (button.tabIndex = i === index ? 0 : -1));
    items()[index]?.focus();
  };

  const closePanel = (): void => {
    shadow.querySelector(".panel")?.remove();
    trigger.setAttribute("aria-expanded", "false");
  };

  const showError = (panel: HTMLElement, message: string): void => {
    panel.querySelector(".error")?.remove();
    panel.append(h$(doc, "div", { className: "error", role: "alert" }, message));
  };

  const run = (panel: HTMLElement, action: () => Promise<string | null>, done: string): void => {
    void action().then((failure) => {
      if (failure !== null) {
        showError(panel, failure);
        return;
      }
      closePanel();
      field.focus();
      announce(done);
    });
  };

  const whereText = (entry: SiteMatch): string => (entry.note === "" ? entry.where : `${entry.where} · ${entry.note}`);

  const where = (entry: SiteMatch): HTMLElement =>
    h$(
      doc,
      "div",
      { className: "where" },
      entry.where,
      entry.note === "" ? null : h$(doc, "span", { className: "note" }, ` · ${entry.note}`),
    );

  const item = (panel: HTMLElement, entry: SiteMatch): HTMLButtonElement =>
    h$(
      doc,
      "button",
      {
        className: "item",
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        "aria-label": t("pickerFillItem", entry.name, whereText(entry)),
        onclick: (() => run(panel, () => onPick(entry), t("pickerFilled", entry.name))) as EventListener,
      },
      h$(doc, "div", { className: "avatar", "aria-hidden": "true" }, initial(entry.name)),
      h$(doc, "div", { className: "text" }, h$(doc, "div", { className: "name" }, entry.name), where(entry)),
    );

  const suggestItem = (panel: HTMLElement, suggest: () => Promise<string | null>): HTMLButtonElement => {
    const avatar = h$(doc, "div", { className: "avatar", "aria-hidden": "true" });
    avatar.append(icon(doc, icons.key, 16));
    return h$(
      doc,
      "button",
      {
        className: "item",
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        onclick: (() => run(panel, suggest, t("pickerFilledStrong"))) as EventListener,
      },
      avatar,
      h$(doc, "div", { className: "text" }, h$(doc, "div", { className: "name" }, t("pickerSuggest")), h$(doc, "div", { className: "hint" }, t("pickerSuggestHint"))),
    );
  };

  const openPanel = (focusLast = false): void => {
    const menu = h$(doc, "div", { className: "menu", role: "menu", "aria-label": t("pickerMenuLabel", pageHost) });
    const panel = h$(
      doc,
      "div",
      { className: "panel" },
      h$(doc, "div", { className: "head", "aria-hidden": "true" }, h$(doc, "div", { className: "label" }, t("extName")), h$(doc, "div", { className: "host" }, pageHost)),
      menu,
    );
    if (onSuggest !== undefined) {
      menu.append(suggestItem(panel, onSuggest));
    }
    const fallbacks = matches.filter(isFallback);
    matches.filter((entry) => !isFallback(entry)).forEach((entry) => menu.append(item(panel, entry)));
    if (fallbacks.length > 0) {
      const label = t("pickerFallbacks");
      const group = h$(doc, "div", { className: "group", role: "group", "aria-label": label }, h$(doc, "div", { className: "subhead", "aria-hidden": "true" }, label));
      fallbacks.forEach((entry) => group.append(item(panel, entry)));
      menu.append(group);
    }
    anchor.append(panel);
    fit(panel);
    trigger.setAttribute("aria-expanded", "true");
    const count = items().length;
    if (count === 0) {
      announce(t("pickerNoLogins"));
    }
    focusItem(focusLast ? count - 1 : 0);
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
    const open = shadow.querySelector(".panel") !== null;
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
      }
      closePanel();
      field.focus();
      return;
    }
    if (!open) {
      if (event.target === trigger && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        openPanel(event.key === "ArrowUp");
      }
      return;
    }
    if (event.key === "Tab" && event.target !== trigger) {
      // Leave the menu the way it opened: back to the field, then on with the browser's own Tab.
      closePanel();
      field.focus();
      return;
    }
    const list = items();
    const target = menuTarget(event.key, list.indexOf(shadow.activeElement as HTMLButtonElement), list.length);
    if (target !== null) {
      event.preventDefault();
      event.stopPropagation();
      focusItem(target);
    }
  };

  let frame = 0;
  const schedule = (): void => {
    view.cancelAnimationFrame(frame);
    frame = view.requestAnimationFrame(() => {
      place();
      const panel = shadow.querySelector<HTMLElement>(".panel");
      if (panel !== null) {
        fit(panel);
      }
    });
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
