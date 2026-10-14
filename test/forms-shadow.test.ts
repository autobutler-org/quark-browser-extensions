import { fillLogin, isLoginField, passwordFields } from "../src/content/forms";

// A light-DOM field slotted into a shadow tree is drawn where the slot is, so the slot's ancestors clip and fade it
// (#139). Closed roots are read through the extension-only APIs; where neither exists, see "the closed-shadow policy".

const credentials = { username: "alice", password: "hunter2!" };

type Box = Readonly<{ left: number; top: number; width: number; height: number }>;

const boxes = new Map<string, Box>();
const page: Box = { left: 0, top: 0, width: 1024, height: 768 };
const field: Box = { left: 20, top: 100, width: 240, height: 32 };

// Closed roots by host, for the stubbed chrome.dom.openOrClosedShadowRoot.
const closedRoots = new WeakMap<Element, ShadowRoot>();

beforeEach(() => {
  boxes.clear();
  Object.defineProperty(Element.prototype, "checkVisibility", { value: () => true, configurable: true, writable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxes.get(this.id) ?? (this.localName === "input" ? field : page);
    return DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
  });
  vi.stubGlobal("chrome", { ...chrome, dom: { openOrClosedShadowRoot: (host: HTMLElement) => host.shadowRoot ?? closedRoots.get(host) ?? null } });
});

afterEach(() => {
  delete (Element.prototype as Partial<Element>).checkVisibility;
  delete (Element.prototype as Partial<{ openOrClosedShadowRoot: unknown }>).openOrClosedShadowRoot;
  delete (Document.prototype as Partial<Document>).elementFromPoint;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// A host holding the light-DOM `fields`, with a shadow tree of `shadow`, which should contain a <slot>.
const mount = (shadow: string, mode: ShadowRootMode, fields = '<input id="pw" type="password">', before = ""): Document => {
  document.body.innerHTML = `${before}<login-box id="host">${fields}</login-box><form id="real"><input id="user" autocomplete="username"><input id="real-pw" type="password"></form>`;
  const host = document.getElementById("host") as HTMLElement;
  const root = host.attachShadow({ mode });
  root.innerHTML = shadow;
  if (mode === "closed") {
    closedRoots.set(host, root);
  }
  return document;
};

const pw = (): HTMLInputElement => document.getElementById("pw") as HTMLInputElement;

const clippers = [
  ["a 0×0 overflow: hidden wrapper", '<div id="wrap" style="overflow-x: hidden; overflow-y: hidden; width: 0; height: 0"><slot></slot></div>', { left: 20, top: 100, width: 0, height: 0 }],
  ["a clip-path: polygon(0 0, 0 0, 0 0) wrapper", '<div style="clip-path: polygon(0px 0px, 0px 0px, 0px 0px)"><slot></slot></div>', null],
  ["an opacity: 0 wrapper", '<div style="opacity: 0"><slot></slot></div>', null],
  ["a filter: opacity(0) wrapper", '<div style="filter: opacity(0)"><slot></slot></div>', null],
  ["a visibility: hidden wrapper", '<div style="visibility: hidden"><slot></slot></div>', null],
  ["a named slot in an opacity: 0 wrapper", '<slot></slot><div style="opacity: 0"><slot name="secret"></slot></div>', null],
] as const;

describe.each(["open", "closed"] as const)("a field slotted into a %s shadow tree", (mode) => {
  it.each(clippers)("isn't a login field under %s", (name, shadow, box) => {
    if (box !== null) {
      boxes.set("wrap", box);
    }
    mount(shadow, mode, name.includes("named") ? '<input id="pw" type="password" slot="secret">' : undefined);
    expect(isLoginField(pw())).toBe(false);
    expect(passwordFields(document).map((found) => found.id)).toEqual(["real-pw"]);
  });

  it("is a login field when the slot is drawn normally", () => {
    mount('<div style="padding: 8px; border: 1px solid"><slot></slot></div>', mode);
    expect(isLoginField(pw())).toBe(true);
  });

  it("lets the popup's Fill pass a clipped slotted pair for the real form", () => {
    boxes.set("wrap", { left: 20, top: 100, width: 0, height: 0 });
    const doc = mount('<div id="wrap" style="overflow-x: hidden; overflow-y: hidden; width: 0; height: 0"><slot></slot></div>', mode, '<input id="bait" autocomplete="username"><input id="pw" type="password">');
    expect(fillLogin(doc, credentials).filled).toBe(true);
    const values = [...doc.querySelectorAll("input")].map((input) => [input.id, input.value]);
    expect(Object.fromEntries(values)).toEqual({ bait: "", pw: "", user: "alice", "real-pw": "hunter2!" });
  });
});

it("reads a closed root through Firefox's Element.openOrClosedShadowRoot", () => {
  vi.stubGlobal("chrome", { ...chrome, dom: undefined });
  Object.defineProperty(Element.prototype, "openOrClosedShadowRoot", {
    value(this: Element) {
      return this.shadowRoot ?? closedRoots.get(this) ?? null;
    },
    configurable: true,
  });
  mount('<div style="opacity: 0"><slot></slot></div>', "closed");
  expect(isLoginField(pw())).toBe(false);
});

it("walks nested slots out to the outermost host", () => {
  document.body.innerHTML = '<outer-box id="outer"><inner-box id="inner"><input id="pw" type="password"></inner-box></outer-box>';
  const inner = (document.getElementById("inner") as HTMLElement).attachShadow({ mode: "open" });
  inner.innerHTML = "<span><slot></slot></span>";
  const outer = (document.getElementById("outer") as HTMLElement).attachShadow({ mode: "closed" });
  closedRoots.set(document.getElementById("outer") as HTMLElement, outer);
  outer.innerHTML = '<div style="opacity: 0"><slot></slot></div>';
  expect(isLoginField(pw())).toBe(false);
});

// Where no API can open a closed root, a slotted field's clipper can't be seen. The popup's Fill, the shortcut and
// the context menu have no target the user chose, so they fill only a field a hit test finds at its own centre.
describe("the closed-shadow policy, where closed roots can't be read", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", { ...chrome, dom: undefined });
  });

  const hitOnly = (visible: readonly string[]): void => {
    Object.defineProperty(Document.prototype, "elementFromPoint", {
      value(this: Document) {
        // The stub can't place anything: it answers for the field the test calls visible, else for the host.
        return visible.map((id) => this.getElementById(id)).find((found) => found !== null) ?? this.body;
      },
      configurable: true,
    });
  };

  it("doesn't fill a slotted pair a hit test doesn't find, and fills the real form", () => {
    hitOnly(["real-pw"]);
    const doc = mount('<div id="wrap" style="overflow-x: hidden; overflow-y: hidden; width: 0; height: 0"><slot></slot></div>', "closed", '<input id="bait" autocomplete="username"><input id="pw" type="password">');
    expect(fillLogin(doc, credentials).filled).toBe(true);
    expect([pw().value, (document.getElementById("real-pw") as HTMLInputElement).value]).toEqual(["", "hunter2!"]);
  });

  it("fills nothing when no field can be shown to be on screen", () => {
    hitOnly([]);
    const doc = mount("<slot></slot>", "closed");
    expect(fillLogin(doc, credentials).filled).toBe(false);
    expect(pw().value).toBe("");
  });

  it("treats a closed root the browser refuses to open as unreadable", () => {
    hitOnly(["real-pw"]);
    vi.stubGlobal("chrome", { ...chrome, dom: { openOrClosedShadowRoot: () => { throw new Error("refused"); } } });
    const doc = mount('<div style="opacity: 0"><slot></slot></div>', "closed");
    expect(fillLogin(doc, credentials).filled).toBe(true);
    expect([pw().value, (document.getElementById("real-pw") as HTMLInputElement).value]).toEqual(["", "hunter2!"]);
  });

  it("fills a target the user picked without a hit test", () => {
    hitOnly([]);
    const doc = mount("<slot></slot>", "closed");
    expect(fillLogin(doc, credentials, pw()).filled).toBe(true);
  });

  it("checks the username field the same way", () => {
    hitOnly(["real-pw"]);
    document.body.innerHTML = '<form><login-box id="host"><input id="bait" autocomplete="username"></login-box><input id="real-pw" type="password"></form>';
    const host = document.getElementById("host") as HTMLElement;
    host.attachShadow({ mode: "closed" }).innerHTML = '<div style="opacity: 0"><slot></slot></div>';
    expect(fillLogin(document, credentials).filled).toBe(true);
    expect([(document.getElementById("bait") as HTMLInputElement).value, (document.getElementById("real-pw") as HTMLInputElement).value]).toEqual(["", "hunter2!"]);
  });
});
