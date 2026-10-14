import { h$, icon, icons } from "../shared/dom";
import { t } from "../shared/i18n";
import { adoptStyles } from "./styles";
import { iconInset, iconRight, iconSize, placePanel, type Box } from "./position";
import { trusted } from "./trusted";
import { isFallback, type SiteMatch } from "../shared/host";
import type { EntrySummary } from "../shared/types";

const css = `
:host { all: initial; }
.anchor { position: absolute; font-family: "IBM Plex Sans", system-ui, sans-serif; }
.trigger {
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: var(--primary); color: var(--primary-fg); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.trigger:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.panel {
  position: absolute; top: 30px; right: 0; width: 300px; max-width: calc(100vw - 16px);
  max-height: calc(100vh - 48px); overflow-y: auto; overscroll-behavior: contain; box-sizing: border-box; padding: 6px;
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

// Every field's button is its own host at the same level, so a later one in the DOM paints over an earlier one's
// panel. The open picker steps up to the top level, above every inline button, and back down when it closes.
const buttonLayer = "2147483646";
const openLayer = "2147483647";

// The width the panel asks for; position.ts narrows it to fit a small frame.
const panelWidth = 300;

// The page's own controls next to a field, such as a show-password toggle: the field's siblings and its parent's,
// where such a control is drawn over the field's right end. Only ones that are laid out count.
const controlSelector = "button, a[href], input:not([type=hidden]), select, [role=button], [tabindex], svg, img";

const trailingControls = (field: HTMLInputElement): Box[] => {
  const scopes = [field.parentElement, field.parentElement?.parentElement].filter((scope) => scope != null);
  const found = new Set(scopes.flatMap((scope) => [...scope.querySelectorAll(controlSelector)]));
  return [...found]
    .filter((control) => control !== field && !control.contains(field))
    .map((control) => control.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0);
};

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
  anchor.style.zIndex = buttonLayer;
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

  const shown = (): boolean => anchor.style.display !== "none";

  const place = (): void => {
    const rect = field.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && field.isConnected;
    anchor.style.display = visible ? "block" : "none";
    anchor.style.top = `${rect.top + view.scrollY + (rect.height - iconSize) / 2}px`;
    anchor.style.left = `${(visible ? iconRight(rect, trailingControls(field)) : rect.right - iconInset) + view.scrollX - iconSize}px`;
  };

  // Keeps the whole panel inside this frame's viewport: below the trigger, flipped above it, or over it in a
  // frame too small for either, scrolling inside when it still doesn't fit. The CSS top/right stay as a fallback.
  const fit = (panel: HTMLElement): void => {
    const root = doc.documentElement;
    const viewport = { width: root.clientWidth || view.innerWidth, height: root.clientHeight || view.innerHeight };
    const border = panel.offsetHeight - panel.clientHeight;
    const spot = placePanel(trigger.getBoundingClientRect(), viewport, { width: panelWidth, height: panel.scrollHeight + border });
    const origin = anchor.getBoundingClientRect();
    panel.dataset.side = spot.side;
    Object.assign(panel.style, {
      top: `${spot.top - origin.top}px`,
      left: `${spot.left - origin.left}px`,
      right: "auto",
      width: `${spot.width}px`,
      maxWidth: "none",
      maxHeight: `${spot.maxHeight}px`,
    });
  };

  const items = (): HTMLButtonElement[] => [...shadow.querySelectorAll<HTMLButtonElement>(".item")];

  const focusItem = (index: number): void => {
    items().forEach((button, i) => (button.tabIndex = i === index ? 0 : -1));
    items()[index]?.focus();
  };

  const closePanel = (): void => {
    shadow.querySelector(".panel")?.remove();
    trigger.setAttribute("aria-expanded", "false");
    anchor.style.zIndex = buttonLayer;
  };

  // Above the logins, not after them, where a panel that scrolls would hide it and the pick seem to do nothing
  // (#118). The panel is fitted again for the extra line and scrolled back to show it.
  const showError = (panel: HTMLElement, message: string): void => {
    panel.querySelector(".error")?.remove();
    panel.querySelector(".menu")?.before(h$(doc, "div", { className: "error", role: "alert" }, message));
    fit(panel);
    panel.scrollTop = 0;
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
        onclick: (() =>
          isFallback(entry)
            ? showError(panel, t("pickerFallbackInPopup", entry.name, entry.where, pageHost))
            : run(panel, () => onPick(entry), t("pickerFilled", entry.name))) as EventListener,
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
    const leading = menu.childElementCount;
    if (fallbacks.length > 0) {
      const label = t("pickerFallbacks");
      const group = h$(doc, "div", { className: "group", role: "group", "aria-label": label }, h$(doc, "div", { className: "subhead", "aria-hidden": "true" }, label));
      fallbacks.forEach((entry) => group.append(item(panel, entry)));
      menu.append(group);
    }
    anchor.append(panel);
    anchor.style.zIndex = openLayer;
    fit(panel);
    trigger.setAttribute("aria-expanded", "true");
    const count = items().length;
    if (count === 0) {
      announce(t("pickerNoLogins"));
    }
    if (focusLast || leading > 0) {
      focusItem(focusLast ? count - 1 : 0);
    } else {
      focusItem(-1);
      trigger.focus();
    }
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
    if (event.key === "Tab" && event.target === trigger && !open) {
      // The button sits right after its field in the Tab order (#116). Shift+Tab goes back to the field; Tab goes
      // to the field too, and the browser's own Tab then moves on from there.
      if (event.shiftKey) {
        event.preventDefault();
      }
      field.focus();
      return;
    }
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

  // The button is drawn at the end of <body>, far from the field in the page's Tab order, so the field hands Tab
  // to it, and Alt+ArrowDown opens the menu as it does native autocomplete (#116). Only the user's own keys: a
  // page must not open the menu and move focus into it. Heard last, at the window, so a page that handles the key
  // itself keeps it. composedPath finds a field inside a shadow root.
  const onFieldKey = (event: KeyboardEvent): void => {
    if (event.composedPath()[0] !== field || !trusted(event) || event.defaultPrevented || event.ctrlKey || event.metaKey || !shown()) {
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      trigger.focus();
    } else if (event.key === "ArrowDown" && event.altKey && !event.shiftKey) {
      event.preventDefault();
      if (shadow.querySelector(".panel") === null) {
        openPanel();
      }
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
  view.addEventListener("keydown", onFieldKey);
  field.addEventListener("focus", place);
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
      view.removeEventListener("keydown", onFieldKey);
      field.removeEventListener("focus", place);
      doc.removeEventListener("mousedown", onOutside, true);
      view.removeEventListener("scroll", schedule, true);
      view.removeEventListener("resize", schedule);
      host.remove();
    },
  };
};
