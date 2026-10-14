import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeI18n } from "./fakeChrome";
import type { PageCommand, Request } from "../src/shared/messages";
import type { EntrySummary } from "../src/shared/types";
import type { SaveAction, SaveOffer } from "../src/background/save";

// The content script's command handler, frame checks and login capture. The worker is faked through
// chrome.runtime; the picker and save bar are stubbed so their handlers can be driven directly.

type Attached = Readonly<{
  field: HTMLInputElement;
  matches: readonly EntrySummary[];
  onPick: (entry: EntrySummary) => Promise<string | null>;
  onSuggest?: (() => Promise<string | null>) | undefined;
}>;

const attached: Attached[] = [];
const opened: HTMLInputElement[] = [];
const bars: { offer: SaveOffer; onAction: (action: SaveAction) => Promise<string | null> }[] = [];

vi.mock("../src/content/picker", () => ({
  attachPicker: (field: HTMLInputElement, matches: readonly EntrySummary[], _host: string, handlers: Attached) => {
    attached.push({ field, matches, onPick: handlers.onPick, onSuggest: handlers.onSuggest });
    return { open: () => void opened.push(field), destroy: () => undefined };
  },
}));

vi.mock("../src/content/savebar", () => ({
  showSaveBar: (_doc: Document, offer: SaveOffer, onAction: (action: SaveAction) => Promise<string | null>) =>
    void bars.push({ offer, onAction }),
}));

const entry: EntrySummary = { id: 7, name: "Example", urlHost: "localhost", folderId: null, createdAt: "", updatedAt: "" };
const credentials = { username: "alice@example.com", password: "hunter2!", autoSubmit: false };
const offer: SaveOffer = { kind: "save", host: "localhost", username: "alice@example.com" };

const observers: MutationObserver[] = [];
class TrackedObserver extends MutationObserver {
  constructor(callback: MutationCallback) {
    super(callback);
    observers.push(this);
  }
}

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

type Worker = (request: Request) => unknown;
type Listener = (message: PageCommand, sender: { id: string }, reply: (value: unknown) => void) => boolean;

let listener: Listener | undefined;
const sent: Request[] = [];
const topDescriptor = Object.getOwnPropertyDescriptor(window, "top");

// Each test loads the script afresh onto the same document; remember its listeners so they can be taken off.
const added: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
const addEventListener = document.addEventListener.bind(document);
document.addEventListener = (type: string, handler: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  added.push([type, handler, options]);
  addEventListener(type, handler, options);
};

const hello = (matches: readonly EntrySummary[], connected = true) => ({ settings: { inlineButton: true }, matches, connected });

// `framed` loads the script as if it ran in a child frame: window.top is another window.
const setup = async (fixture: string, worker: Worker, { framed = false } = {}): Promise<void> => {
  document.body.innerHTML = readFileSync(join(import.meta.dirname, "fixtures", "forms", fixture), "utf8");
  if (framed) {
    const parent = {};
    Object.defineProperty(window, "top", { get: () => parent, configurable: true });
  }
  vi.stubGlobal("MutationObserver", TrackedObserver);
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      sendMessage: (request: Request) => {
        sent.push(request);
        try {
          return Promise.resolve(worker(request));
        } catch (cause) {
          return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      },
      onMessage: { addListener: (added: Listener) => (listener = added) },
    },
  });
  vi.resetModules();
  const { main } = await import("../src/content/index");
  main();
  await settle();
};

const byTag = (name: string): HTMLInputElement => document.querySelector(`[data-fx="${name}"]`) as HTMLInputElement;

// Resolves with the reply, or with "no reply" when the frame stays silent.
const noReply = Symbol("no reply");
const command = (message: PageCommand, senderId = "quark"): Promise<unknown> =>
  new Promise((resolve) => {
    const async = listener?.(message, { id: senderId }, resolve);
    if (async === false) {
      setTimeout(() => resolve(noReply), 0);
    }
  });

const ofType = (type: Request["type"]) => sent.filter((request) => request.type === type);

beforeEach(() => {
  attached.length = 0;
  opened.length = 0;
  bars.length = 0;
  sent.length = 0;
  listener = undefined;
});

afterEach(() => {
  observers.splice(0).forEach((observer) => observer.disconnect());
  added.splice(0).forEach(([type, handler, options]) => document.removeEventListener(type, handler, options));
  vi.unstubAllGlobals();
  if (topDescriptor !== undefined) {
    Object.defineProperty(window, "top", topDescriptor);
  }
});

describe("who the content script listens to", () => {
  it("ignores commands from anyone but its own extension", async () => {
    await setup("login-basic.html", (request) => (request.type === "hello" ? hello([entry]) : { ok: true, value: credentials }));
    const reply = await command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host }, "other-extension");
    expect(reply).toBe(noReply);
    expect(ofType("fillFromPage")).toEqual([]);
    expect(byTag("pw").value).toBe("");
  });

  it("tells the worker the top frame's URL", async () => {
    await setup("login-basic.html", () => null);
    await expect(command({ type: "whereAmI" })).resolves.toBe(location.href);
  });

  it("keeps a child frame's URL to itself when asked where the top is", async () => {
    await setup("login-basic.html", () => null, { framed: true });
    await expect(command({ type: "whereAmI" })).resolves.toBe(noReply);
  });
});

describe("the popup's Fill in the top frame", () => {
  const fill = { type: "fill", entryId: 7, entryUrl: "http://localhost:3000/login", entryHost: "localhost" } as const;

  it("fills the username and password from the worker", async () => {
    await setup("login-basic.html", (request) => (request.type === "hello" ? hello([entry]) : { ok: true, value: credentials }));
    await expect(command({ ...fill, entryUrl: location.href, entryHost: location.host })).resolves.toEqual({ ok: true, value: null });
    expect([byTag("user").value, byTag("pw").value]).toEqual(["alice@example.com", "hunter2!"]);
  });

  it("submits the form when the worker says to", async () => {
    await setup("login-basic.html", (request) =>
      request.type === "hello" ? hello([entry]) : { ok: true, value: { ...credentials, autoSubmit: true } },
    );
    const submitted = vi.fn((event: Event) => event.preventDefault());
    byTag("pw").form?.addEventListener("submit", submitted);
    await command({ ...fill, entryUrl: location.href, entryHost: location.host });
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on a page without login fields", async () => {
    await setup("checkout-card.html", (request) => (request.type === "hello" ? hello([entry]) : { ok: true, value: credentials }));
    await expect(command({ ...fill, entryUrl: location.href, entryHost: location.host })).resolves.toBe(noReply);
    expect(ofType("fillFromPage")).toEqual([]);
  });

  it("passes on the worker's refusal", async () => {
    const locked = { ok: false, error: { kind: "locked", reason: "" } };
    await setup("login-basic.html", (request) => (request.type === "hello" ? hello([entry]) : locked));
    await expect(command({ ...fill, entryUrl: location.href, entryHost: location.host })).resolves.toEqual(locked);
    expect(byTag("pw").value).toBe("");
  });

  it("asks for a reload when the worker can't be reached", async () => {
    await setup("login-basic.html", (request) => {
      if (request.type === "fillFromPage") {
        throw new Error("Extension context invalidated.");
      }
      return hello([entry]);
    });
    await expect(command({ ...fill, entryUrl: location.href, entryHost: location.host })).resolves.toEqual({
      ok: false,
      error: { kind: "refused", reason: expect.stringContaining("Reload") as unknown },
    });
  });

  it("ignores a top URL from the worker; the top frame is its own top", async () => {
    await setup("login-basic.html", (request) => (request.type === "hello" ? hello([entry]) : { ok: true, value: credentials }));
    const reply = await command({ ...fill, entryUrl: location.href, entryHost: location.host, topUrl: "https://evil.example/" });
    expect(reply).toEqual({ ok: true, value: null });
  });
});

// jsdom has no location.ancestorOrigins, so these frames take the Firefox path and trust the worker's top URL.
describe("the popup's Fill in a child frame", () => {
  const worker: Worker = (request) => (request.type === "hello" ? hello([entry]) : { ok: true, value: credentials });

  it("stays quiet when the frame isn't on the entry's site, leaving the answer to another frame", async () => {
    await setup("login-basic.html", worker, { framed: true });
    const reply = await command({ type: "fill", entryId: 7, entryUrl: "https://github.com/login", entryHost: "github.com", topUrl: "https://github.com/" });
    expect(reply).toBe(noReply);
    expect(ofType("fillFromPage")).toEqual([]);
    expect(byTag("pw").value).toBe("");
  });

  it("refuses when the entry's site is framed by another site", async () => {
    await setup("login-basic.html", worker, { framed: true });
    const reply = await command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host, topUrl: "https://evil.example/" });
    expect(reply).toEqual({ ok: false, error: { kind: "refused", reason: expect.any(String) as unknown } });
    expect(ofType("fillFromPage")).toEqual([]);
    expect(byTag("pw").value).toBe("");
  });

  it("refuses when nobody vouched for the top URL", async () => {
    await setup("login-basic.html", worker, { framed: true });
    const reply = await command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host });
    expect(reply).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect(ofType("fillFromPage")).toEqual([]);
  });

  it("asks the worker when both the frame and its top are on the entry's site", async () => {
    await setup("login-basic.html", worker, { framed: true });
    const reply = await command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host, topUrl: location.origin });
    expect(reply).toEqual({ ok: true, value: null });
    expect(ofType("fillFromPage")).toEqual([{ type: "fillFromPage", entryId: 7 }]);
    expect(byTag("pw").value).toBe("hunter2!");
  });
});

describe("the shortcut's picker", () => {
  it("leaves the reply to another frame when nothing here has a button", async () => {
    await setup("login-basic.html", (request) => (request.type === "hello" ? hello([]) : null));
    await expect(command({ type: "openPicker" })).resolves.toBe(noReply);
    expect(opened).toEqual([]);
  });

  it("opens the focused field's picker first", async () => {
    await setup("otp-autocomplete.html", (request) => (request.type === "hello" ? hello([entry]) : null));
    byTag("code").focus();
    await expect(command({ type: "openPicker" })).resolves.toEqual({ ok: true, value: null });
    expect(opened).toEqual([byTag("code")]);
  });
});

describe("a generated password from the context menu", () => {
  it("fills the focused password field", async () => {
    await setup("login-basic.html", () => null);
    byTag("pw").focus();
    await expect(command({ type: "fillGenerated", password: "Gen3rated!pw" })).resolves.toEqual({ ok: true, value: null });
    expect(byTag("pw").value).toBe("Gen3rated!pw");
  });

  it("fills both new-password fields of a sign-up in the top frame", async () => {
    await setup("signup-marked.html", () => null);
    await expect(command({ type: "fillGenerated", password: "Gen3rated!pw" })).resolves.toEqual({ ok: true, value: null });
    expect([byTag("pw").value, byTag("confirm").value]).toEqual(["Gen3rated!pw", "Gen3rated!pw"]);
  });

  it("leaves an unfocused child frame alone", async () => {
    await setup("signup-marked.html", () => null, { framed: true });
    await expect(command({ type: "fillGenerated", password: "Gen3rated!pw" })).resolves.toBe(noReply);
    expect(byTag("pw").value).toBe("");
  });

  it("does nothing when focus isn't on a password field", async () => {
    await setup("login-basic.html", () => null);
    byTag("user").focus();
    await expect(command({ type: "fillGenerated", password: "Gen3rated!pw" })).resolves.toBe(noReply);
    expect([byTag("user").value, byTag("pw").value]).toEqual(["", ""]);
  });
});

describe("inline buttons", () => {
  it("fills a one-time code picked from the button", async () => {
    await setup("otp-autocomplete.html", (request) =>
      request.type === "hello" ? hello([entry]) : { ok: true, value: { code: "287082", secondsLeft: 12 } },
    );
    expect(attached.map((found) => found.field)).toEqual([byTag("code")]);
    await expect(attached[0]?.onPick(entry)).resolves.toBeNull();
    expect(ofType("otpFromPage")).toEqual([{ type: "otpFromPage", entryId: 7 }]);
    expect(byTag("code").value).toBe("287082");
  });

  it("says the vault is locked instead of filling a code", async () => {
    await setup("otp-autocomplete.html", (request) =>
      request.type === "hello" ? hello([entry]) : { ok: false, error: { kind: "locked", reason: "" } },
    );
    const text = await attached[0]?.onPick(entry);
    expect(text).toEqual(expect.stringMatching(/lock/i));
    expect(byTag("code").value).toBe("");
  });

  it("offers a generated password on a sign-up even with no saved logins", async () => {
    await setup("signup-marked.html", (request) =>
      request.type === "hello" ? hello([]) : { ok: true, value: "Sugg3sted!password" },
    );
    expect(attached.map((found) => found.field)).toEqual([byTag("pw"), byTag("confirm")]);
    await expect(attached[0]?.onSuggest?.()).resolves.toBeNull();
    expect(ofType("generateForPage")).toEqual([{ type: "generateForPage", length: 20 }]);
    expect([byTag("pw").value, byTag("confirm").value]).toEqual(["Sugg3sted!password", "Sugg3sted!password"]);
  });

  it("shows why a password couldn't be generated", async () => {
    await setup("signup-marked.html", (request) =>
      request.type === "hello" ? hello([]) : { ok: false, error: { kind: "rateLimited" } },
    );
    await expect(attached[0]?.onSuggest?.()).resolves.toEqual(expect.any(String));
    expect(byTag("pw").value).toBe("");
  });

  it("offers nothing on a sign-up when not signed in to a Quark", async () => {
    await setup("signup-marked.html", (request) => (request.type === "hello" ? hello([], false) : null));
    expect(attached).toEqual([]);
  });

  it("adds no buttons when the worker doesn't answer hello", async () => {
    await setup("login-basic.html", (request) => {
      if (request.type === "hello") {
        throw new Error("no worker");
      }
      return null;
    });
    expect(attached).toEqual([]);
  });

  it("decorates login fields that appear after the page loads", async () => {
    await setup("checkout-card.html", (request) => (request.type === "hello" ? hello([entry]) : null));
    expect(attached).toEqual([]);
    document.body.insertAdjacentHTML("beforeend", '<form><input type="password" autocomplete="current-password" data-fx="late"></form>');
    await vi.waitFor(() => expect(attached.map((found) => found.field)).toEqual([byTag("late")]), { timeout: 2000 });
  });

  it("tells the worker when an input gets focus, so the context menu can follow", async () => {
    await setup("login-basic.html", (request) => (request.type === "hello" ? hello([]) : null));
    byTag("user").focus();
    expect(ofType("fieldFocused")).toHaveLength(1);
  });
});

describe("capturing a login to offer saving it", () => {
  const typeLogin = (): void => {
    byTag("user").value = "alice@example.com";
    byTag("pw").value = "typed-pass";
  };

  const capturing: Worker = (request) => {
    switch (request.type) {
      case "hello":
        return hello([]);
      case "captured":
        return offer;
      case "resolveSave":
        return { ok: true, value: null };
      default:
        return null;
    }
  };

  const submitForm = (): void => {
    const form = byTag("pw").form;
    form?.addEventListener("submit", (event) => event.preventDefault());
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };

  it("sends the typed login on submit and shows the save bar", async () => {
    await setup("login-basic.html", capturing);
    typeLogin();
    submitForm();
    await settle();
    expect(ofType("captured")).toEqual([{ type: "captured", username: "alice@example.com", password: "typed-pass" }]);
    expect(bars.map((bar) => bar.offer)).toEqual([offer]);
  });

  it("sends the same login only once", async () => {
    await setup("login-basic.html", capturing);
    typeLogin();
    submitForm();
    submitForm();
    await settle();
    expect(ofType("captured")).toHaveLength(1);
  });

  it("captures on Enter in the password field", async () => {
    await setup("login-basic.html", capturing);
    typeLogin();
    byTag("pw").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(ofType("captured")).toHaveLength(1);
  });

  it("captures on a click on the sign-in button", async () => {
    await setup("login-basic.html", capturing);
    typeLogin();
    byTag("pw").form?.addEventListener("submit", (event) => event.preventDefault());
    document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await settle();
    expect(ofType("captured")).toHaveLength(1);
  });

  it("ignores Enter in a field that isn't a password", async () => {
    await setup("login-basic.html", capturing);
    typeLogin();
    byTag("user").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(ofType("captured")).toEqual([]);
  });

  it("never captures in a child frame", async () => {
    await setup("login-basic.html", capturing, { framed: true });
    typeLogin();
    submitForm();
    await settle();
    expect(ofType("captured")).toEqual([]);
  });

  it("shows no bar when the worker has nothing to offer", async () => {
    await setup("login-basic.html", (request) => (request.type === "hello" ? hello([]) : null));
    typeLogin();
    submitForm();
    await settle();
    expect(ofType("captured")).toHaveLength(1);
    expect(bars).toEqual([]);
  });

  it("passes the bar's choice to the worker", async () => {
    await setup("login-basic.html", capturing);
    typeLogin();
    submitForm();
    await settle();
    await expect(bars[0]?.onAction("save")).resolves.toBeNull();
    expect(ofType("resolveSave")).toEqual([{ type: "resolveSave", action: "save" }]);
  });

  it("shows the worker's reason when saving fails", async () => {
    await setup("login-basic.html", (request) =>
      request.type === "resolveSave" ? { ok: false, error: { kind: "refused", reason: "Gone." } } : capturing(request),
    );
    typeLogin();
    submitForm();
    await settle();
    await expect(bars[0]?.onAction("save")).resolves.toBe("Gone.");
  });

  it("asks for the tab's offer after a navigation", async () => {
    await setup("login-basic.html", (request) => (request.type === "myOffer" ? offer : capturing(request)));
    await expect(command({ type: "offerCheck" })).resolves.toEqual({ ok: true, value: null });
    await settle();
    expect(ofType("myOffer")).toHaveLength(1);
    expect(bars.map((bar) => bar.offer)).toEqual([offer]);
  });
});
