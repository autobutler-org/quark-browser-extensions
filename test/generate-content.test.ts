import { fakeI18n } from "./fakeChrome";
import type { PageCommand } from "../src/shared/messages";

// The content script's side of the context menu's Generate password (#74). A frame fills only the password
// field the user is on, and only one they can see and reach. It never falls back to another field, so a page
// that embeds a sign-up iframe can't collect the password through its own off-screen new-password pair.

vi.mock("../src/content/picker", () => ({
  attachPicker: () => ({ open: () => undefined, destroy: () => undefined }),
}));

type Listener = (message: PageCommand, sender: { id: string }, reply: (value: unknown) => void) => boolean;

let listener: Listener | undefined;
const topDescriptor = Object.getOwnPropertyDescriptor(window, "top");
const added: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
const addEventListener = document.addEventListener.bind(document);
document.addEventListener = (type: string, handler: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  added.push([type, handler, options]);
  addEventListener(type, handler, options);
};
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

const setup = async (html: string, { framed = false } = {}): Promise<void> => {
  document.body.innerHTML = html;
  if (framed) {
    const parent = {};
    Object.defineProperty(window, "top", { get: () => parent, configurable: true });
  }
  vi.stubGlobal("MutationObserver", TrackedObserver);
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      sendMessage: () => Promise.resolve(null),
      onMessage: { addListener: (found: Listener) => (listener = found) },
    },
  });
  vi.resetModules();
  const { main } = await import("../src/content/index");
  main();
  await settle();
};

const noReply = Symbol("no reply");
const generate = (): Promise<unknown> =>
  new Promise((resolve) => {
    const async = listener?.({ type: "fillGenerated", password: "GEN-SECRET" }, { id: "quark" }, resolve);
    if (async === false) {
      setTimeout(() => resolve(noReply), 0);
    }
  });

const byTag = (name: string): HTMLInputElement => document.querySelector(`[data-fx="${name}"]`) as HTMLInputElement;

// jsdom lays nothing out, so place a field the way a browser would report it.
const placeAt = (field: HTMLElement, left: number, top: number): void => {
  field.getBoundingClientRect = () => ({ left, top, right: left + 160, bottom: top + 24, width: 160, height: 24, x: left, y: top, toJSON: () => ({}) });
};

const signup = `
  <form action="/join">
    <input type="password" autocomplete="new-password" data-fx="pw">
    <input type="password" autocomplete="new-password" data-fx="confirm">
  </form>`;

// evil.example's top page: an embedded sign-up iframe and its own new-password pair moved off-screen.
const evilTop = `
  <iframe src="https://accounts.victim.example/signup" data-fx="frame"></iframe>
  <form style="position:absolute;left:-9999px">
    <input type="password" autocomplete="new-password" data-fx="trap">
    <input type="password" autocomplete="new-password" data-fx="trap2">
  </form>`;

beforeEach(() => {
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

describe("a generated password in the top frame", () => {
  it("doesn't fall back to the page's own new-password fields when focus is in a child frame", async () => {
    await setup(evilTop);
    placeAt(byTag("trap"), -9999, 0);
    placeAt(byTag("trap2"), -9999, 30);
    byTag("frame").focus();
    await expect(generate()).resolves.toBe(noReply);
    expect([byTag("trap").value, byTag("trap2").value]).toEqual(["", ""]);
  });

  it("doesn't fill a sign-up the user isn't on", async () => {
    await setup(signup);
    await expect(generate()).resolves.toBe(noReply);
    expect([byTag("pw").value, byTag("confirm").value]).toEqual(["", ""]);
  });

  it("fills the focused new-password field and its confirmation", async () => {
    await setup(signup);
    byTag("pw").focus();
    await expect(generate()).resolves.toEqual({ ok: true, value: null });
    expect([byTag("pw").value, byTag("confirm").value]).toEqual(["GEN-SECRET", "GEN-SECRET"]);
  });

  it("doesn't fill a focused field moved off-screen", async () => {
    await setup(evilTop);
    placeAt(byTag("trap"), -9999, 0);
    byTag("trap").focus();
    await expect(generate()).resolves.toBe(noReply);
    expect(byTag("trap").value).toBe("");
  });

  it("doesn't fill a focused field below or right of the viewport", async () => {
    await setup(signup);
    placeAt(byTag("pw"), 0, window.innerHeight + 5000);
    byTag("pw").focus();
    await expect(generate()).resolves.toBe(noReply);
    placeAt(byTag("pw"), window.innerWidth + 5000, 0);
    await expect(generate()).resolves.toBe(noReply);
    expect(byTag("pw").value).toBe("");
  });

  it("doesn't fill a focused honeypot kept out of keyboard reach", async () => {
    await setup(`<input type="password" autocomplete="new-password" tabindex="-1" data-fx="pw">`);
    byTag("pw").focus();
    await expect(generate()).resolves.toBe(noReply);
    expect(byTag("pw").value).toBe("");
  });

  it("doesn't fill a focused field hidden from view", async () => {
    await setup(`<div style="visibility:hidden"><input type="password" data-fx="pw"></div>`);
    byTag("pw").focus();
    await expect(generate()).resolves.toBe(noReply);
    expect(byTag("pw").value).toBe("");
  });
});

describe("a generated password in a child frame", () => {
  it("fills the focused field of the frame the user clicked", async () => {
    await setup(signup, { framed: true });
    byTag("pw").focus();
    await expect(generate()).resolves.toEqual({ ok: true, value: null });
    expect([byTag("pw").value, byTag("confirm").value]).toEqual(["GEN-SECRET", "GEN-SECRET"]);
  });

  it("stays quiet with nothing focused", async () => {
    await setup(signup, { framed: true });
    await expect(generate()).resolves.toBe(noReply);
    expect(byTag("pw").value).toBe("");
  });
});
