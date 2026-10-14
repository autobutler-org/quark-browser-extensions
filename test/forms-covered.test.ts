import { fillLogin, passwordFields } from "../src/content/forms";

// Login fields buried under another element (#147): style and size say they are shown, but the user can't
// click them, so the hit test at their own points must reach them.

const credentials = { username: "alice", password: "hunter2!" };

type Box = Readonly<{ left: number; top: number; width: number; height: number }>;

// jsdom has no layout or hit testing: each test places elements by id, drawn in the order placed, so a later box
// is on top. Everything unplaced gets a box that clips nothing and is drawn under every placed box.
const boxes = new Map<string, Box>();
const page: Box = { left: 0, top: 0, width: 1024, height: 768 };

const inside = (box: Box, x: number, y: number): boolean =>
  x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;

const hits: (readonly [number, number])[] = [];

const hitTest = (x: number, y: number): Element | null => {
  hits.push([x, y]);
  if (!inside(page, x, y)) {
    return null;
  }
  const top = [...boxes].findLast(([, box]) => inside(box, x, y));
  return top === undefined ? document.body : document.getElementById(top[0]);
};

beforeEach(() => {
  boxes.clear();
  hits.length = 0;
  vi.stubGlobal("chrome", { ...chrome, dom: { openOrClosedShadowRoot: (host: HTMLElement) => host.shadowRoot } });
  Object.defineProperty(Element.prototype, "checkVisibility", { value: () => true, configurable: true, writable: true });
  Object.defineProperty(document, "elementFromPoint", { value: hitTest, configurable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxes.get(this.id) ?? page;
    return DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
  });
});

afterEach(() => {
  delete (Element.prototype as Partial<Element>).checkVisibility;
  delete (document as Partial<Document>).elementFromPoint;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = (html: string): Document => {
  document.body.innerHTML = html;
  return document;
};

const ids = (fields: readonly HTMLInputElement[]): readonly string[] => fields.map((found) => found.id);

const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;

const form = '<form><input id="user" autocomplete="username"><input id="pw" type="password"></form>';
const user: Box = { left: 20, top: 100, width: 240, height: 32 };
const pw: Box = { left: 20, top: 140, width: 240, height: 32 };

const place = (cover: string, box: Box | null): void => {
  boxes.set("user", user);
  boxes.set("pw", pw);
  if (box !== null) {
    boxes.set(cover, box);
  }
};

describe("login fields under another element", () => {
  it("skips fields an opaque overlay covers entirely", () => {
    mount(`${form}<div id="cover" style="position: absolute; inset: 0px; background: #fff"></div>`);
    place("cover", page);
    expect(ids(passwordFields(document))).toEqual([]);
  });

  it("refuses the popup's Fill into covered fields, and a target under the overlay", () => {
    const doc = mount(`${form}<div id="cover"></div>`);
    place("cover", page);
    expect(fillLogin(doc, credentials)).toEqual({ filled: false, form: null });
    expect(fillLogin(doc, credentials, input("pw")).filled).toBe(false);
    expect([input("user").value, input("pw").value]).toEqual(["", ""]);
  });

  it("fills the real form, not covered fields ahead of it", () => {
    const doc = mount(`<form><input id="bait-user" autocomplete="username"><input id="bait-pw" type="password"></form><div id="cover"></div>${form}`);
    boxes.set("bait-user", { left: 20, top: 400, width: 240, height: 32 });
    boxes.set("bait-pw", { left: 20, top: 440, width: 240, height: 32 });
    place("cover", { left: 0, top: 380, width: 400, height: 120 });
    expect(fillLogin(doc, credentials).filled).toBe(true);
    expect([input("bait-user").value, input("bait-pw").value, input("user").value, input("pw").value]).toEqual(["", "", "alice", "hunter2!"]);
  });

  it.each([
    ["a sticky header over the top of the username", { left: 0, top: 0, width: 1024, height: 116 }],
    ["a cookie banner over the bottom of the password", { left: 0, top: 156, width: 1024, height: 612 }],
    ["a badge over the middle", { left: 100, top: 145, width: 80, height: 22 }],
    ["a banner over the left half", { left: 0, top: 0, width: 140, height: 768 }],
  ])("keeps fields %s only partly covers", (_, box) => {
    const doc = mount(`${form}<div id="cover"></div>`);
    place("cover", box);
    expect(ids(passwordFields(doc))).toEqual(["pw"]);
    expect(fillLogin(doc, credentials).filled).toBe(true);
    expect([input("user").value, input("pw").value]).toEqual(["alice", "hunter2!"]);
  });

  it("keeps a field whose own label floats over it", () => {
    mount('<input id="pw" type="password"><label id="label" for="pw">Password</label>');
    place("label", pw);
    expect(ids(passwordFields(document))).toEqual(["pw"]);
  });

  it("skips a field another field's label covers", () => {
    mount('<input id="user"><input id="pw" type="password"><label id="label" for="user">Email</label>');
    place("label", pw);
    expect(ids(passwordFields(document))).toEqual([]);
  });

  it("keeps a field below the fold, where nothing can be hit-tested yet", () => {
    mount('<input id="pw" type="password">');
    boxes.set("pw", { left: 20, top: 2400, width: 240, height: 32 });
    expect(ids(passwordFields(document))).toEqual(["pw"]);
    expect(hits).toEqual([]);
  });

  it("tests only the points still in the viewport of a field the fold cuts", () => {
    mount('<input id="pw" type="password"><div id="cover"></div>');
    boxes.set("pw", { left: 20, top: 740, width: 240, height: 100 });
    boxes.set("cover", { left: 0, top: 700, width: 1024, height: 68 });
    expect(ids(passwordFields(document))).toEqual([]);
    expect(hits.every(([, y]) => y < 768)).toBe(true);
  });

  it("skips a same-origin frame an overlay covers in its parent page", () => {
    mount('<iframe id="frame"></iframe><div id="cover"></div>');
    boxes.set("frame", { left: 500, top: 0, width: 400, height: 300 });
    boxes.set("cover", page);
    const inner = (document.getElementById("frame") as HTMLIFrameElement).contentDocument as Document;
    inner.body.innerHTML = '<input id="pw" type="password">';
    Object.defineProperty(inner, "elementFromPoint", { value: () => inner.getElementById("pw") });
    expect(ids(passwordFields(inner))).toEqual([]);
    boxes.delete("cover");
    expect(ids(passwordFields(inner))).toEqual(["pw"]);
  });
});
