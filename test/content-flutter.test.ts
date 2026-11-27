import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeI18n } from "./fakeChrome";
import { manualFillCommand } from "../src/background/manual";
import type { PageCommand, Request } from "../src/shared/messages";
import type { EntrySummary } from "../src/shared/types";

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
const canvas = (): HTMLCanvasElement | null => document.querySelector("flt-glass-pane")?.shadowRoot?.querySelector("canvas") ?? null;

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

// Each test loads a fresh content script; the observers of earlier ones are disconnected, so a scan they would
// run on this test's page can't draw pickers here.
const observers: MutationObserver[] = [];
class TrackedObserver extends MutationObserver {
  constructor(callback: MutationCallback) {
    super(callback);
    observers.push(this);
  }
}

type Listener = (message: PageCommand, sender: { id: string }, reply: (value: unknown) => void) => boolean;
let listener: Listener | undefined;
const sent: Request[] = [];
// What the worker says to "quarkPage": whether the page is the connected Quark's own (#226). An Error rejects.
let quarkPage: boolean | Error = true;

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
  vi.stubGlobal("MutationObserver", TrackedObserver);
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      sendMessage: (request: Request) => {
        sent.push(request);
        if (request.type === "quarkPage") {
          return quarkPage instanceof Error ? Promise.reject(quarkPage) : Promise.resolve(quarkPage);
        }
        return Promise.resolve(
          request.type === "hello" ? { settings: { inlineButton: true }, matches: [entry], connected: true } : { ok: true, value: credentials },
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
  observers.splice(0).forEach((observer) => observer.disconnect());
  delete (Element.prototype as Partial<Element>).checkVisibility;
  delete (document as Partial<Document>).elementFromPoint;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Quark's own Flutter login (#159)", () => {
  it("counts both fields as login fields and draws the inline button on them", async () => {
    const { passwordFields, setQuarkPage, usernameFieldFor } = await import("../src/content/forms");
    setQuarkPage(true);
    load();
    expect(passwordFields(document)).toEqual([byTag("pw")]);
    expect(usernameFieldFor(byTag("pw"))).toBe(byTag("user"));

    await start();
    expect(attached).toEqual(expect.arrayContaining([byTag("pw")]));
    expect(sent.filter((request) => request.type === "quarkPage")).toHaveLength(1);
  });

  it("fills both fields once the user confirms Fill anyway in the popup (#157)", async () => {
    await start();
    // What the worker sends frame 0 after the popup's confirmation, with the one-time grant open.
    const reply = await command(manualFillCommand(entry.id, location.href));
    expect(reply).toEqual({ ok: true, value: null });
    expect(sent.filter((request) => request.type === "fillFromPage")).toHaveLength(1);
    expect([byTag("user").value, byTag("pw").value]).toEqual(["admin", "correct horse battery"]);
  });

  it("fills both fields from the popup's Fill on an exact match", async () => {
    await start();
    await expect(command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host })).resolves.toEqual({ ok: true, value: null });
    expect([byTag("user").value, byTag("pw").value]).toEqual(["admin", "correct horse battery"]);
  });
});

describe("the fill into Flutter's fields", () => {
  it("waits for Flutter to take focus before it writes, and submits only after both fields hold the login", async () => {
    await start();
    const order: string[] = [];
    byTag("user").addEventListener("input", () => order.push(`user=${byTag("user").value}`));
    byTag("pw").addEventListener("input", () => order.push(`pw=${byTag("pw").value}`));
    byTag("pw").form?.addEventListener("submit", (event) => {
      event.preventDefault();
      order.push(`submit:${byTag("user").value}/${byTag("pw").value}`);
    });
    credentials.autoSubmit = true;
    try {
      const reply = command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host });
      expect([byTag("user").value, byTag("pw").value]).toEqual(["", ""]);
      await expect(reply).resolves.toEqual({ ok: true, value: null });
    } finally {
      credentials.autoSubmit = false;
    }
    expect(order).toEqual(["user=admin", "pw=correct horse battery", "submit:admin/correct horse battery"]);
  });

  it("doesn't write a field the page hides while Flutter takes focus, and says nothing was filled", async () => {
    await start();
    byTag("user").addEventListener("focus", () => canvas()?.remove(), { once: true });
    const reply = await command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host });
    expect(reply).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect([byTag("user").value, byTag("pw").value]).toEqual(["", ""]);

    // The refused fill is over: an ordinary form after it fills at once, and says so.
    const { filling, setValue } = await import("../src/content/forms");
    document.body.innerHTML = '<input id="plain">';
    const plain = document.getElementById("plain") as HTMLInputElement;
    setValue(plain, "alice");
    expect(plain.value).toBe("alice");
    await expect(filling()).resolves.toBe(true);
  });
});

// The same transparent fields with nothing painting them, or with a click there not reaching them, are decoys.
describe("transparent fields that nothing shows the user", () => {
  const refused = async (prepare: () => void): Promise<void> => {
    await start(prepare);
    const reply = await command(manualFillCommand(entry.id, location.href));
    // No login fields here: the frame stays silent, the worker says so, and the credentials are never asked for.
    expect(reply).toBe("no reply");
    expect(sent.filter((request) => request.type === "fillFromPage")).toEqual([]);
    expect([byTag("user").value, byTag("pw").value]).toEqual(["", ""]);
    expect(attached).toEqual([]);
  };

  // Nothing lies over a canvas here, so the worker isn't even asked whether this is the Quark's page.
  const refusedUnasked = async (prepare: () => void): Promise<void> => {
    await refused(prepare);
    expect(sent.filter((request) => request.type === "quarkPage")).toEqual([]);
  };

  it("refuses them without the canvas under them", async () => {
    await refusedUnasked(() => canvas()?.remove());
  });

  it("refuses them over a canvas that is itself transparent", async () => {
    await refusedUnasked(() => canvas()?.style.setProperty("opacity", "0"));
  });

  it("refuses them over a canvas hidden with display: none", async () => {
    await refusedUnasked(() => canvas()?.style.setProperty("display", "none"));
  });

  it("refuses them over a canvas that doesn't reach under the whole field", async () => {
    canvasBox = { left: 0, top: 0, width: 600, height: 800 };
    await refusedUnasked(() => undefined);
  });

  it("refuses them when a click on part of the field lands on something else", async () => {
    await refusedUnasked(() => {
      const cover = document.createElement("div");
      document.body.append(cover);
      over = { element: cover, box: { left: 600, top: 0, width: 680, height: 800 } };
    });
  });
});

// The canvas rule holds only on the connected Quark's own pages (#226). A page can lay transparent fields over a
// blank canvas, or one painted as some other control, with markup alone, and what a canvas draws can't be read.
describe("transparent fields over a canvas on a page that isn't the Quark's", () => {
  const refusedOffQuark = async (): Promise<void> => {
    await start();
    const reply = await command(manualFillCommand(entry.id, location.href));
    expect(reply).toBe("no reply");
    expect(sent.filter((request) => request.type === "fillFromPage")).toEqual([]);
    expect([byTag("user").value, byTag("pw").value]).toEqual(["", ""]);
    expect(attached).toEqual([]);
  };

  it("refuses them when the worker says the page isn't the Quark's", async () => {
    quarkPage = false;
    await refusedOffQuark();
    expect(sent.filter((request) => request.type === "quarkPage")).toHaveLength(1);
  });

  it("refuses them while the worker can't answer", async () => {
    quarkPage = new Error("worker asleep");
    await refusedOffQuark();
  });

  it("refuses them from the forms module before the worker has answered", async () => {
    const { passwordFields, setQuarkPage } = await import("../src/content/forms");
    load();
    setQuarkPage(false);
    expect(passwordFields(document)).toEqual([]);
  });
});
