import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeI18n } from "./fakeChrome";
import type { PageCommand, Request } from "../src/shared/messages";
import type { EntrySummary } from "../src/shared/types";

// Quark's own web login without Flutter's semantics tree (#192), which is how most people get it: the page has no
// <input> until a field is clicked. Then Flutter's engine builds an autofill <form> for the sign-in fields in
// <flt-text-editing-host>: the focused field's <input>, tabindex=-1, over the field the canvas paints, and the
// other field's <input> 0×0 beside it. When focus leaves Flutter (to the inline picker, or the popup) the engine
// puts the form away; focus on one of its fields brings it back, with a new <input> for the field Flutter focuses.

type Pick = (entry: EntrySummary) => Promise<string | null>;
const attached: { field: HTMLInputElement; onPick: Pick }[] = [];

vi.mock("../src/content/picker", () => ({
  attachPicker: (field: HTMLInputElement, _matches: unknown, _host: string, handlers: { onPick: Pick }) => {
    attached.push({ field, onPick: handlers.onPick });
    return { open: () => undefined, destroy: () => undefined };
  },
}));

vi.mock("../src/content/savebar", () => ({ showSaveBar: () => undefined }));

const entry: EntrySummary = { id: 7, name: "This Quark", urlHost: "localhost", folderId: null, url: "", updatedAt: "" };
const credentials = { username: "admin", password: "correct horse battery", autoSubmit: false };
// What the picker says when it finds no login fields to fill.
const refused = "Couldn't find the login fields on this page.";

type Box = Readonly<{ left: number; top: number; width: number; height: number }>;
const viewport: Box = { left: 0, top: 0, width: 1280, height: 800 };
const nowhere: Box = { left: 0, top: 0, width: 0, height: 0 };
// Where Chromium put the focused field's <input>, from the live page; the others are 0×0.
const fieldBoxes: Readonly<Record<string, Box>> = {
  username: { left: 492, top: 390, width: 332, height: 24 },
  "current-password": { left: 492, top: 462, width: 296, height: 24 },
};

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "forms", "login-flutter-quark-autofill.html"), "utf8");

const form = (): HTMLFormElement => document.querySelector("flt-text-editing-host form") as HTMLFormElement;
const named = (name: string): HTMLInputElement => form().querySelector(`input[name="${name}"]`) as HTMLInputElement;
const user = (): HTMLInputElement => named("username");
const pw = (): HTMLInputElement => named("current-password");

const isEngineInput = (element: Element): element is HTMLInputElement =>
  element instanceof HTMLInputElement && element.parentElement?.localName === "form" && element.type !== "submit";

const boxOf = (element: Element): Box => {
  if (isEngineInput(element)) {
    return awake && element === document.activeElement ? (fieldBoxes[element.name] ?? nowhere) : nowhere;
  }
  return element.localName === "canvas" || element === document.body ? viewport : nowhere;
};

const contains = (box: Box, x: number, y: number): boolean => x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;

// The focused field takes the click over it, unless `over` lies over that part of it.
let over: { element: Element; box: Box } | undefined;
const hit = (x: number, y: number): Element | null => {
  if (over !== undefined && contains(over.box, x, y)) {
    return over.element;
  }
  const active = document.activeElement;
  return active !== null && isEngineInput(active) && contains(boxOf(active), x, y) ? active : document.body;
};

// Flutter's side: focus on a field of the put-away form makes it focus the field the user last had, which it
// does a moment later, with a new <input>. `restores` names that field; null keeps the form put away.
let restores: string | null = "username";
let awake = true;
const wakeOnFocus = (): void => {
  form().addEventListener(
    "focusin",
    (event) => {
      if (awake || restores === null) {
        return;
      }
      const name = restores;
      setTimeout(() => {
        const old = named(name);
        const fresh = old.cloneNode() as HTMLInputElement;
        fresh.value = old.value;
        fresh.tabIndex = -1;
        old.replaceWith(fresh);
        awake = true;
        fresh.focus();
      }, 0);
      (event.target as HTMLElement).blur();
    },
    true,
  );
};

// What the engine hears: input events on the group's fields, in order, and which field had focus for each.
const heard: string[] = [];
const listen = (): void => {
  form().addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    heard.push(`${input.name}=${input.value}${input === document.activeElement ? " (focused)" : ""}`);
  });
};

// Focus leaves Flutter for the extension's own picker: the engine puts its form away.
const takeFocus = (): void => {
  awake = false;
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
};

type Listener = (message: PageCommand, sender: { id: string }, reply: (value: unknown) => void) => boolean;
let listener: Listener | undefined;
const sent: Request[] = [];

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const load = (): void => {
  document.body.innerHTML = fixture;
  document.querySelectorAll<HTMLTemplateElement>("template[shadowrootmode]").forEach((template) => {
    const host = template.parentElement as HTMLElement;
    host.attachShadow({ mode: "open" }).append(template.content);
    template.remove();
  });
  wakeOnFocus();
  listen();
};

const stubChrome = (): void => {
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      sendMessage: (request: Request) => {
        sent.push(request);
        return Promise.resolve(
          request.type === "hello" ? { settings: { inlineButton: true }, matches: [entry], connected: true } : { ok: true, value: credentials },
        );
      },
      onMessage: { addListener: (added: Listener) => (listener = added) },
    },
  });
};

// The user has clicked `field`: Flutter has it focused.
const start = async (field: () => HTMLInputElement = user): Promise<void> => {
  load();
  restores = field().name;
  field().focus();
  vi.resetModules();
  const { main } = await import("../src/content/index");
  main();
  await settle();
};

const command = (message: PageCommand): Promise<unknown> =>
  new Promise((resolve) => {
    if (listener?.(message, { id: "quark" }, resolve) === false) {
      setTimeout(() => resolve("no reply"), 0);
    }
  });

beforeEach(() => {
  attached.length = 0;
  sent.length = 0;
  heard.length = 0;
  listener = undefined;
  over = undefined;
  restores = "username";
  awake = true;
  stubChrome();
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

describe("Quark's login through Flutter's engine autofill form (#192)", () => {
  it("draws the inline button on the field Flutter has focused, though the engine marks it tabindex=-1", async () => {
    const { isLoginField, passwordFields } = await import("../src/content/forms");
    load();
    expect(isLoginField(user())).toBe(false);
    user().focus();
    expect(isLoginField(user())).toBe(true);
    // The 0×0 password beside it is no field the user can see.
    expect(passwordFields(document)).toEqual([]);

    await start();
    expect(attached.map(({ field }) => field)).toEqual([user()]);
  });

  it("fills the hidden password through the engine before the focused username, without moving focus to it", async () => {
    await start();
    const focused = user();
    await expect(command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host })).resolves.toEqual({ ok: true, value: null });
    expect(heard).toEqual(["current-password=correct horse battery", "username=admin (focused)"]);
    expect(document.activeElement).toBe(focused);
  });

  it("fills from the picker once Flutter has a field focused again, into the fields the engine then has", async () => {
    await start();
    const { field, onPick } = attached[0]!;
    takeFocus();
    await expect(onPick(entry)).resolves.toBeNull();
    // Flutter swapped in a new <input> for Username; the fill went to it, not to the one the picker was on.
    expect(field.isConnected).toBe(false);
    expect([user().value, pw().value]).toEqual(["admin", "correct horse battery"]);
    expect(heard).toEqual(["current-password=correct horse battery", "username=admin (focused)"]);
  });

  it("puts each value in its own field when Flutter focuses another field than the one the picker was on", async () => {
    await start(pw);
    const { field, onPick } = attached[0]!;
    expect(field).toBe(pw());
    restores = "username";
    takeFocus();
    await expect(onPick(entry)).resolves.toBeNull();
    expect([user().value, pw().value]).toEqual(["admin", "correct horse battery"]);
  });

  it("writes nothing when Flutter doesn't bring a field back, and says it found no login fields", async () => {
    await start();
    const { onPick } = attached[0]!;
    restores = null;
    takeFocus();
    await expect(onPick(entry)).resolves.toBe(refused);
    expect([user().value, pw().value]).toEqual(["", ""]);
    expect(heard).toEqual([]);
  });

  it("writes nothing when something else lies over the field Flutter focuses (#147)", async () => {
    await start();
    const { onPick } = attached[0]!;
    const cover = document.createElement("div");
    document.body.append(cover);
    over = { element: cover, box: viewport };
    takeFocus();
    await expect(onPick(entry)).resolves.toBe(refused);
    expect([user().value, pw().value]).toEqual(["", ""]);
    expect(heard).toEqual([]);
  });

  it("fills from the popup with Flutter's form put away, once a field has had focus", async () => {
    await start();
    takeFocus();
    await expect(command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host })).resolves.toEqual({ ok: true, value: null });
    expect([user().value, pw().value]).toEqual(["admin", "correct horse battery"]);
  });
});

describe("tabindex=-1 outside Flutter's engine form", () => {
  it("still marks a focused field a honeypot when it isn't in the engine's form", async () => {
    const { isLoginField } = await import("../src/content/forms");
    load();
    const decoy = user().cloneNode() as HTMLInputElement;
    decoy.tabIndex = -1;
    document.body.append(decoy);
    decoy.focus();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = this === decoy ? fieldBoxes.username! : boxOf(this);
      return DOMRect.fromRect({ x: box.left, y: box.top, width: box.width, height: box.height });
    });
    expect(isLoginField(decoy)).toBe(false);
  });
});
