import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeI18n } from "./fakeChrome";
import type { Request } from "../src/shared/messages";
import type { EntrySummary } from "../src/shared/types";

// The content script over a page's life: rescans on a busy page, pickers torn down with their field, and the
// worker's hello asked again while it can't help yet. The real picker, fake timers, the worker faked.

const entry: EntrySummary = { id: 7, name: "Example", urlHost: "localhost", folderId: null, url: "", updatedAt: "" };
const loginForm = readFileSync(join(import.meta.dirname, "fixtures", "forms", "login-basic.html"), "utf8");

const observers: MutationObserver[] = [];
class TrackedObserver extends MutationObserver {
  constructor(callback: MutationCallback) {
    super(callback);
    observers.push(this);
  }
}

type Worker = (request: Request) => unknown;
const sent: Request[] = [];

const hello = (matches: readonly EntrySummary[], connected = true) => ({
  settings: { inlineButton: true },
  matches,
  connected,
});

// Picker hosts are appended straight to <body>; the page itself lives in #app.
const pickerHosts = (): number => [...document.body.children].filter((child) => child.tagName === "DIV" && child.id !== "app").length;

const replaceForm = (): void => {
  const app = document.getElementById("app") as HTMLElement;
  app.innerHTML = loginForm;
};

const start = async (worker: Worker, withForm = true): Promise<void> => {
  document.body.innerHTML = `<div id="app">${withForm ? loginForm : ""}</div>`;
  vi.stubGlobal("MutationObserver", TrackedObserver);
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      sendMessage: (request: Request) => {
        sent.push(request);
        return Promise.resolve().then(() => worker(request));
      },
      onMessage: { addListener: () => undefined },
    },
  });
  vi.resetModules();
  const { main } = await import("../src/content/index");
  main();
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
});

afterEach(() => {
  observers.splice(0).forEach((observer) => observer.disconnect());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("scanning a page that never stops changing (#83)", () => {
  it("attaches a picker to a form added while the page mutates every 100 ms", async () => {
    await start(() => hello([entry]), false);
    const ticker = document.createElement("span");
    document.body.append(ticker);
    const tick = setInterval(() => {
      ticker.textContent = "";
      ticker.append(String(Date.now()));
    }, 100);
    await vi.advanceTimersByTimeAsync(1000);
    (document.getElementById("app") as HTMLElement).innerHTML = loginForm;
    await vi.advanceTimersByTimeAsync(1000);
    clearInterval(tick);
    expect(pickerHosts()).toBeGreaterThan(0);
  });
});

describe("pickers whose field the page removed (#86)", () => {
  it("destroys the old picker and its listeners when an SPA swaps the form", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    await start(() => hello([entry]));
    const initial = pickerHosts();
    expect(initial).toBeGreaterThan(0);
    const scrolls = (spy: typeof added): number => spy.mock.calls.filter(([type]) => type === "scroll").length;
    const liveBefore = scrolls(added) - scrolls(removed);

    for (let swap = 0; swap < 5; swap += 1) {
      replaceForm();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(pickerHosts()).toBe(initial);
    expect(scrolls(added) - scrolls(removed)).toBe(liveBefore);
  });
});

describe("the worker's hello over the tab's life (#87)", () => {
  it("asks again after a locked reply, so a form shown after unlocking gets a picker", async () => {
    let connected = false;
    await start(() => (connected ? hello([entry]) : hello([], false)));
    expect(pickerHosts()).toBe(0);

    connected = true;
    replaceForm();
    await vi.advanceTimersByTimeAsync(1000);

    expect(sent.filter((request) => request.type === "hello").length).toBe(2);
    expect(pickerHosts()).toBeGreaterThan(0);
  });

  it("asks again after a failed request", async () => {
    let fail = true;
    await start(() => {
      if (fail) {
        throw new Error("worker asleep");
      }
      return hello([entry]);
    });
    expect(pickerHosts()).toBe(0);

    fail = false;
    replaceForm();
    await vi.advanceTimersByTimeAsync(1000);

    expect(pickerHosts()).toBeGreaterThan(0);
  });

  it("keeps a connected reply rather than asking on every scan", async () => {
    await start(() => hello([entry]));
    replaceForm();
    await vi.advanceTimersByTimeAsync(1000);
    replaceForm();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.filter((request) => request.type === "hello").length).toBe(1);
  });
});
