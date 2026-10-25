import { hideSaveBar, showSaveBar } from "../src/content/savebar";
import type { SaveAction, SaveOffer } from "../src/background/save";

// The bar's shadow root is closed; open it so the test can look inside.
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

const offer: SaveOffer = { kind: "save", host: "example.com", username: "alice" };

const show = (onAction: (action: SaveAction) => Promise<string | null> = () => Promise.resolve(null)) => {
  const roots = openShadows();
  showSaveBar(document, offer, onAction);
  const root = roots.at(-1) as ShadowRoot;
  const bar = root.querySelector<HTMLElement>("[role=dialog]") as HTMLElement;
  return { root, bar };
};

afterEach(() => {
  hideSaveBar();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("showSaveBar", () => {
  // A fixed 340px bar would run off a narrow window or a zoomed page (#31).
  it("fits narrow and zoomed windows instead of overflowing them (#31)", () => {
    const { root } = show();
    const css = [...root.adoptedStyleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n") ||
      (root.querySelector("style")?.textContent ?? "");
    expect(css).toMatch(/max-width: calc\(100vw - 16px\)/);
    expect(css).toMatch(/max-height: calc\(100vh - 16px\)/);
    expect(css).toMatch(/overflow-y: auto/);
  });

  it("is a dialog named and described by its own text", () => {
    const { root, bar } = show();
    const title = root.getElementById(bar.getAttribute("aria-labelledby") ?? "");
    const sub = root.getElementById(bar.getAttribute("aria-describedby") ?? "");
    expect(title?.textContent).toBe("Save this login to Quark Vault?");
    expect(sub?.textContent).toBe("alice on example.com");
    expect([...root.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Never for this site", "Not now", "Save"]);
  });

  it("takes focus so keyboard users land on it, and gives it back when it closes", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const { root, bar } = show();
    expect(root.activeElement).toBe(bar);
    expect(bar.tabIndex).toBe(-1);
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Save")?.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    expect(root.host.isConnected).toBe(false);
  });

  it("does not pull focus back if the user moved on before it closed", () => {
    const field = document.createElement("input");
    const other = document.createElement("input");
    document.body.append(field, other);
    field.focus();
    show();
    other.focus();
    hideSaveBar();
    expect(document.activeElement).toBe(other);
  });

  it("dismisses on Escape without letting the page see the key", async () => {
    const onAction = vi.fn(() => Promise.resolve(null));
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    const { root, bar } = show(onAction);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    bar.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onAction).toHaveBeenCalledWith("dismiss");
    await vi.waitFor(() => expect(root.host.isConnected).toBe(false));
    expect(seen).not.toHaveBeenCalled();
    document.removeEventListener("keydown", seen);
  });

  it("shows a failure as an alert and stays open", async () => {
    const { root } = show(() => Promise.resolve("Vault is locked"));
    root.querySelector<HTMLButtonElement>("button.primary")?.click();
    await vi.waitFor(() => expect(root.querySelector("[role=alert]")?.textContent).toBe("Vault is locked"));
    expect(root.host.isConnected).toBe(true);
  });
});
