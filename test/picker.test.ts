import { attachPicker, menuTarget } from "../src/content/picker";
import type { MatchKind, SiteMatch } from "../src/shared/host";

const match = (id: number, name: string, kind: MatchKind, where: string, note = ""): SiteMatch => ({
  id,
  name,
  urlHost: "localhost",
  folderId: null,
  createdAt: "",
  updatedAt: "",
  kind,
  where,
  note,
});

// The picker's shadow root is closed; open it so the test can look inside.
const openShadows = (): ShadowRoot[] => {
  const roots: ShadowRoot[] = [];
  // Kept unbound on purpose: the mock calls it with each element as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = original.call(this, { ...init, mode: "open" });
    roots.push(root);
    return root;
  });
  return roots;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("attachPicker", () => {
  it("lists this origin's logins first and fallbacks under their own label, with where each was saved", () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(
      field,
      [
        match(1, "NAS", "exact", "localhost:8087/login"),
        match(2, "Router", "otherPort", "localhost:8099/basic.html", "Different port"),
        match(3, "Quark", "otherScheme", "https://localhost:8087", "Saved for https"),
      ],
      "localhost:8087",
      { onPick: () => Promise.resolve(null) },
    );
    picker.open();
    const panel = roots[0]?.querySelector(".panel");
    expect(panel?.querySelector(".host")?.textContent).toBe("localhost:8087");
    const menu = panel?.querySelector("[role=menu]");
    const children = [...(menu?.children ?? [])].map((child) => child.textContent);
    expect(children).toEqual([
      "NNASlocalhost:8087/login",
      "Saved for another port or scheme" + "RRouterlocalhost:8099/basic.html · Different port" + "QQuarkhttps://localhost:8087 · Saved for https",
    ]);
    const group = menu?.querySelector("[role=group]");
    expect(group?.getAttribute("aria-label")).toBe("Saved for another port or scheme");
    expect([...(group?.querySelectorAll("[role=menuitem]") ?? [])].map((item) => item.getAttribute("aria-label"))).toEqual([
      "Fill Router, localhost:8099/basic.html · Different port",
      "Fill Quark, https://localhost:8087 · Saved for https",
    ]);
    picker.destroy();
  });

  it("shows no fallback label when every match is for this origin", () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(field, [match(1, "NAS", "exact", "localhost:8087")], "localhost:8087", { onPick: () => Promise.resolve(null) });
    picker.open();
    expect(roots[0]?.querySelector(".subhead")).toBeNull();
    picker.destroy();
  });

  const setup = (handlers: Parameters<typeof attachPicker>[3] = { onPick: () => Promise.resolve(null) }) => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(
      field,
      [match(1, "NAS", "exact", "a"), match(2, "Router", "exact", "b"), match(3, "Quark", "otherPort", "c")],
      "localhost:8087",
      handlers,
    );
    const root = roots[0] as ShadowRoot;
    const trigger = root.querySelector<HTMLButtonElement>(".trigger") as HTMLButtonElement;
    const items = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const press = (key: string, target: Element = root.activeElement ?? trigger): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const focused = (): string | null => root.activeElement?.querySelector(".name")?.textContent ?? null;
    return { field, picker, root, trigger, items, press, focused };
  };

  it("is a menu button whose items are menuitems with a single tab stop", () => {
    const { picker, root, trigger, items } = setup();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    picker.open();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector("[role=menu]")?.getAttribute("aria-label")).toBe("Logins for localhost:8087");
    expect(items().map((item) => item.tabIndex)).toEqual([0, -1, -1]);
    expect(root.activeElement).toBe(items()[0]);
    picker.destroy();
  });

  it("moves focus with the arrow keys, Home and End, wrapping at the ends", () => {
    const { picker, press, focused, items } = setup();
    picker.open();
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(focused()).toBe("Router");
    press("ArrowDown");
    expect(focused()).toBe("Quark");
    press("ArrowDown");
    expect(focused()).toBe("NAS");
    press("ArrowUp");
    expect(focused()).toBe("Quark");
    press("Home");
    expect(focused()).toBe("NAS");
    press("End");
    expect(focused()).toBe("Quark");
    expect(items().map((item) => item.tabIndex)).toEqual([-1, -1, 0]);
    expect(press("a").defaultPrevented).toBe(false);
    picker.destroy();
  });

  it("opens from the trigger with ArrowDown on the first item and ArrowUp on the last", () => {
    const { picker, root, trigger, press, focused } = setup();
    press("ArrowDown", trigger);
    expect(focused()).toBe("NAS");
    press("Escape");
    expect(root.querySelector(".panel")).toBeNull();
    press("ArrowUp", trigger);
    expect(focused()).toBe("Quark");
    picker.destroy();
  });

  it("closes on Escape and returns focus to the field without letting the page see the key", () => {
    const { field, picker, root, trigger, press } = setup();
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    picker.open();
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(root.querySelector(".panel")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(field);
    expect(seen).not.toHaveBeenCalled();
    document.removeEventListener("keydown", seen);
    picker.destroy();
  });

  it("closes on Tab and hands focus back to the field", () => {
    const { field, picker, root, press } = setup();
    picker.open();
    press("Tab");
    expect(root.querySelector(".panel")).toBeNull();
    expect(document.activeElement).toBe(field);
    picker.destroy();
  });

  it("announces a fill in a live region and returns focus to the field", async () => {
    const onPick = vi.fn(() => Promise.resolve(null));
    const { field, picker, root, items } = setup({ onPick });
    picker.open();
    items()[1]?.click();
    await vi.waitFor(() => expect(root.querySelector("[role=status]")?.textContent).toBe("Filled Router"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(root.querySelector("[role=status]")?.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelector(".panel")).toBeNull();
    expect(document.activeElement).toBe(field);
    picker.destroy();
  });

  it("keeps the menu open and shows a failure as an alert", async () => {
    const { picker, root, items } = setup({ onPick: () => Promise.resolve("Vault is locked") });
    picker.open();
    items()[0]?.click();
    await vi.waitFor(() => expect(root.querySelector("[role=alert]")?.textContent).toBe("Vault is locked"));
    expect(root.querySelector(".panel")).not.toBeNull();
    picker.destroy();
  });

  it("never puts focus on a fallback when nothing matches this origin", () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(field, [match(2, "Router", "otherPort", "localhost:9502", "Different port")], "localhost:9503", {
      onPick: () => Promise.resolve(null),
    });
    picker.open();
    const root = roots[0]!;
    const item = root.querySelector<HTMLButtonElement>(".item");
    expect(item).not.toBeNull();
    expect(root.activeElement).not.toBe(item);
    expect(root.activeElement).toBe(root.querySelector(".trigger"));
    picker.destroy();
  });

  it("sends a picked fallback to the popup's confirmation instead of filling it", () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const onPick = vi.fn(() => Promise.resolve(null));
    const picker = attachPicker(field, [match(2, "Router", "otherPort", "localhost:9502", "Different port")], "localhost:9503", { onPick });
    picker.open();
    const root = roots[0]!;
    root.querySelector<HTMLButtonElement>(".item")?.click();
    expect(onPick).not.toHaveBeenCalled();
    expect(root.querySelector("[role=alert]")?.textContent).toBe(
      "Router is saved for localhost:9502, not localhost:9503. To fill it here, open Quark Vault from the toolbar and choose Fill on localhost:9503.",
    );
    expect(root.querySelector(".panel")).not.toBeNull();
    picker.destroy();
  });

  it("announces when there is nothing to fill", () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(field, [], "localhost", { onPick: () => Promise.resolve(null) });
    picker.open();
    expect(roots[0]?.querySelector("[role=status]")?.textContent).toBe("No logins saved for this site");
    picker.destroy();
  });

  it("labels the suggest item and announces the generated password", async () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(field, [], "localhost", { onPick: () => Promise.resolve(null), onSuggest: () => Promise.resolve(null) });
    picker.open();
    const suggest = roots[0]?.querySelector<HTMLButtonElement>("[role=menuitem]");
    expect(suggest?.textContent).toContain("Suggest strong password");
    suggest?.click();
    await vi.waitFor(() => expect(roots[0]?.querySelector("[role=status]")?.textContent).toBe("Filled a strong password"));
    picker.destroy();
  });

  // A frame of the given size, with the trigger at `top` in it and the panel's content `content` px tall.
  const frame = (width: number, height: number, top: number, content: number): void => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(height);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.className === "panel" ? content : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The anchor wraps the trigger, 10px in from the frame's right edge.
      return this.className === "trigger" || this.className === "anchor"
        ? DOMRect.fromRect({ x: width - 10 - 22, y: top, width: 22, height: 22 })
        : DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 20 });
    });
  };

  it("flips the panel above the field when the frame has no room below", () => {
    frame(400, 300, 250, 160);
    const { picker, root, items } = setup();
    picker.open();
    const panel = root.querySelector<HTMLElement>(".panel") as HTMLElement;
    expect(panel.dataset.side).toBe("above");
    // Relative to the anchor at the trigger: its bottom edge sits 6px above the trigger.
    expect(panel.style.top).toBe(`${-6 - 160}px`);
    expect(panel.style.width).toBe("300px");
    expect(panel.style.left).toBe(`${-(300 - 22)}px`);
    // Opening still focuses the first item with a single tab stop (#26).
    expect(root.activeElement).toBe(items()[0]);
    picker.destroy();
  });

  it("fits a frame too small for either side and scrolls inside it", () => {
    frame(220, 140, 60, 400);
    const { picker, root } = setup();
    picker.open();
    const panel = root.querySelector<HTMLElement>(".panel") as HTMLElement;
    expect(panel.dataset.side).toBe("over");
    expect(panel.style.maxHeight).toBe("124px");
    expect(panel.style.width).toBe("204px");
    // The anchor's left edge is 220 - 10 - 22 = 188 in the frame; the panel starts at the 8px gutter.
    expect(panel.style.left).toBe(`${8 - 188}px`);
    expect(panel.style.top).toBe(`${8 - 60}px`);
    picker.destroy();
  });

  // A refused fill in a cross-site frame was appended below the rows of a panel that scrolls, so nothing seemed to
  // happen (#118). The reason goes above the rows, and the panel scrolls back to show it.
  it("shows a refusal above the logins, scrolled into view", async () => {
    const reason = "This login form is embedded in 127.0.0.1, so Quark Vault won't fill it.";
    const { picker, root, items } = setup({ onPick: () => Promise.resolve(reason) });
    picker.open();
    const panel = root.querySelector<HTMLElement>(".panel") as HTMLElement;
    panel.scrollTop = 120;
    items()[2]?.click();
    await vi.waitFor(() => expect(root.querySelector("[role=alert]")?.textContent).toBe(reason));
    const alert = root.querySelector("[role=alert]");
    expect(alert?.nextElementSibling?.getAttribute("role")).toBe("menu");
    expect(panel.scrollTop).toBe(0);
    expect(root.querySelector(".panel")).toBe(panel);
    picker.destroy();
  });

  // Quark's own login page draws a show-password toggle over the right end of the field (#119).
  it("moves the button left of a control drawn over the field's right end", () => {
    const roots = openShadows();
    const wrap = document.createElement("div");
    const field = document.createElement("input");
    field.type = "password";
    const eye = document.createElement("button");
    eye.type = "button";
    wrap.append(field, eye);
    document.body.append(wrap);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === field) {
        return DOMRect.fromRect({ x: 100, y: 50, width: 300, height: 32 });
      }
      if (this === eye) {
        return DOMRect.fromRect({ x: 368, y: 54, width: 24, height: 24 });
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    const picker = attachPicker(field, [], "localhost", { onPick: () => Promise.resolve(null) });
    const anchor = roots[0]?.querySelector<HTMLElement>(".anchor");
    expect(anchor?.style.left).toBe(`${368 - 6 - 22}px`);
    picker.destroy();
  });

  it("keeps the button at the field's right end when no control is there", () => {
    const roots = openShadows();
    const wrap = document.createElement("div");
    const field = document.createElement("input");
    const after = document.createElement("button");
    wrap.append(field, after);
    document.body.append(wrap);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === field) {
        return DOMRect.fromRect({ x: 100, y: 50, width: 300, height: 32 });
      }
      return this === after ? DOMRect.fromRect({ x: 410, y: 50, width: 80, height: 32 }) : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    const picker = attachPicker(field, [], "localhost", { onPick: () => Promise.resolve(null) });
    expect(roots[0]?.querySelector<HTMLElement>(".anchor")?.style.left).toBe(`${400 - 6 - 22}px`);
    picker.destroy();
  });

  it("places the panel again when the frame resizes", () => {
    frame(400, 600, 250, 160);
    const { picker, root } = setup();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    picker.open();
    const panel = root.querySelector<HTMLElement>(".panel") as HTMLElement;
    expect(panel.dataset.side).toBe("below");
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(300);
    window.dispatchEvent(new Event("resize"));
    expect(panel.dataset.side).toBe("above");
    picker.destroy();
  });

  it("styles itself from the shared theme tokens, not hard-coded colours", () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(field, [], "localhost", { onPick: () => Promise.resolve(null) });
    const css = [...(roots[0]?.adoptedStyleSheets ?? [])].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n") ||
      (roots[0]?.querySelector("style")?.textContent ?? "");
    expect(css).toContain("prefers-color-scheme: light");
    expect(css).toMatch(/max-width: calc\(100vw - 16px\)/);
    picker.destroy();
  });
});

describe("menuTarget", () => {
  it("maps the navigation keys and ignores the rest", () => {
    expect(menuTarget("ArrowDown", 0, 3)).toBe(1);
    expect(menuTarget("ArrowDown", 2, 3)).toBe(0);
    expect(menuTarget("ArrowDown", -1, 3)).toBe(0);
    expect(menuTarget("ArrowUp", 0, 3)).toBe(2);
    expect(menuTarget("ArrowUp", -1, 3)).toBe(2);
    expect(menuTarget("ArrowUp", 2, 3)).toBe(1);
    expect(menuTarget("Home", 2, 3)).toBe(0);
    expect(menuTarget("PageUp", 2, 3)).toBe(0);
    expect(menuTarget("End", 0, 3)).toBe(2);
    expect(menuTarget("PageDown", 0, 3)).toBe(2);
    expect(menuTarget("Enter", 0, 3)).toBeNull();
    expect(menuTarget("ArrowDown", -1, 0)).toBeNull();
  });
});
