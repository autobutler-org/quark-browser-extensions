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
