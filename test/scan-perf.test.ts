import { fakeI18n } from "./fakeChrome";
import type { Request } from "../src/shared/messages";
import type { EntrySummary } from "../src/shared/types";

// Bounds on the work one scan does (#84, #85): document walks, getComputedStyle calls and parent steps.

vi.mock("../src/content/picker", () => ({
  attachPicker: () => ({ open: () => undefined, destroy: () => undefined }),
}));

const entry: EntrySummary = { id: 7, name: "Example", urlHost: "localhost", folderId: null, createdAt: "", updatedAt: "" };

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

type Counts = { walks: number; styles: number; parents: number };

// Loads the content script on the current document and counts what its first scan does.
const scanCounts = async (): Promise<Counts> => {
  vi.stubGlobal("MutationObserver", TrackedObserver);
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      sendMessage: (request: Request) =>
        Promise.resolve(request.type === "hello" ? { settings: { inlineButton: true }, matches: [entry], connected: true } : null),
      onMessage: { addListener: () => undefined },
    },
  });
  vi.resetModules();
  const { main } = await import("../src/content/index");
  const counts: Counts = { walks: 0, styles: 0, parents: 0 };
  const query = Object.getOwnPropertyDescriptor(Document.prototype, "querySelectorAll")?.value as Document["querySelectorAll"];
  const walk = vi.spyOn(Document.prototype, "querySelectorAll").mockImplementation(function (this: Document, selectors: string) {
    if (selectors === "*") {
      counts.walks += 1;
    }
    return query.call(this, selectors);
  });
  const computed = window.getComputedStyle.bind(window);
  const style = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    counts.styles += 1;
    return computed(element, pseudo);
  });
  const { get: parentGetter } = Object.getOwnPropertyDescriptor(Node.prototype, "parentElement") as {
    get: (this: Node) => HTMLElement | null;
  };
  const parent = vi.spyOn(Node.prototype, "parentElement", "get").mockImplementation(function (this: Node) {
    counts.parents += 1;
    return parentGetter.call(this);
  });
  try {
    main();
    await settle();
  } finally {
    walk.mockRestore();
    style.mockRestore();
    parent.mockRestore();
  }
  return counts;
};

const elementCount = (): number => document.querySelectorAll("*").length;

const nested = (depth: number, inner: string): string => "<div>".repeat(depth) + inner + "</div>".repeat(depth);

afterEach(() => {
  observers.splice(0).forEach((observer) => observer.disconnect());
  vi.unstubAllGlobals();
});

describe("one scan's cost", () => {
  it("walks a page with no login form once", async () => {
    document.body.innerHTML = Array.from({ length: 200 }, (_, index) => `<article><p>Story ${index}</p></article>`).join("");
    const counts = await scanCounts();
    expect(counts.walks).toBe(1);
  });

  it("walks the document at most twice on a login page", async () => {
    document.body.innerHTML = '<form><input type="email" name="email"><input type="password"></form>';
    const counts = await scanCounts();
    expect(counts.walks).toBeLessThanOrEqual(2);
  });

  it("reads each element's style at most once per detection pass on a deep login form", async () => {
    document.body.innerHTML = nested(
      300,
      `<form>${'<input type="text" name="field">'.repeat(20)}<input type="email" name="email"><input type="password"></form>`,
    );
    const counts = await scanCounts();
    expect(counts.styles).toBeLessThanOrEqual(2 * elementCount());
  });

  it("keeps parent steps linear in the page for a deep formless login", async () => {
    document.body.innerHTML = nested(
      300,
      `<div>${nested(1, '<input type="email" name="email">')}${nested(1, '<input type="password">')}${'<input type="text">'.repeat(20)}</div>`,
    );
    const counts = await scanCounts();
    expect(counts.parents).toBeLessThanOrEqual(30 * elementCount());
  });

  it("keeps work bounded with many password fields outside a form", async () => {
    document.body.innerHTML =
      Array.from({ length: 40 }, () => '<div><input type="password"></div>').join("") +
      Array.from({ length: 400 }, (_, index) => `<div><input type="text" name="f${index}"></div>`).join("");
    const counts = await scanCounts();
    expect(counts.styles).toBeLessThanOrEqual(2 * elementCount());
    expect(counts.parents).toBeLessThanOrEqual(100 * elementCount());
  });
});
