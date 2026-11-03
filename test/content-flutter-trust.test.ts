import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeI18n } from "./fakeChrome";
import { manualFillCommand } from "../src/background/manual";
import type { PageCommand, Request } from "../src/shared/messages";
import type { EntrySummary } from "../src/shared/types";

// Quark's own web login's DOM (#159) served by a page that may not be the connected Quark (#226). Its own file
// because content scripts from earlier tests keep watching jsdom's one document: one main() here, so nothing
// left over from another test answers for it.
//
// Quark's own web login (#159), a Flutter web page: the fields the user sees are painted into a <canvas>, and the
// <input>s that take the typing sit exactly over them in Flutter's semantics tree, made invisible as a whole with
// filter: opacity(0%). The fixture is that page's DOM as a release build draws it; the layout below is the one
// Chromium gave it at 1280×800.

const attached: HTMLInputElement[] = [];

vi.mock("../src/content/picker", () => ({
  attachPicker: (field: HTMLInputElement) => {
    attached.push(field);
    return { open: () => undefined, destroy: () => undefined };
  },
}));

vi.mock("../src/content/savebar", () => ({ showSaveBar: () => undefined }));

const entry: EntrySummary = { id: 7, name: "Test basic login", urlHost: "localhost", folderId: null, url: "", updatedAt: "" };
const credentials = { username: "admin", password: "correct horse battery", autoSubmit: false as boolean };

type Box = Readonly<{ left: number; top: number; width: number; height: number }>;
const viewport: Box = { left: 0, top: 0, width: 1280, height: 800 };
// Where Chromium put each field, from the live page.
const layout: Readonly<Record<string, Box>> = {
  user: { left: 440, top: 374, width: 400, height: 56 },
  pw: { left: 440, top: 446, width: 400, height: 56 },
};

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "forms", "login-flutter-quark.html"), "utf8");

const byTag = (name: string): HTMLInputElement => document.querySelector(`[data-fx="${name}"]`) as HTMLInputElement;

const boxOf = (element: Element): Box => {
  const tag = (element as HTMLElement).dataset?.fx;
  return (tag === undefined ? undefined : layout[tag]) ?? (element.localName === "canvas" ? (canvasBox ?? viewport) : viewport);
};
let canvasBox: Box | undefined;

const contains = (box: Box, x: number, y: number): boolean => x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;

// Flutter's inputs take clicks (pointer-events: all); the canvas doesn't. `over` is an element the page lays over
// part of a field, for the hostile cases.
let over: { element: Element; box: Box } | undefined;
const hit = (x: number, y: number): Element | null => {
  if (over !== undefined && contains(over.box, x, y)) {
    return over.element;
  }
  return [byTag("user"), byTag("pw")].find((field) => contains(boxOf(field), x, y)) ?? document.body;
};

type Listener = (message: PageCommand, sender: { id: string }, reply: (value: unknown) => void) => boolean;
let listener: Listener | undefined;
const sent: Request[] = [];
// What the worker answers quarkPage: whether this top frame is the connected Quark's web app (#226).
let quarkPage = true;

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// jsdom doesn't parse declarative shadow DOM; attach the glass pane's root by hand.
const load = (prepare: () => void = () => undefined): void => {
  document.body.innerHTML = fixture;
  document.querySelectorAll<HTMLTemplateElement>("template[shadowrootmode]").forEach((template) => {
    const host = template.parentElement as HTMLElement;
    host.attachShadow({ mode: "open" }).append(template.content);
    template.remove();
  });
  prepare();
};

const start = async (prepare?: () => void): Promise<void> => {
  load(prepare);
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      sendMessage: (request: Request) => {
        sent.push(request);
        return Promise.resolve(
          request.type === "hello"
            ? { settings: { inlineButton: true }, matches: [entry], connected: true }
            : request.type === "quarkPage"
              ? quarkPage
              : { ok: true, value: credentials },
        );
      },
      onMessage: { addListener: (added: Listener) => (listener = added) },
    },
  });
  vi.resetModules();
  const { main } = await import("../src/content/index");
  main();
  await settle();
};

// Resolves with the reply, or with "no reply" when the frame stays silent.
const command = (message: PageCommand): Promise<unknown> =>
  new Promise((resolve) => {
    if (listener?.(message, { id: "quark" }, resolve) === false) {
      setTimeout(() => resolve("no reply"), 0);
    }
  });

beforeEach(() => {
  attached.length = 0;
  sent.length = 0;
  listener = undefined;
  over = undefined;
  canvasBox = undefined;
  quarkPage = true;
  vi.stubGlobal("innerWidth", viewport.width);
  vi.stubGlobal("innerHeight", viewport.height);
  Object.defineProperty(Element.prototype, "checkVisibility", { value: () => true, configurable: true });
  Object.defineProperty(document, "elementFromPoint", { value: hit, configurable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxOf(this);
    return DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
  });
});

afterEach(() => {
  delete (Element.prototype as Partial<Element>).checkVisibility;
  delete (document as Partial<Document>).elementFromPoint;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("transparent fields over a canvas on a page that isn't the connected Quark (#226)", () => {
  it("are refused until the worker says the page is the Quark, asked at load and again when a field takes focus", async () => {
    quarkPage = false;
    await start();
    expect(sent.filter((request) => request.type === "quarkPage")).toHaveLength(1);
    expect(await command(manualFillCommand(entry.id, location.href))).toBe("no reply");
    expect(sent.filter((request) => request.type === "fillFromPage")).toEqual([]);
    expect([byTag("user").value, byTag("pw").value]).toEqual(["", ""]);
    expect(attached).toEqual([]);

    // The extension connects to this Quark meanwhile; the next focus asks again, and the page is trusted.
    quarkPage = true;
    byTag("user").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await settle();
    expect(sent.filter((request) => request.type === "quarkPage")).toHaveLength(2);
    expect(attached).toEqual(expect.arrayContaining([byTag("pw")]));
    expect(await command(manualFillCommand(entry.id, location.href))).toEqual({ ok: true, value: null });
    expect([byTag("user").value, byTag("pw").value]).toEqual(["admin", "correct horse battery"]);

    // Trusted, it doesn't ask again.
    byTag("pw").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await settle();
    expect(sent.filter((request) => request.type === "quarkPage")).toHaveLength(2);
  });

  it("are refused over a canvas without the worker's word, whatever the canvas draws", async () => {
    const { identifierField, passwordFields, trustCanvasFieldsIn, usernameFieldFor } = await import("../src/content/forms");
    trustCanvasFieldsIn(null);
    load();
    expect(passwordFields(document)).toEqual([]);
    expect(usernameFieldFor(byTag("pw"))).toBeNull();
    expect(identifierField(document)).toBeNull();
  });

  it("are refused in any document but the one the worker vouched for, such as a same-origin frame's", async () => {
    const { passwordFields, trustCanvasFieldsIn } = await import("../src/content/forms");
    load();
    trustCanvasFieldsIn(document.implementation.createHTMLDocument("another"));
    expect(passwordFields(document)).toEqual([]);
    trustCanvasFieldsIn(document);
    expect(passwordFields(document)).toEqual([byTag("pw")]);
    trustCanvasFieldsIn(null);
  });
});
