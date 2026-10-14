import { fillLogin, passwordFields, standaloneUsernameField, usernameFieldFor } from "../src/content/forms";

// Login fields a page hides from the user without display, visibility or [hidden] (#129): never filled.

const credentials = { username: "alice", password: "hunter2!" };

type Box = Readonly<{ left: number; top: number; width: number; height: number }>;

// jsdom has no layout: each test places elements by id, and everything else gets a box that clips nothing.
const boxes = new Map<string, Box>();
const page: Box = { left: 0, top: 0, width: 1024, height: 768 };
const field: Box = { left: 20, top: 100, width: 240, height: 32 };

beforeEach(() => {
  boxes.clear();
  Object.defineProperty(Element.prototype, "checkVisibility", { value: () => true, configurable: true, writable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxes.get(this.id) ?? (this.localName === "input" ? field : page);
    return DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
  });
});

afterEach(() => {
  delete (Element.prototype as Partial<Element>).checkVisibility;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = (html: string): Document => {
  document.body.innerHTML = html;
  return document;
};

const ids = (fields: readonly HTMLInputElement[]): readonly string[] => fields.map((found) => found.id);

const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;

describe("password fields the page has hidden", () => {
  it.each([
    ["opacity: 0", '<input id="pw" type="password" style="opacity: 0">'],
    ["opacity just above 0", '<input id="pw" type="password" style="opacity: 0.05">'],
    ["under an opacity: 0 wrapper", '<div style="opacity: 0"><input id="pw" type="password"></div>'],
    ["under faded wrappers that multiply to nearly 0", '<div style="opacity: 0.3"><div style="opacity: 0.3"><input id="pw" type="password" style="opacity: 0.5"></div></div>'],
    ["clip-path: inset(50%)", '<input id="pw" type="password" style="clip-path: inset(50%)">'],
    ["under a clip-path: inset(50%) wrapper", '<div style="clip-path: inset(50%)"><input id="pw" type="password"></div>'],
    ["clip: rect(0 0 0 0)", '<input id="pw" type="password" style="position: absolute; clip: rect(0px, 0px, 0px, 0px)">'],
  ])("skips one with %s", (_, html) => {
    expect(ids(passwordFields(mount(html)))).toEqual([]);
  });

  it.each([
    ["moved off the left edge", { left: -10000, top: 0, width: 240, height: 32 }],
    ["moved above the top", { left: 20, top: -500, width: 240, height: 32 }],
    ["1px square", { left: 20, top: 100, width: 1, height: 1 }],
    ["1px tall", { left: 20, top: 100, width: 240, height: 1 }],
  ])("skips one %s", (_, box) => {
    boxes.set("pw", box);
    expect(ids(passwordFields(mount('<input id="pw" type="password">')))).toEqual([]);
  });

  it("skips one the browser doesn't render, such as inside a closed <details>", () => {
    mount('<details><summary>More</summary><input id="pw" type="password"></details>');
    (Element.prototype as { checkVisibility: () => boolean }).checkVisibility = function (this: Element) {
      return this.id !== "pw";
    };
    expect(ids(passwordFields(document))).toEqual([]);
  });

  it("skips one moved past the right edge of a page that can't scroll sideways", () => {
    boxes.set("pw", { left: 5000, top: 100, width: 240, height: 32 });
    mount('<input id="pw" type="password">');
    document.documentElement.style.overflowX = "hidden";
    try {
      expect(ids(passwordFields(document))).toEqual([]);
    } finally {
      document.documentElement.style.overflowX = "";
    }
  });

  it("skips one clipped away by a collapsed wrapper", () => {
    boxes.set("wrap", { left: 0, top: 100, width: 1024, height: 0 });
    expect(ids(passwordFields(mount('<div id="wrap" style="overflow-y: hidden"><input id="pw" type="password"></div>')))).toEqual([]);
  });

  it("skips one fixed outside the viewport", () => {
    boxes.set("pw", { left: -400, top: 100, width: 240, height: 32 });
    expect(ids(passwordFields(mount('<input id="pw" type="password" style="position: fixed">')))).toEqual([]);
  });
});

describe("password fields the user can reach", () => {
  it("keeps one below the fold: scrolling brings it into view", () => {
    boxes.set("pw", { left: 20, top: 2400, width: 240, height: 32 });
    expect(ids(passwordFields(mount('<input id="pw" type="password">')))).toEqual(["pw"]);
  });

  it("keeps one scrolled past, above the viewport but still on the page", () => {
    vi.stubGlobal("scrollY", 3000);
    boxes.set("pw", { left: 20, top: -2000, width: 240, height: 32 });
    expect(ids(passwordFields(mount('<input id="pw" type="password">')))).toEqual(["pw"]);
  });

  it("keeps one faded only slightly", () => {
    expect(ids(passwordFields(mount('<div style="opacity: 0.9"><input id="pw" type="password" style="opacity: 0.8"></div>')))).toEqual(["pw"]);
  });

  it("keeps one in a dialog fixed over a page that has locked its scrolling", () => {
    boxes.set("wrap", { left: 0, top: 0, width: 1024, height: 0 });
    mount('<div id="wrap" style="overflow-y: hidden; height: 0"><div style="position: fixed"><input id="pw" type="password"></div></div>');
    expect(ids(passwordFields(document))).toEqual(["pw"]);
  });

  it("keeps one positioned out of a clipping box that isn't its containing block", () => {
    boxes.set("wrap", { left: 0, top: 0, width: 100, height: 0 });
    mount('<div id="wrap" style="overflow-y: hidden"><input id="pw" type="password" style="position: absolute"></div>');
    expect(ids(passwordFields(document))).toEqual(["pw"]);
  });

  it("keeps one in a scrolling panel, scrolled out of the panel's view", () => {
    boxes.set("panel", { left: 0, top: 0, width: 400, height: 200 });
    boxes.set("pw", { left: 20, top: 600, width: 240, height: 32 });
    mount('<div id="panel" style="overflow-y: auto"><input id="pw" type="password"></div>');
    expect(ids(passwordFields(document))).toEqual(["pw"]);
  });
});

describe("username fields the page has hidden", () => {
  it("doesn't pair a password with a hidden username field ahead of the real one", () => {
    boxes.set("bait", { left: -10000, top: 0, width: 240, height: 32 });
    mount('<form><input id="user" type="text" name="login"><input id="bait" type="text" autocomplete="username"><input id="pw" type="password"></form>');
    expect(usernameFieldFor(input("pw"))?.id).toBe("user");
  });

  it("doesn't offer an opacity: 0 field as the identifier step", () => {
    mount('<input id="bait" type="email" autocomplete="username" style="opacity: 0"><input id="user" type="email" name="email">');
    expect(standaloneUsernameField(document)?.id).toBe("user");
  });
});

describe("fillLogin", () => {
  it("fills the real form, not decoys of each kind ahead of it", () => {
    boxes.set("off-user", { left: -10000, top: 0, width: 240, height: 32 });
    boxes.set("off-pw", { left: -10000, top: 0, width: 240, height: 32 });
    boxes.set("tiny-user", { left: 20, top: 40, width: 1, height: 1 });
    boxes.set("tiny-pw", { left: 20, top: 40, width: 1, height: 1 });
    const doc = mount(`
      <form><input id="off-user" autocomplete="username"><input id="off-pw" type="password"></form>
      <form><input id="clear-user" autocomplete="username" style="opacity: 0"><input id="clear-pw" type="password" style="opacity: 0"></form>
      <form><input id="tiny-user" autocomplete="username"><input id="tiny-pw" type="password"></form>
      <form><input id="user" autocomplete="username"><input id="pw" type="password"></form>
    `);
    expect(fillLogin(doc, credentials).filled).toBe(true);
    const values = Object.fromEntries([...doc.querySelectorAll("input")].map((found) => [found.id, found.value]));
    expect(values).toEqual({ "off-user": "", "off-pw": "", "clear-user": "", "clear-pw": "", "tiny-user": "", "tiny-pw": "", user: "alice", pw: "hunter2!" });
  });

  it("refuses a target the page hid after it was chosen", () => {
    const doc = mount('<form><input id="user" autocomplete="username"><input id="pw" type="password"></form>');
    input("pw").style.opacity = "0";
    expect(fillLogin(doc, credentials, input("pw"))).toEqual({ filled: false, form: null });
    expect([input("user").value, input("pw").value]).toEqual(["", ""]);
  });

  it("refuses a target moved off-screen after it was chosen", () => {
    const doc = mount('<form><input id="user" autocomplete="username"><input id="pw" type="password"></form>');
    boxes.set("pw", { left: -10000, top: 0, width: 240, height: 32 });
    expect(fillLogin(doc, credentials, input("pw")).filled).toBe(false);
    expect(input("pw").value).toBe("");
  });

  it("refuses a username target the page has hidden", () => {
    const doc = mount('<input id="user" autocomplete="username" style="opacity: 0">');
    expect(fillLogin(doc, credentials, input("user")).filled).toBe(false);
    expect(input("user").value).toBe("");
  });

  it("refuses a target removed from the page", () => {
    const doc = mount('<form><input id="pw" type="password"></form>');
    const pw = input("pw");
    pw.remove();
    expect(fillLogin(doc, credentials, pw).filled).toBe(false);
  });
});
