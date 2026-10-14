import { fakeI18n } from "./fakeChrome";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PageCommand, Request } from "../src/shared/messages";
import type { EntrySummary } from "../src/shared/types";

// The content script's inline button wiring, with the picker stubbed out and the worker faked through chrome.runtime.

type Attached = Readonly<{
  field: HTMLInputElement;
  matches: readonly EntrySummary[];
  onPick: (entry: EntrySummary) => Promise<string | null>;
}>;

const attached: Attached[] = [];
const opened: HTMLInputElement[] = [];

vi.mock("../src/content/picker", () => ({
  attachPicker: (field: HTMLInputElement, matches: readonly EntrySummary[], _host: string, handlers: Attached) => {
    attached.push({ field, matches, onPick: handlers.onPick });
    return { open: () => void opened.push(field), destroy: () => undefined };
  },
}));

const entry: EntrySummary = { id: 7, name: "Example", urlHost: "localhost", folderId: null, createdAt: "", updatedAt: "" };

// Each test loads the content script afresh; disconnect the earlier copies' observers so they don't rescan.
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
  sent.length = 0;
  listener = undefined;
});

afterEach(() => {
  observers.splice(0).forEach((observer) => observer.disconnect());
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
