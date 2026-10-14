import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request } from "../src/shared/messages";
import type { SiteMatch } from "../src/shared/host";
import { defaultSettings, ok, type EntrySummary, type VaultState } from "../src/shared/types";

// The popup talks to the worker only through ask(), so the tests answer for it.
const worker = vi.hoisted(() => ({ state: null as unknown, welcomeSeen: true }));
vi.mock("../src/shared/messages", () => ({
  ask: (request: Request) => {
    return Promise.resolve(answer(request));
  },
}));

const entry = (id: number, name: string, urlHost: string): EntrySummary => ({ id, name, urlHost, folderId: null, createdAt: "", updatedAt: "" });
const match = (id: number, name: string): SiteMatch => ({ ...entry(id, name, "example.com"), kind: "exact", where: "example.com", note: "" });

const answer = (request: Request): unknown => {
  switch (request.type) {
    case "state":
      return worker.state;
    case "settings":
      return { ...defaultSettings, othersReviewed: true, welcomeSeen: worker.welcomeSeen };
    case "entries":
      return ok([entry(1, "Work mail", "example.com"), entry(2, "Bank", "bank.test")]);
    case "matches":
      return ok([match(1, "Work mail"), match(3, "Old work mail")]);
    case "pendingOffer":
      return null;
    case "reveal":
      return ok({ password: "hunter2" });
    case "generate":
      return ok("generated-password");
    case "unlock":
      return { ok: false, error: { kind: "badMasterPassword" } };
    default:
      return undefined;
  }
};

const unlocked: VaultState = { kind: "unlocked", server: "https://quark.local", autoLockSeconds: 0 };

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const openPopup = async (state: VaultState): Promise<HTMLElement> => {
  worker.state = state;
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  await import("../src/popup/index");
  await vi.waitFor(() => expect(document.querySelector(state.kind === "unlocked" ? "#search" : "h1")).not.toBeNull());
  await settle();
  return document.getElementById("app")!;
};

const button = (app: HTMLElement, name: string): HTMLButtonElement => {
  const found = [...app.querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === name);
  expect(found, name).toBeDefined();
  return found!;
};

beforeEach(() => {
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://quark/${path}`, openOptionsPage: () => Promise.resolve() },
    tabs: { query: () => Promise.resolve([{ id: 7, url: "https://example.com/login" }]), create: () => Promise.resolve() },
    commands: { getAll: () => Promise.resolve([]) },
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) },
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
});

afterEach(() => {
  worker.welcomeSeen = true;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the popup's match cards", () => {
  it("names each Fill button after its entry", async () => {
    const app = await openPopup(unlocked);
    const names = [...app.querySelectorAll(".match .fill")].map((element) => element.getAttribute("aria-label"));
    expect(names).toEqual(["Fill Work mail", "Fill Old work mail"]);
    // The visible text stays "Fill", which the name starts with (WCAG 2.5.3).
    expect([...app.querySelectorAll(".match .fill")].every((element) => element.textContent === "Fill")).toBe(true);
  });
});

describe("focus across re-renders", () => {
  it("starts on the search field", async () => {
    await openPopup(unlocked);
    expect(document.activeElement?.id).toBe("search");
  });

  it("stays on Copy after copying a password, and announces it once", async () => {
    const app = await openPopup(unlocked);
    const copy = button(app, "Copy password for Bank");
    copy.focus();
    copy.click();
    await vi.waitFor(() => expect(app.querySelector(".notice")?.textContent).toBe("Copied the password for Bank"));
    expect(copy.isConnected).toBe(false);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Copy password for Bank");
    const live = [...document.body.querySelectorAll('[role="status"]')].filter((element) => element.textContent === "Copied the password for Bank");
    expect(live).toHaveLength(1);
    expect(app.contains(live[0]!)).toBe(false);
  });

  it("stays on Generate after generating a password", async () => {
    const app = await openPopup(unlocked);
    button(app, "Generate password").focus();
    button(app, "Generate password").click();
    await vi.waitFor(() => expect(app.querySelector(".notice")).not.toBeNull());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Generate password");
  });

  it("keeps the caret in the search field when the view is rebuilt", async () => {
    const app = await openPopup(unlocked);
    const search = app.querySelector<HTMLInputElement>("#search")!;
    search.value = "work";
    search.dispatchEvent(new Event("input"));
    search.setSelectionRange(2, 2);
    button(app, "Generate password").click();
    await vi.waitFor(() => expect(app.querySelector(".notice")).not.toBeNull());
    const rebuilt = document.activeElement as HTMLInputElement;
    expect(rebuilt.id).toBe("search");
    expect(rebuilt).not.toBe(search);
    expect([rebuilt.value, rebuilt.selectionStart]).toEqual(["work", 2]);
  });

  it("goes back to the vault password when Unlock is gone mid-request", async () => {
    const app = await openPopup({ kind: "locked", server: "https://quark.local", reason: "" });
    expect(document.activeElement?.id).toBe("master");
    app.querySelector<HTMLInputElement>("#master")!.value = "wrong";
    const unlock = button(app, "Unlock");
    unlock.focus();
    unlock.click();
    await vi.waitFor(() => expect(app.querySelector(".error-box")).not.toBeNull());
    expect(document.activeElement?.id).toBe("master");
  });

  it("moves to the new screen's heading when the control that had focus is gone", async () => {
    worker.welcomeSeen = false;
    const app = await openPopup({ kind: "disconnected" });
    const read = button(app, "Read");
    read.focus();
    read.click();
    await settle();
    expect(document.activeElement?.tagName).toBe("H1");
    expect(document.activeElement?.textContent).toBe("Welcome to Quark Vault");
  });
});

describe("popup.css", () => {
  const css = readFileSync(join(import.meta.dirname, "../static/popup.css"), "utf8");
  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };

  it("scrolls instead of clipping when zoom leaves less room than the popup's size", () => {
    expect(rule("body")).not.toMatch(/overflow:\s*hidden/);
    expect(rule("body")).toMatch(/overflow:\s*auto/);
  });

  it("lets bars, buttons and the search box grow with the text", () => {
    for (const selector of [".bar", ".search", ".fill", ".status"]) {
      expect(rule(selector)).not.toMatch(/(^|[^-])height:/);
    }
  });

  it("rings the search box when its field has focus", () => {
    expect(rule(".search:focus-within")).toMatch(/outline: 2px solid var\(--focus\)/);
  });
});
