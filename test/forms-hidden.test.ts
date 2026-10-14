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
  // As in Chrome and Firefox, the content script can read closed shadow roots (none here).
  vi.stubGlobal("chrome", { ...chrome, dom: { openOrClosedShadowRoot: (host: HTMLElement) => host.shadowRoot } });
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

// Styles Chromium paints invisibly, or doesn't hit-test, while checkVisibility() stays true and the border box stays
// full (#142). jsdom keeps the declared value; Chromium's computed form is given where it differs.
describe("password fields hidden by collapse, filters, masks and clip-paths", () => {
  it.each([
    ["visibility: collapse", '<input id="pw" type="password" style="visibility: collapse">'],
    ["under a visibility: collapse wrapper", '<div style="visibility: collapse"><input id="pw" type="password"></div>'],
    ["filter: opacity(0)", '<input id="pw" type="password" style="filter: opacity(0)">'],
    ["filter: opacity(0%)", '<input id="pw" type="password" style="filter: opacity(0%)">'],
    ["filter: opacity just above 0 after another function", '<input id="pw" type="password" style="filter: blur(1px) opacity(0.05)">'],
    ["under a filter: opacity(0) wrapper", '<div style="filter: opacity(0)"><input id="pw" type="password"></div>'],
    ["opacity and filter that multiply to nearly 0", '<div style="opacity: 0.3"><input id="pw" type="password" style="filter: opacity(0.3)"></div>'],
    ["a transparent mask-image", '<input id="pw" type="password" style="mask-image: linear-gradient(transparent, transparent)">'],
    ["a transparent mask-image as Chromium computes it", '<input id="pw" type="password" style="mask-image: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))">'],
    ["a transparent mask in eight-digit hex", '<input id="pw" type="password" style="mask-image: conic-gradient(from 90deg, #12345600, rgb(0 0 0 / 0))">'],
    ["a transparent radial mask with stops", '<input id="pw" type="password" style="mask-image: radial-gradient(circle at center, #0000 0%, hsla(0, 0%, 0%, 0) 100%)">'],
    ["under a transparent mask wrapper", '<div style="mask-image: linear-gradient(to right, transparent, transparent)"><input id="pw" type="password"></div>'],
    ["clip-path: polygon(0 0, 0 0, 0 0)", '<input id="pw" type="password" style="clip-path: polygon(0px 0px, 0px 0px, 0px 0px)">'],
    ["clip-path: a polygon off the box", '<input id="pw" type="password" style="clip-path: polygon(-50px -50px, -10px -50px, -10px -10px)">'],
    ["clip-path: a polygon one pixel tall", '<input id="pw" type="password" style="clip-path: polygon(0% 0%, 100% 0%, 100% 1px, 0% 1px)">'],
    ["clip-path: inset(100px)", '<input id="pw" type="password" style="clip-path: inset(100px)">'],
    ["clip-path: inset(0 100% 0 0)", '<input id="pw" type="password" style="clip-path: inset(0px 100% 0px 0px)">'],
    ["clip-path: inset(0 0 100% 0)", '<input id="pw" type="password" style="clip-path: inset(0px 0px 100% 0px)">'],
    ["clip-path: inset with calc()", '<input id="pw" type="password" style="clip-path: inset(0px calc(50% + 120px) 0px 0px)">'],
    ["clip-path: rect(0 0 0 0), which Chromium rewrites to inset()", '<input id="pw" type="password" style="clip-path: inset(0px 100% 100% 0px)">'],
    ["clip-path: rect(0px 0px 0px 0px) as declared", '<input id="pw" type="password" style="clip-path: rect(0px 0px 0px 0px)">'],
    ["clip-path: xywh() 1px wide", '<input id="pw" type="password" style="clip-path: xywh(0px 0px 1px 100%)">'],
    ["clip-path: circle(1px)", '<input id="pw" type="password" style="clip-path: circle(1px at 50% 50%)">'],
    ["clip-path: a circle away from the box", '<input id="pw" type="password" style="clip-path: circle(10px at -500px -500px)">'],
    ["clip-path: ellipse(50px 0px)", '<input id="pw" type="password" style="clip-path: ellipse(50px 0px at 50% 50%)">'],
  ])("skips one with %s", (_, html) => {
    expect(ids(passwordFields(mount(html)))).toEqual([]);
  });

  it.each([
    ["filter: opacity(0.8)", '<input id="pw" type="password" style="filter: opacity(0.8)">'],
    ["filter: drop-shadow and blur", '<input id="pw" type="password" style="filter: drop-shadow(0px 1px 2px rgba(0, 0, 0, 0.2)) blur(0px)">'],
    ["a mask that fades one edge", '<input id="pw" type="password" style="mask-image: linear-gradient(to right, black 90%, transparent)">'],
    ["a mask image from a file", '<input id="pw" type="password" style="mask-image: url(mask.svg)">'],
    ["clip-path: inset(2px round 4px)", '<input id="pw" type="password" style="clip-path: inset(2px round 4px)">'],
    ["clip-path: inset(0px 10% 0px 10%)", '<input id="pw" type="password" style="clip-path: inset(0px 10% 0px 10%)">'],
    ["clip-path: a polygon covering the box", '<input id="pw" type="password" style="clip-path: polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)">'],
    ["clip-path: circle(50%)", '<input id="pw" type="password" style="clip-path: circle(50% at 50% 50%)">'],
    ["clip-path: circle() with a keyword radius", '<input id="pw" type="password" style="clip-path: circle(closest-side at 50% 50%)">'],
    ["clip-path: ellipse(50% 50%)", '<input id="pw" type="password" style="clip-path: ellipse(50% 50% at 50% 50%)">'],
    ["clip-path: a box only", '<input id="pw" type="password" style="clip-path: border-box">'],
    ["clip-path: a polygon reaching past the box", '<input id="pw" type="password" style="clip-path: polygon(evenodd, -50% -50%, 150% -50%, 150% 150%, -50% 150%)">'],
    ["clip-path: a triangle cut by the box", '<input id="pw" type="password" style="clip-path: polygon(50% -100%, 200% 200%, -100% 200%)">'],
    ["clip-path: circle(farthest-side)", '<input id="pw" type="password" style="clip-path: circle(farthest-side at 0px 0px)">'],
    ["clip-path: ellipse() with keyword radii", '<input id="pw" type="password" style="clip-path: ellipse(closest-side farthest-side)">'],
    ["clip-path: rect() with auto edges", '<input id="pw" type="password" style="clip-path: rect(auto auto auto auto)">'],
    ["clip-path: an inset it can't read", '<input id="pw" type="password" style="clip-path: inset(1em)">'],
    ["clip-path: a rect() it can't read", '<input id="pw" type="password" style="clip-path: rect(0px 0px 0px)">'],
    ["clip-path: a polygon it can't read", '<input id="pw" type="password" style="clip-path: polygon(0px 0px 0px, 1em 0px, 0px 0px)">'],
    ["clip-path: a circle placed by four values", '<input id="pw" type="password" style="clip-path: circle(1px at right 10px bottom 10px)">'],
    ["clip-path: a circle with a radius it can't read", '<input id="pw" type="password" style="clip-path: circle(1em)">'],
    ["clip-path: a calc() it can't read", '<input id="pw" type="password" style="clip-path: inset(calc(100% * 2))">'],
    ["a mask of an opaque hex colour", '<input id="pw" type="password" style="mask-image: linear-gradient(#000000ff, #0000)">'],
    ["a mask of a colour without alpha", '<input id="pw" type="password" style="mask-image: linear-gradient(45deg, rgb(0, 0, 0), transparent)">'],
    ["a mask of a named colour", '<input id="pw" type="password" style="mask-image: linear-gradient(in oklab, black, transparent)">'],
    ["clip-path: a path()", '<input id="pw" type="password" style="clip-path: path(&quot;M 0 0 L 10 0 L 10 10 Z&quot;)">'],
  ])("keeps one with %s", (_, html) => {
    expect(ids(passwordFields(mount(html)))).toEqual(["pw"]);
  });

  it("skips one under a wrapper whose clip-path: inset(100px) leaves none of the field", () => {
    boxes.set("wrap", { left: 20, top: 100, width: 240, height: 32 });
    expect(ids(passwordFields(mount('<div id="wrap" style="clip-path: inset(100px)"><input id="pw" type="password"></div>')))).toEqual([]);
  });

  it("skips one positioned out of its wrapper's clip-path, which clips positioned descendants too", () => {
    boxes.set("wrap", { left: 600, top: 100, width: 240, height: 32 });
    mount('<div id="wrap" style="clip-path: inset(0px)"><input id="pw" type="password" style="position: fixed"></div>');
    expect(ids(passwordFields(document))).toEqual([]);
  });

  it("keeps one a wrapper's clip-path only trims", () => {
    expect(ids(passwordFields(mount('<div style="clip-path: inset(100px)"><input id="pw" type="password"></div>')))).toEqual(["pw"]);
  });

  it.each([
    ["clip-path: inset(0 100% 0 0)", "inset(0 100% 0 0)", false],
    ["clip-path: polygon(0 0, 0 0, 0 0)", "polygon(0 0, 0 0, 0 0)", false],
    ["clip-path: inset(10px)", "inset(10px)", true],
  ])("without layout, judges %s against a nominal box", (_, clipPath, kept) => {
    delete (Element.prototype as Partial<Element>).checkVisibility;
    expect(ids(passwordFields(mount(`<input id="pw" type="password" style="clip-path: ${clipPath}">`)))).toEqual(kept ? ["pw"] : []);
  });

  it("fills the real form, not a filter: opacity(0) pair ahead of it", () => {
    const doc = mount(`
      <form><input id="bait-user" autocomplete="username" style="filter: opacity(0)"><input id="bait-pw" type="password" style="filter: opacity(0)"></form>
      <form><input id="user" autocomplete="username"><input id="pw" type="password"></form>
    `);
    expect(fillLogin(doc, credentials).filled).toBe(true);
    expect([input("bait-user").value, input("bait-pw").value, input("user").value, input("pw").value]).toEqual(["", "", "alice", "hunter2!"]);
  });
});
