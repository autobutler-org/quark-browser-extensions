import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeI18n } from "./fakeChrome";
import type { Request } from "../src/shared/messages";
import type { SiteMatch } from "../src/shared/host";
import { defaultSettings, ok, type EntrySummary, type VaultState } from "../src/shared/types";

// The popup talks to the worker only through ask(), so the tests answer for it.
const worker = vi.hoisted(
  (): { state: unknown; welcomeSeen: boolean; sent: Request[]; refuseFill: string; entries: EntrySummary[]; fallbacks: SiteMatch[] } => ({
    state: null,
    welcomeSeen: true,
    sent: [],
    refuseFill: "",
    entries: [],
    fallbacks: [],
  }),
);
vi.mock("../src/shared/messages", () => ({
  ask: (request: Request) => {
    worker.sent.push(request);
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
      return ok(worker.entries);
    case "matches":
      return ok([match(1, "Work mail"), match(3, "Old work mail"), ...worker.fallbacks]);
    case "pendingOffer":
      return null;
    case "reveal":
      return ok({ username: "ana", password: "hunter2" });
    case "otp":
      return ok({ code: "123456", secondsLeft: 20 });
    case "fillInTab":
    case "fillAnyway":
      return worker.refuseFill === "" ? ok(null) : { ok: false, error: { kind: "refused", reason: worker.refuseFill } };
    case "generate":
      return ok("generated-password");
    case "unlock":
      return { ok: false, error: { kind: "badMasterPassword" } };
    default:
      return undefined;
  }
};

const unlocked: VaultState = { kind: "unlocked", server: "https://quark.local", autoLockSeconds: 0 };

let tabUrl = "https://example.com/login";

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
    i18n: fakeI18n(),
    runtime: { getURL: (path: string) => `chrome-extension://quark/${path}`, openOptionsPage: () => Promise.resolve() },
    tabs: { query: () => Promise.resolve([{ id: 7, url: tabUrl }]), create: () => Promise.resolve(), getCurrent: () => Promise.resolve(undefined) },
    commands: { getAll: () => Promise.resolve([]) },
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) },
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: (copied: string) => Promise.resolve(void clipboard.push(copied)) }, configurable: true });
  vi.stubGlobal("close", () => undefined);
});

const clipboard: string[] = [];

beforeEach(() => {
  worker.entries = [entry(1, "Work mail", "example.com"), entry(2, "Bank", "bank.test")];
});

afterEach(() => {
  worker.welcomeSeen = true;
  worker.sent = [];
  worker.refuseFill = "";
  worker.fallbacks = [];
  clipboard.length = 0;
  tabUrl = "https://example.com/login";
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

  // Chrome sizes the toolbar popup from its content, and the viewport is tiny while it measures, so a width tied
  // to the viewport collapses the popup to a sliver (#135).
  it("never ties the popup's own width to the viewport (#135)", () => {
    const rootRules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*((?:html|body|:root)[^{]*)\{([^}]*)\}/g)];
    expect(rootRules.length).toBeGreaterThan(0);
    for (const [, , selector = "", body = ""] of rootRules) {
      if (selector.includes("[data-in-tab]")) {
        continue;
      }
      expect(body, selector).not.toMatch(/width:[^;]*\dv(w|i|min|max)\b/);
      expect(body, selector).not.toMatch(/width:\s*(auto|[\d.]+%)/);
    }
    expect(rule("body")).toMatch(/(^|[^-])width:\s*360px/);
  });

  it("reflows below 360px instead of scrolling sideways when open in a tab (#108)", () => {
    expect(rule(":root[data-in-tab] body")).toMatch(/(^|[^-])width:\s*auto/);
    expect(rule(".brand")).toMatch(/min-width:\s*0/);
    expect(rule(".brand-name")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".status")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("lets a banner's title wrap, but not its buttons (#104)", () => {
    expect(rule(".banner .name")).toMatch(/white-space:\s*normal/);
    expect(rule(".banner .link")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".banner .link")).toMatch(/flex-shrink:\s*0/);
  });

  it("spaces out the Fill anyway warning, and wraps a long host in its button (#105)", () => {
    expect(rule(".confirm")).toMatch(/flex-direction:\s*column/);
    expect(rule(".confirm")).toMatch(/gap:/);
    expect(rule(".confirm-actions")).toMatch(/gap:/);
    expect(rule(".confirm-actions")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".confirm .primary")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("truncates an entry's host like its name (#106)", () => {
    expect(rule(".host")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".host")).toMatch(/white-space:\s*nowrap/);
  });
});

describe("all entries", () => {
  const fills = (): readonly Request[] => worker.sent.filter((request) => request.type === "fillInTab" || request.type === "fillAnyway");
  const row = (app: HTMLElement, name: string): HTMLElement =>
    [...app.querySelectorAll<HTMLElement>(".list .row")].find((element) => element.querySelector(".name")?.textContent === name)!;

  it("copies an entry's username, password or one-time code", async () => {
    const app = await openPopup(unlocked);
    button(app, "Copy username for Bank").click();
    await vi.waitFor(() => expect(app.querySelector(".notice")?.textContent).toBe("Copied the username for Bank"));
    button(app, "Copy password for Bank").click();
    await vi.waitFor(() => expect(app.querySelector(".notice")?.textContent).toBe("Copied the password for Bank"));
    button(app, "Copy one-time code for Bank").click();
    await vi.waitFor(() => expect(app.querySelector(".notice")?.textContent).toBe("Copied the code for Bank. It changes in 20s."));
    expect(clipboard).toEqual(["ana", "hunter2", "123456"]);
  });

  it("offers a one-time code only for entries not known to lack one (#103)", async () => {
    worker.entries = [{ ...entry(2, "Bank", "bank.test"), hasTotp: false }, { ...entry(4, "Shop", "shop.test"), hasTotp: true }, entry(5, "Forum", "forum.test")];
    const app = await openPopup(unlocked);
    const codeButtons = [...app.querySelectorAll(".list button")].map((found) => found.getAttribute("aria-label")).filter((label) => label?.startsWith("Copy one-time code"));
    expect(codeButtons).toEqual(["Copy one-time code for Forum", "Copy one-time code for Shop"]);
  });

  it("fills an entry that matches this page with one click", async () => {
    const app = await openPopup(unlocked);
    expect(row(app, "Work mail").querySelector(".fill")?.textContent).toBe("Fill");
    row(app, "Work mail").querySelector<HTMLButtonElement>(".fill")!.click();
    await vi.waitFor(() => expect(fills()).toEqual([{ type: "fillInTab", tabId: 7, entryId: 1 }]));
  });

  it("asks before filling an entry saved for another site, naming both hosts", async () => {
    const app = await openPopup(unlocked);
    const fillAnyway = button(app, "Fill anyway Bank");
    expect(fillAnyway.getAttribute("aria-expanded")).toBe("false");
    fillAnyway.click();
    await settle();
    expect(fills()).toEqual([]);
    const warning = app.querySelector<HTMLElement>("#fill-anyway-2")!;
    expect(warning.getAttribute("role")).toBe("alert");
    expect(warning.textContent).toContain("Bank is saved for bank.test, not example.com.");
    expect(warning.textContent).toContain("gives its username and password to example.com");
    expect(warning.textContent).not.toContain("plain http");
    expect(button(app, "Fill anyway Bank").getAttribute("aria-expanded")).toBe("true");

    button(app, "Fill on example.com").click();
    await vi.waitFor(() => expect(fills()).toEqual([{ type: "fillAnyway", tabId: 7, entryId: 2, pageHost: "example.com" }]));
  });

  it("asks before filling a login saved for another port on this host, naming where it was saved", async () => {
    worker.fallbacks = [{ ...match(4, "Admin"), kind: "otherPort", where: "example.com:8443", note: "Different port" }];
    worker.entries = [...worker.entries, entry(4, "Admin", "example.com")];
    const app = await openPopup(unlocked);
    const card = [...app.querySelectorAll<HTMLElement>(".match")].find((found) => found.textContent?.includes("Admin"))!;
    const fill = card.querySelector<HTMLButtonElement>(".fill")!;
    expect(fill.getAttribute("aria-label")).toBe("Fill anyway Admin");
    fill.click();
    await settle();
    expect(fills()).toEqual([]);
    expect(app.querySelectorAll("#fill-anyway-4")).toHaveLength(1);
    expect(app.querySelector("#fill-anyway-4")?.textContent).toContain("Admin is saved for example.com:8443, not example.com.");
    button(app, "Fill on example.com").click();
    await vi.waitFor(() => expect(fills()).toEqual([{ type: "fillAnyway", tabId: 7, entryId: 4, pageHost: "example.com" }]));
  });

  it("fills nothing when the warning is cancelled", async () => {
    const app = await openPopup(unlocked);
    button(app, "Fill anyway Bank").click();
    await settle();
    button(app, "Cancel").click();
    await settle();
    expect(app.querySelector("#fill-anyway-2")).toBeNull();
    expect(fills()).toEqual([]);
  });

  it("keeps the warning open while the search narrows the list", async () => {
    const app = await openPopup(unlocked);
    button(app, "Fill anyway Bank").click();
    await settle();
    const search = app.querySelector<HTMLInputElement>("#search")!;
    search.value = "ban";
    search.dispatchEvent(new Event("input"));
    expect(app.querySelector("#fill-anyway-2")).not.toBeNull();
    expect(app.querySelectorAll(".list .row")).toHaveLength(1);
  });

  it("warns that a plain http page is unencrypted, and names its port", async () => {
    tabUrl = "http://intranet:8080/login";
    const app = await openPopup(unlocked);
    button(app, "Fill anyway Bank").click();
    await settle();
    expect(app.querySelector("#fill-anyway-2")?.textContent).toContain("intranet:8080 uses plain http");
    button(app, "Fill on intranet:8080").click();
    await vi.waitFor(() => expect(fills()).toEqual([{ type: "fillAnyway", tabId: 7, entryId: 2, pageHost: "intranet:8080" }]));
  });

  it("shows the worker's refusal and closes the warning", async () => {
    worker.refuseFill = "This tab is now on evil.example, not example.com. Open the popup again to fill it.";
    const app = await openPopup(unlocked);
    button(app, "Fill anyway Bank").click();
    await settle();
    button(app, "Fill on example.com").click();
    await vi.waitFor(() => expect(app.querySelector(".error-box")?.textContent).toContain("evil.example"));
    expect(app.querySelector("#fill-anyway-2")).toBeNull();
  });

  it("gives truncated names and hosts their full text on hover (#106)", async () => {
    const long = "a-very-long-subdomain-name.with-many-labels.example-company-intranet.co.uk";
    worker.entries = [entry(2, "A really long entry name for the intranet", long)];
    const app = await openPopup(unlocked);
    expect(row(app, "A really long entry name for the intranet").querySelector(".name")?.getAttribute("title")).toBe("A really long entry name for the intranet");
    expect(row(app, "A really long entry name for the intranet").querySelector(".host")?.getAttribute("title")).toBe(long);
  });

  it("scrolls the Fill anyway warning into view when it opens (#105)", async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    const app = await openPopup(unlocked);
    button(app, "Fill anyway Bank").click();
    await settle();
    expect(scrolled).toEqual(["fill-anyway-2"]);
    expect(app.querySelector("#fill-anyway-2 .confirm-actions")?.querySelectorAll("button")).toHaveLength(2);
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it("says when a search finds nothing (#110)", async () => {
    const app = await openPopup(unlocked);
    const search = app.querySelector<HTMLInputElement>("#search")!;
    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    expect(app.querySelector(".list .empty")?.textContent).toContain("No entries match “zzz”");
  });

  it("says when the vault has no entries yet (#110)", async () => {
    worker.entries = [];
    const app = await openPopup(unlocked);
    expect(app.querySelector(".list .empty")?.textContent).toContain("No entries yet");
  });

  it("offers no fill on a page that isn't on the web", async () => {
    tabUrl = "chrome://settings";
    const app = await openPopup(unlocked);
    expect(app.querySelectorAll(".list .fill")).toHaveLength(0);
  });
});

describe("where the popup is open", () => {
  afterEach(() => document.documentElement.removeAttribute("data-in-tab"));

  it("keeps its own width in the toolbar, where it isn't in a tab (#135)", async () => {
    await openPopup(unlocked);
    expect(document.documentElement.hasAttribute("data-in-tab")).toBe(false);
  });

  it("marks itself when it is open in a tab, so it fits a narrow one (#108)", async () => {
    vi.stubGlobal("chrome", { ...chrome, tabs: { ...chrome.tabs, getCurrent: () => Promise.resolve({ id: 9 }) } });
    await openPopup(unlocked);
    await vi.waitFor(() => expect(document.documentElement.hasAttribute("data-in-tab")).toBe(true));
  });
});

describe("the popup's copy", () => {
  it("speaks of the browser, not Chrome, in Chrome and Firefox alike", async () => {
    for (const base of ["chrome-extension://quark/", "moz-extension://quark/"]) {
      vi.stubGlobal("chrome", { ...chrome, runtime: { ...chrome.runtime, getURL: (path: string) => `${base}${path}` } });
      const app = await openPopup({ kind: "disconnected" });
      expect(app.querySelector('label[class="check"]:has(#persist)')?.textContent).toBe("Stay signed in after the browser closes");
      expect(app.textContent).not.toMatch(/Chrome|Firefox/);
    }
  });

  it("titles the window and formats the auto-lock time", async () => {
    const app = await openPopup({ ...unlocked, autoLockSeconds: 900 });
    expect(document.title).toBe("Quark Vault");
    expect(app.querySelector(".status")?.textContent).toContain("Unlocked · auto-locks after 15 min idle");
  });
});

