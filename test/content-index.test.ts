import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeI18n } from "./fakeChrome";
import type { PageCommand, Request } from "../src/shared/messages";
import type { EntrySummary } from "../src/shared/types";

// The content script's inline button wiring, with the picker stubbed out and the worker faked through chrome.runtime.

type Attached = Readonly<{
  field: HTMLInputElement;
  matches: readonly EntrySummary[];
  onPick: (entry: EntrySummary) => Promise<string | null>;
  onSuggest?: (() => Promise<string | null>) | undefined;
}>;

const attached: Attached[] = [];
const opened: HTMLInputElement[] = [];
const destroyed: HTMLInputElement[] = [];
vi.mock("../src/content/picker", () => ({
  attachPicker: (field: HTMLInputElement, matches: readonly EntrySummary[], _host: string, handlers: Attached) => {
    attached.push({ field, matches, onPick: handlers.onPick, onSuggest: handlers.onSuggest });
    return { open: () => void opened.push(field), destroy: () => void destroyed.push(field) };
  },
}));

const entry: EntrySummary = { id: 7, name: "Example", urlHost: "localhost", folderId: null, url: "", updatedAt: "" };

// Each test loads the content script afresh; disconnect the earlier copies' observers and cancel the scans they
// have queued, so they don't rescan the next test's page.
const observers: MutationObserver[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
const realSetTimeout = setTimeout;
const listeners: (() => void)[] = [];
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

let listener: ((message: PageCommand, sender: { id: string }, reply: (value: unknown) => void) => boolean) | undefined;
const sent: Request[] = [];

const setup = async (fixture: string, worker: Worker): Promise<void> => {
  document.body.innerHTML = readFileSync(join(import.meta.dirname, "fixtures", "forms", fixture), "utf8");
  vi.stubGlobal("MutationObserver", TrackedObserver);
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      sendMessage: (request: Request) => {
        sent.push(request);
        return Promise.resolve(worker(request));
      },
      onMessage: { addListener: (added: typeof listener) => (listener = added) },
    },
  });
  vi.stubGlobal("setTimeout", (...args: Parameters<typeof setTimeout>) => {
    const timer = realSetTimeout(...args);
    timers.push(timer);
    return timer;
  });
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((...args: Parameters<typeof document.addEventListener>) => {
    listeners.push(() => document.removeEventListener(...args));
    add(...args);
  });
  vi.resetModules();
  const { main } = await import("../src/content/index");
  main();
  await settle();
};

const hello = (matches: readonly EntrySummary[], connected = true) => ({
  settings: { inlineButton: true },
  matches,
  connected,
});

const credentials = { username: "alice@example.com", password: "hunter2!", autoSubmit: false };

const byTag = (name: string): HTMLInputElement => document.querySelector(`[data-fx="${name}"]`) as HTMLInputElement;

const command = (message: PageCommand): Promise<unknown> =>
  new Promise((resolve) => {
    const async = listener?.(message, { id: "quark" }, resolve);
    if (async === false) {
      setTimeout(() => resolve(undefined), 0);
    }
  });

beforeEach(() => {
  attached.length = 0;
  opened.length = 0;
  destroyed.length = 0;
  sent.length = 0;
  listener = undefined;
});

afterEach(() => {
  observers.splice(0).forEach((observer) => observer.disconnect());
  timers.splice(0).forEach((timer) => clearTimeout(timer));
  listeners.splice(0).forEach((remove) => remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("inline button on the identifier step of a two-step login", () => {
  it("attaches to the email field when the site has matches", async () => {
    await setup("two-step-identifier.html", (request) => (request.type === "hello" ? hello([entry]) : null));
    expect(attached.map((found) => found.field)).toEqual([byTag("user")]);
    expect(attached[0]?.matches).toEqual([entry]);
  });

  it("stays off the email field when nothing matches this host", async () => {
    await setup("two-step-identifier-unmarked.html", (request) => (request.type === "hello" ? hello([]) : null));
    expect(attached).toEqual([]);
  });

  it("stays off when the inline button is turned off", async () => {
    await setup("two-step-identifier.html", (request) =>
      request.type === "hello" ? { ...hello([entry]), settings: { inlineButton: false } } : null,
    );
    expect(attached).toEqual([]);
  });

  it("asks the worker for the credentials and fills only the username", async () => {
    await setup("two-step-identifier-hidden-password.html", (request) =>
      request.type === "hello" ? hello([entry]) : { ok: true, value: credentials },
    );
    await expect(attached[0]?.onPick(entry)).resolves.toBeNull();
    expect(sent.filter((request) => request.type === "fillFromPage")).toEqual([{ type: "fillFromPage", entryId: 7 }]);
    expect([byTag("user").value, byTag("pw").value]).toEqual(["alice@example.com", ""]);
  });

  it("shows the worker's refusal and fills nothing when the host doesn't fit", async () => {
    await setup("two-step-identifier.html", (request) =>
      request.type === "hello"
        ? hello([entry])
        : { ok: false, error: { kind: "refused", reason: "This login doesn't belong to this site." } },
    );
    await expect(attached[0]?.onPick(entry)).resolves.toBe("This login doesn't belong to this site.");
    expect(byTag("user").value).toBe("");
  });

  it("opens the identifier's picker from the shortcut", async () => {
    await setup("two-step-identifier.html", (request) => (request.type === "hello" ? hello([entry]) : null));
    await expect(command({ type: "openPicker" })).resolves.toEqual({ ok: true, value: null });
    expect(opened).toEqual([byTag("user")]);
  });

  it("answers the popup's Fill on the identifier step through the worker's checked path", async () => {
    await setup("two-step-identifier.html", (request) =>
      request.type === "hello" ? hello([entry]) : { ok: true, value: credentials },
    );
    const reply = await command({ type: "fill", entryId: 7, entryUrl: location.href, entryHost: location.host });
    expect(reply).toEqual({ ok: true, value: null });
    expect(sent.filter((request) => request.type === "fillFromPage")).toEqual([{ type: "fillFromPage", entryId: 7 }]);
    expect(byTag("user").value).toBe("alice@example.com");
  });

  it("refuses the popup's Fill for another site's login without asking for credentials", async () => {
    await setup("two-step-identifier.html", (request) =>
      request.type === "hello" ? hello([entry]) : { ok: true, value: credentials },
    );
    const reply = await command({ type: "fill", entryId: 7, entryUrl: "https://example.com/login", entryHost: "example.com" });
    expect(reply).toEqual({ ok: false, error: { kind: "refused", reason: "This login doesn't belong to this site." } });
    expect(sent.some((request) => request.type === "fillFromPage")).toBe(false);
    expect(byTag("user").value).toBe("");
  });
});

describe("picking a login for a field the page has since hidden (#129)", () => {
  const worker: Worker = (request) => (request.type === "hello" ? hello([entry]) : { ok: true, value: credentials });

  it.each([
    ["opacity: 0", "opacity: 0"],
    ["1px", "width: 1px; height: 1px"],
    ["clip-path: inset(50%)", "clip-path: inset(50%)"],
  ])("refuses a password field given %s after the picker opened, without asking for the login", async (_, style) => {
    await setup("login-basic.html", worker);
    byTag("pw").setAttribute("style", style);
    if (style.includes("1px")) {
      Object.defineProperty(Element.prototype, "checkVisibility", { value: () => true, configurable: true });
      vi.spyOn(byTag("pw"), "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 8, y: 8, width: 1, height: 1 }));
      vi.spyOn(byTag("user"), "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 8, y: 40, width: 200, height: 30 }));
    }
    try {
      await expect(attached.find((found) => found.field === byTag("pw"))?.onPick(entry)).resolves.toBe("Couldn't find the login fields on this page.");
    } finally {
      delete (Element.prototype as Partial<Element>).checkVisibility;
      vi.restoreAllMocks();
    }
    expect(sent.some((request) => request.type === "fillFromPage")).toBe(false);
    expect([byTag("user").value, byTag("pw").value]).toEqual(["", ""]);
  });

  it("refuses a field hidden while the login was on its way, and fills nothing", async () => {
    await setup("login-basic.html", (request) => {
      if (request.type === "fillFromPage") {
        byTag("pw").style.opacity = "0";
      }
      return worker(request);
    });
    await expect(attached.find((found) => found.field === byTag("pw"))?.onPick(entry)).resolves.toBe("Couldn't find the login fields on this page.");
    expect([byTag("user").value, byTag("pw").value]).toEqual(["", ""]);
  });

  it("still fills the field when the page left it alone", async () => {
    await setup("login-basic.html", worker);
    await expect(attached.find((found) => found.field === byTag("pw"))?.onPick(entry)).resolves.toBeNull();
    expect([byTag("user").value, byTag("pw").value]).toEqual(["alice@example.com", "hunter2!"]);
  });
});

describe("single-step forms keep their buttons", () => {
  it("decorates the password field and not the username", async () => {
    await setup("login-basic.html", (request) => (request.type === "hello" ? hello([entry]) : null));
    expect(attached.map((found) => found.field)).toEqual([byTag("pw")]);
  });

  it("decorates nothing on a page without login fields", async () => {
    await setup("checkout-card.html", (request) => (request.type === "hello" ? hello([entry]) : null));
    expect(attached).toEqual([]);
  });
});

// Past the 400 ms a scan waits after the page changes, then long enough for the scan to finish.
const rescan = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 450));
  await settle();
};

describe("a sign-up form revealed after load (#152)", () => {
  const worker: Worker = (request) => (request.type === "hello" ? hello([entry]) : null);

  it("gives the revealed sign-up tab the Suggest strong password picker, not the logins", async () => {
    await setup("login-signup-tabs.html", worker);
    expect(attached.map((found) => found.field)).toEqual([byTag("login-pw")]);
    byTag("signin-panel").hidden = true;
    byTag("signup-panel").hidden = false;
    await rescan();
    const signup = attached.filter((found) => found.field === byTag("signup-pw") || found.field === byTag("signup-confirm"));
    expect(signup.map((found) => found.field)).toEqual([byTag("signup-pw"), byTag("signup-confirm")]);
    expect(signup.map((found) => [found.matches, typeof found.onSuggest])).toEqual([
      [[], "function"],
      [[], "function"],
    ]);
  });

  it("reclassifies a field already given the login picker once an attribute change makes it a new password", async () => {
    await setup("login-signup-toggle.html", worker);
    expect(attached.map((found) => [found.field, typeof found.onSuggest])).toEqual([[byTag("pw"), "undefined"]]);
    byTag("confirm").hidden = false;
    await rescan();
    expect(destroyed).toEqual([byTag("pw")]);
    expect(attached.slice(1).map((found) => [found.field, found.matches, typeof found.onSuggest])).toEqual([
      [byTag("pw"), [], "function"],
      [byTag("confirm"), [], "function"],
    ]);
  });

  it("leaves a picker alone when a rescan finds its field unchanged", async () => {
    await setup("login-basic.html", worker);
    byTag("user").setAttribute("class", "touched");
    await rescan();
    expect(attached.map((found) => found.field)).toEqual([byTag("pw")]);
    expect(destroyed).toEqual([]);
  });
});

describe("a login modal that fades in (#150)", () => {
  const worker: Worker = (request) => (request.type === "hello" ? hello([entry]) : null);
  // The fade runs in the stylesheet: the page's DOM doesn't change when it ends. jsdom only restyles on a DOM
  // change, so make one and drop the observer's record of it.
  const fadeIn = (): void => {
    byTag("modal").classList.add("shown");
    observers.forEach((observer) => observer.takeRecords());
  };

  it("gives no icon while the modal is transparent and translated, then the icon once its transitions end", async () => {
    await setup("login-modal-fade.html", worker);
    byTag("modal").classList.add("open");
    await rescan();
    expect(attached).toEqual([]);
    fadeIn();
    byTag("modal").dispatchEvent(new Event("transitionend", { bubbles: true }));
    await rescan();
    expect(attached.map((found) => found.field)).toEqual([byTag("pw")]);
  });

  it("rescans when a CSS animation ends", async () => {
    await setup("login-modal-fade.html", worker);
    byTag("modal").classList.add("open");
    await rescan();
    fadeIn();
    byTag("modal").dispatchEvent(new Event("animationend", { bubbles: true }));
    await rescan();
    expect(attached.map((found) => found.field)).toEqual([byTag("pw")]);
  });

  it("rescans when the page's script sets the opacity", async () => {
    await setup("login-modal-fade.html", worker);
    byTag("modal").classList.add("open");
    await rescan();
    byTag("modal").style.opacity = "1";
    await rescan();
    expect(attached.map((found) => found.field)).toEqual([byTag("pw")]);
  });

  it("rescans when a Web Animations fade finishes, which fires no event", async () => {
    let finish = (): void => undefined;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    Object.defineProperty(document, "getAnimations", { value: () => [{ finished }], configurable: true });
    try {
      await setup("login-modal-fade.html", worker);
      byTag("modal").classList.add("open");
      await rescan();
      expect(attached).toEqual([]);
      fadeIn();
      finish();
      await rescan();
      expect(attached.map((found) => found.field)).toEqual([byTag("pw")]);
    } finally {
      delete (document as Partial<Document>).getAnimations;
    }
  });

  it("still gives no icon to the opacity: 0 decoys after a transition ends", async () => {
    await setup("login-decoy-opacity.html", worker);
    document.body.dispatchEvent(new Event("transitionend", { bubbles: true }));
    await rescan();
    expect(attached.map((found) => found.field)).toEqual([byTag("pw")]);
  });
});
