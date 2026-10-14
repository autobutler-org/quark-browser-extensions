import { fillLogin, isLoginField, passwordFields } from "../src/content/forms";

// A field in a frame the user can't see isn't a login field (#141). A same-origin frame reads its <iframe> through
// frameElement and holds it to the field rules; a cross-origin one is checked by the worker (worker-frames.test.ts).

type Box = Readonly<{ left: number; top: number; width: number; height: number }>;

const boxes = new Map<string, Box>();
const page: Box = { left: 0, top: 0, width: 1024, height: 768 };

// The <iframe> elements live in this window, so they get the stubbed layout. Each frame's document has its own
// Element.prototype, without checkVisibility, so inside the frame only the style checks run: the frame's own
// rendering is what these tests vary.
beforeEach(() => {
  boxes.clear();
  Object.defineProperty(Element.prototype, "checkVisibility", { value: () => true, configurable: true, writable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxes.get(this.id) ?? (this.localName === "iframe" ? { left: 20, top: 100, width: 400, height: 300 } : page);
    return DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
  });
});

afterEach(() => {
  delete (Element.prototype as Partial<Element>).checkVisibility;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// A page holding one iframe drawn with `style` (inside `wrapper`, if given), with a login form in the frame.
const framed = (style: string, wrapper = ""): Document => {
  document.body.innerHTML = wrapper === "" ? `<iframe id="frame" style="${style}"></iframe>` : `<div style="${wrapper}"><iframe id="frame" style="${style}"></iframe></div>`;
  const inner = (document.getElementById("frame") as HTMLIFrameElement).contentDocument as Document;
  inner.body.innerHTML = '<form><input id="user" autocomplete="username"><input id="pw" type="password"></form>';
  return inner;
};

describe("a password field in a hidden same-origin frame", () => {
  it.each([
    ["opacity: 0", "opacity: 0", ""],
    ["visibility: hidden", "visibility: hidden", ""],
    ["filter: opacity(0)", "filter: opacity(0)", ""],
    ["clip-path: inset(100%)", "clip-path: inset(100%)", ""],
    ["under an opacity: 0 wrapper", "", "opacity: 0"],
  ])("isn't a login field: %s", (_, style, wrapper) => {
    const inner = framed(style, wrapper);
    expect(passwordFields(inner)).toEqual([]);
  });

  it.each([
    ["0×0", { left: 20, top: 100, width: 0, height: 0 }],
    ["1×1", { left: 20, top: 100, width: 1, height: 1 }],
    ["moved off the left edge", { left: -10000, top: 100, width: 800, height: 600 }],
  ])("isn't a login field when the frame is %s", (_, box) => {
    boxes.set("frame", box);
    expect(passwordFields(framed(""))).toEqual([]);
  });

  it("isn't a login field two frames down when the outer frame is hidden", () => {
    document.body.innerHTML = '<iframe id="outer" style="opacity: 0"></iframe>';
    const middle = (document.getElementById("outer") as HTMLIFrameElement).contentDocument as Document;
    const inner = middle.createElement("iframe");
    middle.body.append(inner);
    const doc = inner.contentDocument as Document;
    doc.body.innerHTML = '<input id="pw" type="password">';
    expect(isLoginField(doc.getElementById("pw") as HTMLInputElement)).toBe(false);
  });

  it("isn't filled by the popup's Fill", () => {
    const inner = framed("opacity: 0");
    expect(fillLogin(inner, { username: "alice", password: "hunter2!" }).filled).toBe(false);
    expect((inner.getElementById("pw") as HTMLInputElement).value).toBe("");
  });
});

describe("a password field in a shown same-origin frame", () => {
  it("is a login field", () => {
    expect(passwordFields(framed("width: 400px; height: 300px")).map((field) => field.id)).toEqual(["pw"]);
  });

  it("is filled by the popup's Fill", () => {
    const inner = framed("");
    expect(fillLogin(inner, { username: "alice", password: "hunter2!" }).filled).toBe(true);
    expect((inner.getElementById("pw") as HTMLInputElement).value).toBe("hunter2!");
  });
});
