import { fakeChrome, fakeI18n, type FakeArea } from "./fakeChrome";
import { accountId } from "../src/shared/authKey";
import { legacyUpgradeNeeded } from "../src/shared/errors";
import type { Request } from "../src/shared/messages";
import type { SaveOffer } from "../src/background/save";
import { defaultSettings, err, ok, type ApiError, type EntrySummary, type Result, type Settings, type VaultState } from "../src/shared/types";

// The popup's screens and flows: connecting (with the plain-http confirmation), the first-run welcome, unlocking
// and locking, the save banner, the site-access and other-managers banners, and the error screens. The worker
// answers through chrome.runtime.sendMessage.

const server = "https://quark.local";
const unlocked: VaultState = { kind: "unlocked", server, autoLockSeconds: 900 };
const locked: VaultState = { kind: "locked", server, reason: "" };

const worker = {
  state: unlocked as VaultState,
  settings: { ...defaultSettings, othersReviewed: true, welcomeSeen: true } as Settings,
  offer: null as SaveOffer | null,
  connect: null as Result<VaultState> | null,
  unlock: null as Result<VaultState> | null,
  generate: ok("generated-pw") as Result<string>,
  otp: ok({ code: "123456", secondsLeft: 9 }) as Result<{ code: string; secondsLeft: number }>,
  resolveSave: ok(null) as Result<null>,
  entries: [] as EntrySummary[],
  asked: [] as Request[],
};

const answer = (request: Request): unknown => {
  worker.asked.push(request);
  switch (request.type) {
    case "state":
      return worker.state;
    case "settings":
      return worker.settings;
    case "saveSettings":
      worker.settings = request.settings;
      return request.settings;
    case "entries":
      return worker.state.kind === "unlocked" ? ok(worker.entries) : err({ kind: "locked", reason: "" });
    case "matches":
      return ok([]);
    case "pendingOffer":
      return worker.offer;
    case "connect":
      return worker.connect ?? ok((worker.state = unlocked));
    case "unlock":
      return worker.unlock ?? ok((worker.state = unlocked));
    case "lock":
      return ok((worker.state = locked));
    case "signOut":
      return ok((worker.state = { kind: "signedOut", server }));
    case "generate":
      return worker.generate;
    case "otp":
      return worker.otp;
    case "resolveSave":
      if (worker.resolveSave.ok) {
        worker.offer = null;
      }
      return worker.resolveSave;
    default:
      return undefined;
  }
};

const browser = {
  url: "chrome-extension://quark/",
  siteAccess: true,
  grantSites: true,
  tabsOpened: [] as string[],
  shortcut: "",
  clipboard: [] as string[],
  closed: 0,
};

let storage: { local: FakeArea; session: FakeArea };

beforeEach(() => {
  Object.assign(worker, {
    state: unlocked,
    settings: { ...defaultSettings, othersReviewed: true, welcomeSeen: true },
    offer: null,
    connect: null,
    unlock: null,
    generate: ok("generated-pw"),
    otp: ok({ code: "123456", secondsLeft: 9 }),
    resolveSave: ok(null),
    entries: [],
    asked: [],
  });
  Object.assign(browser, { url: "chrome-extension://quark/", siteAccess: true, grantSites: true, tabsOpened: [], shortcut: "", clipboard: [], closed: 0 });
  storage = fakeChrome().chrome.storage;
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    storage,
    runtime: {
      getURL: (path: string) => `${browser.url}${path}`,
      openOptionsPage: () => Promise.resolve(),
      sendMessage: (request: Request) => Promise.resolve(answer(request)),
    },
    tabs: {
      query: () => Promise.resolve([{ id: 7, url: "https://example.com/login" }]),
      create: ({ url }: { url: string }) => Promise.resolve(void browser.tabsOpened.push(url)),
    },
    commands: { getAll: () => Promise.resolve([{ name: "fill-login", shortcut: browser.shortcut }]) },
    permissions: {
      contains: () => Promise.resolve(browser.siteAccess),
      request: () => Promise.resolve(browser.grantSites),
    },
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: (copied: string) => Promise.resolve(void browser.clipboard.push(copied)) },
    configurable: true,
  });
  vi.stubGlobal("close", () => void (browser.closed += 1));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const openPopup = async (): Promise<HTMLElement> => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  await import("../src/popup/index");
  await vi.waitFor(() => expect(document.querySelector("h1, #search")).not.toBeNull());
  await settle();
  return document.getElementById("app")!;
};

const buttonNamed = (app: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...app.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent) === name);

const click = async (app: ParentNode, name: string): Promise<void> => {
  const button = buttonNamed(app, name);
  expect(button, name).toBeDefined();
  button?.click();
  await settle();
};

const heading = (app: HTMLElement): string => app.querySelector("h1")?.textContent ?? "";
const alertText = (app: HTMLElement): string => app.querySelector('.error-box[role="alert"]:not([hidden])')?.textContent ?? "";
const asked = (type: Request["type"]) => worker.asked.filter((request) => request.type === type);

const typeInto = (app: HTMLElement, id: string, value: string): void => {
  const input = app.querySelector<HTMLInputElement>(`#${id}`)!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
};

const submitForm = async (app: HTMLElement): Promise<void> => {
  app.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
};

describe("connecting", () => {
  beforeEach(() => {
    worker.state = { kind: "disconnected" };
  });

  it("sends the typed address and login, and opens the vault", async () => {
    const app = await openPopup();
    expect(heading(app)).toBe("Connect to your Quark");
    typeInto(app, "server", "https://quark.local");
    typeInto(app, "username", "admin");
    typeInto(app, "password", "pw");
    app.querySelector<HTMLInputElement>("#persist")!.checked = true;
    await submitForm(app);
    expect(asked("connect")).toEqual([
      { type: "connect", server: "https://quark.local", username: "admin", password: "pw", persist: true, allowInsecure: false },
    ]);
    expect(app.querySelector("#search")).not.toBeNull();
  });

  it("asks for confirmation only for a plain-http address on the network", async () => {
    const app = await openPopup();
    const warning = app.querySelector<HTMLInputElement>("#allow-insecure")!;
    expect(warning.closest<HTMLElement>(".error-box")?.hidden).toBe(true);
    typeInto(app, "server", "http://192.168.1.10:8080");
    expect(warning.closest<HTMLElement>(".error-box")?.hidden).toBe(false);
    expect(warning.required).toBe(true);
    typeInto(app, "server", "http://localhost:8080");
    expect(warning.closest<HTMLElement>(".error-box")?.hidden).toBe(true);
    expect(warning.required).toBe(false);
  });

  it("passes the confirmation on only while the warning shows", async () => {
    const app = await openPopup();
    app.querySelector<HTMLInputElement>("#allow-insecure")!.checked = true;
    typeInto(app, "server", "https://quark.local");
    await submitForm(app);
    expect(asked("connect")[0]).toMatchObject({ allowInsecure: false });
  });

  it("shows why connecting failed and keeps the form", async () => {
    worker.connect = err({ kind: "badCredentials" });
    const app = await openPopup();
    typeInto(app, "server", "https://quark.local");
    await submitForm(app);
    expect(heading(app)).toBe("Connect to your Quark");
    expect(alertText(app)).not.toBe("");
    expect(buttonNamed(app, "Connect")?.disabled).toBe(false);
  });
});

describe("the connect form", () => {
  beforeEach(() => {
    worker.state = { kind: "disconnected" };
  });

  const fill = (app: HTMLElement, address = "quark.local"): void => {
    typeInto(app, "server", address);
    typeInto(app, "username", "admin");
    typeInto(app, "password", "pw");
    app.querySelector<HTMLInputElement>("#persist")!.checked = true;
  };

  it("takes an address without a scheme (#99)", async () => {
    const app = await openPopup();
    const address = app.querySelector<HTMLInputElement>("#server")!;
    expect(address.type).toBe("text");
    expect(address.getAttribute("inputmode")).toBe("url");
    expect(address.getAttribute("spellcheck")).toBe("false");
    fill(app, "192.168.1.20:8080");
    await submitForm(app);
    expect(asked("connect")[0]).toMatchObject({ server: "192.168.1.20:8080", allowInsecure: false });
  });

  it("starts on the address, or on the first empty field after it (#109)", async () => {
    await openPopup();
    expect(document.activeElement?.id).toBe("server");
    worker.state = { kind: "unreachable", server, message: "fetch failed" };
    const unreachable = await openPopup();
    await click(unreachable, "Edit address");
    expect(document.activeElement?.id).toBe("username");
  });

  it("keeps the address, username and Stay signed in after bad credentials, and goes to the password (#98)", async () => {
    worker.connect = err({ kind: "badCredentials" });
    const app = await openPopup();
    fill(app);
    await submitForm(app);
    expect(alertText(app)).toBe("Invalid username or password.");
    expect(app.querySelector<HTMLInputElement>("#server")!.value).toBe("quark.local");
    expect(app.querySelector<HTMLInputElement>("#username")!.value).toBe("admin");
    expect(app.querySelector<HTMLInputElement>("#password")!.value).toBe("");
    expect(app.querySelector<HTMLInputElement>("#persist")!.checked).toBe(true);
    expect(document.activeElement?.id).toBe("password");
  });

  it("keeps the whole form after a network error, goes to the address, and says which address it tried (#98, #100)", async () => {
    worker.connect = err({ kind: "network", message: "fetch failed" });
    const app = await openPopup();
    fill(app);
    await submitForm(app);
    expect(app.querySelector<HTMLInputElement>("#password")!.value).toBe("pw");
    expect(app.querySelector<HTMLInputElement>("#persist")!.checked).toBe(true);
    expect(document.activeElement?.id).toBe("server");
    expect(alertText(app)).toContain("Can't reach your Quark");
    expect(alertText(app)).toContain("Tried https://quark.local");
    expect(alertText(app)).toContain("http://quark.local");
  });

  it("keeps Stay signed in and the password when the Quark asks for a legacy upgrade (#98)", async () => {
    const legacyUpgrade = { server: "https://quark.local", username: "admin" };
    worker.connect = err({ kind: "refused", reason: legacyUpgradeNeeded(legacyUpgrade.server), legacyUpgrade });
    const app = await openPopup();
    fill(app);
    await submitForm(app);
    expect(app.querySelector<HTMLInputElement>("#password")!.value).toBe("pw");
    expect(app.querySelector<HTMLInputElement>("#persist")!.checked).toBe(true);
    expect(document.activeElement?.id).toBe("legacy-upgrade");
  });

  it("keeps the username and Stay signed in when editing an unreachable address (#98)", async () => {
    worker.state = { kind: "unreachable", server, message: "fetch failed" };
    worker.connect = err({ kind: "network", message: "fetch failed" });
    const app = await openPopup();
    await click(app, "Edit address");
    fill(app, "quark.lan");
    await submitForm(app);
    expect(app.querySelector<HTMLInputElement>("#server")!.value).toBe("quark.lan");
    expect(app.querySelector<HTMLInputElement>("#username")!.value).toBe("admin");
    expect(app.querySelector<HTMLInputElement>("#persist")!.checked).toBe(true);
  });
});

describe("a legacy account's one-time upgrade (#76)", () => {
  const legacyUpgrade = { server: "https://quark.local", username: "oldadmin" };

  beforeEach(() => {
    worker.state = { kind: "disconnected" };
    worker.connect = err({ kind: "refused", reason: legacyUpgradeNeeded(legacyUpgrade.server), legacyUpgrade });
  });

  const askedForUpgrade = async (): Promise<HTMLElement> => {
    const app = await openPopup();
    typeInto(app, "server", "quark.local");
    typeInto(app, "username", "oldadmin");
    typeInto(app, "password", "pw");
    await submitForm(app);
    return app;
  };

  it("asks before the password goes, for that server and account, and keeps them in the form", async () => {
    const app = await askedForUpgrade();
    const confirm = app.querySelector<HTMLInputElement>("#legacy-upgrade")!;
    expect(confirm.required).toBe(true);
    expect(confirm.closest<HTMLElement>(".error-box")?.hidden).toBe(false);
    expect(confirm.closest("label")?.textContent).toBe("Send my Quark password to quark.local this one time");
    expect(app.textContent).toContain("needs your Quark password once");
    expect(app.querySelector<HTMLInputElement>("#server")!.value).toBe("https://quark.local");
    expect(app.querySelector<HTMLInputElement>("#username")!.value).toBe("oldadmin");
    expect(storage.session.items.size).toBe(0);
  });

  it("records the consent just before connecting again", async () => {
    const app = await askedForUpgrade();
    worker.connect = null;
    app.querySelector<HTMLInputElement>("#legacy-upgrade")!.checked = true;
    typeInto(app, "password", "pw");
    await submitForm(app);
    expect(storage.session.items.get("legacyUpgradeConsent")).toMatchObject({ id: accountId(legacyUpgrade.server, "oldadmin") });
    expect(asked("connect")).toHaveLength(2);
    expect(app.querySelector("#search")).not.toBeNull();
  });

  it("drops the question once the form names another account", async () => {
    const app = await askedForUpgrade();
    const confirm = app.querySelector<HTMLInputElement>("#legacy-upgrade")!;
    confirm.checked = true;
    typeInto(app, "username", "someone-else");
    expect(confirm.closest<HTMLElement>(".error-box")?.hidden).toBe(true);
    expect(confirm.required).toBe(false);
    await submitForm(app);
    expect(storage.session.items.size).toBe(0);
  });
});

describe("the first-run welcome", () => {
  beforeEach(() => {
    worker.state = { kind: "disconnected" };
    worker.settings = { ...worker.settings, welcomeSeen: false };
  });

  it("offers the welcome on the connect form and opens it", async () => {
    const app = await openPopup();
    expect(app.textContent).toContain("New here? What you need, and why.");
    await click(app, "Read");
    expect(heading(app)).toBe("Welcome to Quark Vault");
    await click(app, "Got it");
    expect(worker.settings.welcomeSeen).toBe(true);
    expect(heading(app)).toBe("Connect to your Quark");
    expect(app.textContent).not.toContain("New here?");
  });

  it("can be dismissed without reading", async () => {
    const app = await openPopup();
    await click(app, "Dismiss");
    expect(worker.settings.welcomeSeen).toBe(true);
    expect(app.textContent).not.toContain("New here?");
  });

  it("leaves focus on the address, not the banner, and returns it there after Dismiss (#109)", async () => {
    const app = await openPopup();
    expect(app.textContent).toContain("New here?");
    expect(document.activeElement?.id).toBe("server");
    buttonNamed(app, "Dismiss")!.focus();
    await click(app, "Dismiss");
    expect(document.activeElement?.id).toBe("server");
  });

  it("isn't offered to someone already signed in", async () => {
    worker.state = locked;
    const app = await openPopup();
    expect(app.textContent).not.toContain("New here?");
  });
});

describe("unlocking and locking", () => {
  it("unlocks with the vault password", async () => {
    worker.state = locked;
    const app = await openPopup();
    expect(heading(app)).toBe("Vault is locked");
    typeInto(app, "master", "correct horse");
    await submitForm(app);
    expect(asked("unlock")).toEqual([{ type: "unlock", masterPassword: "correct horse" }]);
    expect(app.querySelector("#search")).not.toBeNull();
  });

  it("stays on the lock screen with the reason when unlocking fails", async () => {
    worker.state = locked;
    worker.unlock = err({ kind: "rateLimited" });
    const app = await openPopup();
    await submitForm(app);
    expect(heading(app)).toBe("Vault is locked");
    expect(alertText(app)).not.toBe("");
  });

  it("locks from the vault screen", async () => {
    const app = await openPopup();
    await click(app, "Lock vault");
    expect(asked("lock")).toHaveLength(1);
    expect(heading(app)).toBe("Vault is locked");
  });

  it("opens the options from the lock screen", async () => {
    worker.state = locked;
    const openOptionsPage = vi.fn(() => Promise.resolve());
    (chrome.runtime as unknown as { openOptionsPage: () => Promise<void> }).openOptionsPage = openOptionsPage;
    const app = await openPopup();
    await click(app, "Options");
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it("warns on every screen while the Quark is on plain http", async () => {
    worker.state = { kind: "locked", server: "http://192.168.1.10", reason: "" };
    const app = await openPopup();
    expect(app.querySelector('.error-box[role="status"]')).not.toBeNull();
  });
});

describe("notices (#102)", () => {
  const notice = (app: HTMLElement): string => app.querySelector(".notice")?.textContent ?? "";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes when an error shows", async () => {
    const app = await openPopup();
    await click(app, "Generate password");
    expect(notice(app)).toBe("Generated a password and copied it");
    worker.generate = err({ kind: "server", status: 500, message: "boom" });
    await click(app, "Generate password");
    expect(alertText(app)).not.toBe("");
    expect(notice(app)).toBe("");
  });

  it("goes after a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await openPopup();
    await click(app, "Generate password");
    vi.advanceTimersByTime(4000);
    expect(notice(app)).toBe("Generated a password and copied it");
    vi.advanceTimersByTime(1000);
    expect(notice(app)).toBe("");
  });

  it("goes when the copied one-time code changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    worker.otp = ok({ code: "123456", secondsLeft: 2 });
    worker.entries = [{ id: 1, name: "Mail", urlHost: "mail.test", folderId: null, createdAt: "", updatedAt: "" }];
    const app = await openPopup();
    await click(app, "Copy one-time code for Mail");
    expect(notice(app)).toBe("Copied the code for Mail. It changes in 2s.");
    vi.advanceTimersByTime(2000);
    expect(notice(app)).toBe("");
  });
});

describe("a generated password (#111)", () => {
  const panel = (app: HTMLElement): HTMLElement | null => app.querySelector(".generated");

  it("is copied and shown hidden until revealed", async () => {
    const app = await openPopup();
    await click(app, "Generate password");
    expect(browser.clipboard).toEqual(["generated-pw"]);
    expect(panel(app)).not.toBeNull();
    expect(panel(app)!.textContent).not.toContain("generated-pw");
    const reveal = buttonNamed(app, "Show the generated password")!;
    expect(reveal.textContent).toBe("Show");
    reveal.focus();
    reveal.click();
    await settle();
    expect(panel(app)!.querySelector(".mono")?.textContent).toBe("generated-pw");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Hide the generated password");
    expect(document.activeElement?.textContent).toBe("Hide");
  });

  it("can be copied again, replaced, and put away", async () => {
    const app = await openPopup();
    await click(app, "Generate password");
    await click(app, "Copy the generated password");
    expect(browser.clipboard).toEqual(["generated-pw", "generated-pw"]);
    worker.generate = ok("second-pw");
    await click(app, "Generate another");
    expect(browser.clipboard).toEqual(["generated-pw", "generated-pw", "second-pw"]);
    // A new password goes back to hidden.
    expect(panel(app)!.textContent).not.toContain("second-pw");
    await click(app, "Dismiss the generated password");
    expect(panel(app)).toBeNull();
  });

  it("is forgotten when the vault locks", async () => {
    const app = await openPopup();
    await click(app, "Generate password");
    await click(app, "Lock vault");
    typeInto(app, "master", "pw");
    await submitForm(app);
    expect(app.querySelector("#search")).not.toBeNull();
    expect(panel(app)).toBeNull();
  });

  it("is gone when the popup is closed and opened again", async () => {
    const first = await openPopup();
    await click(first, "Generate password");
    expect(panel(first)).not.toBeNull();
    const again = await openPopup();
    expect(again.querySelector("#search")).not.toBeNull();
    expect(panel(again)).toBeNull();
    expect(again.textContent).not.toContain("generated-pw");
  });
});

describe("when the vault locks behind the popup's back", () => {
  const lockedError: ApiError = { kind: "locked", reason: "" };

  it("goes to the lock screen instead of showing an error after Generate", async () => {
    const app = await openPopup();
    worker.generate = err(lockedError);
    worker.state = locked;
    await click(app, "Generate password");
    expect(heading(app)).toBe("Vault is locked");
    expect(browser.clipboard).toEqual([]);
  });

  it("shows other errors in place", async () => {
    const app = await openPopup();
    worker.generate = err({ kind: "rateLimited" });
    await click(app, "Generate password");
    expect(alertText(app)).not.toBe("");
    expect(app.querySelector("#search")).not.toBeNull();
  });
});

describe("the save banner", () => {
  it("saves a captured login", async () => {
    worker.offer = { kind: "save", host: "example.com", username: "ana" };
    const app = await openPopup();
    await click(app, "Save");
    expect(asked("resolveSave")).toEqual([{ type: "resolveSave", action: "save", tabId: 7 }]);
    expect(app.textContent).toContain("Saved the login");
    expect(app.querySelector(".banner.save")).toBeNull();
  });

  it("updates a changed password", async () => {
    worker.offer = { kind: "update", host: "example.com", username: "ana", entryId: 1, entryName: "Work mail" };
    const app = await openPopup();
    await click(app, "Update");
    expect(asked("resolveSave")).toEqual([{ type: "resolveSave", action: "update", tabId: 7 }]);
    expect(app.textContent).toContain("Updated the password");
  });

  it("can be put off without a notice, and offers no Never in the popup", async () => {
    worker.offer = { kind: "save", host: "example.com", username: "ana" };
    const app = await openPopup();
    expect(app.querySelector(".banner.save")?.textContent).not.toContain("Never");
    await click(app, "Not now");
    expect(asked("resolveSave")).toEqual([{ type: "resolveSave", action: "dismiss", tabId: 7 }]);
    expect(app.querySelector(".notice")).toBeNull();
  });

  it("isn't shown for a login that needs an unlock first", async () => {
    worker.offer = { kind: "unlock", host: "example.com", username: "ana" };
    const app = await openPopup();
    expect(app.querySelector(".banner.save")).toBeNull();
  });

  it("shows why saving failed", async () => {
    worker.offer = { kind: "save", host: "example.com", username: "ana" };
    worker.resolveSave = err({ kind: "refused", reason: "That login is no longer waiting to be saved." });
    const app = await openPopup();
    await click(app, "Save");
    expect(alertText(app)).toBe("That login is no longer waiting to be saved.");
  });
});

describe("banners", () => {
  it("asks Firefox users to allow the extension on websites", async () => {
    browser.url = "moz-extension://quark/";
    browser.siteAccess = false;
    const app = await openPopup();
    expect(app.textContent).toContain("Allow Quark Vault on websites");
    await click(app, "Allow");
    expect(app.textContent).not.toContain("Allow Quark Vault on websites");
  });

  it("keeps asking when the user declines", async () => {
    browser.url = "moz-extension://quark/";
    browser.siteAccess = false;
    browser.grantSites = false;
    const app = await openPopup();
    await click(app, "Allow");
    expect(app.textContent).toContain("Allow Quark Vault on websites");
  });

  it("never asks in Chrome", async () => {
    browser.siteAccess = false;
    const app = await openPopup();
    expect(app.textContent).not.toContain("Allow Quark Vault on websites");
  });

  it("points to other password managers until reviewed", async () => {
    worker.settings = { ...worker.settings, othersReviewed: false };
    const app = await openPopup();
    expect(app.textContent).toContain("another password manager");
    await click(app, "Review");
    expect(browser.tabsOpened).toEqual(["chrome-extension://quark/options.html#others"]);
    expect(browser.closed).toBe(1);
  });

  it("drops the other-managers banner for good when dismissed", async () => {
    worker.settings = { ...worker.settings, othersReviewed: false };
    const app = await openPopup();
    await click(app, "Dismiss");
    expect(worker.settings.othersReviewed).toBe(true);
    expect(app.textContent).not.toContain("another password manager");
  });
});

describe("the fill shortcut", () => {
  it("links to Chrome's shortcuts page when none is set", async () => {
    const app = await openPopup();
    await click(app, "Fill shortcut: Not set");
    expect(browser.tabsOpened).toEqual(["chrome://extensions/shortcuts"]);
  });

  it("sends Firefox users to the options page's steps", async () => {
    browser.url = "moz-extension://quark/";
    const app = await openPopup();
    await click(app, "Fill shortcut: Not set");
    expect(browser.tabsOpened).toEqual(["moz-extension://quark/options.html#shortcut"]);
  });

  it("shows a shortcut that is set", async () => {
    browser.shortcut = "Ctrl+Shift+L";
    const app = await openPopup();
    expect(app.querySelector("footer")?.textContent).toContain("Ctrl+Shift+L");
    expect(app.querySelector("footer")?.textContent).toContain("auto-locks after");
  });
});

describe("screens for a Quark that can't open the vault", () => {
  it("offers to fix the address of an unreachable Quark", async () => {
    worker.state = { kind: "unreachable", server: "https://192.168.1.10", message: "fetch failed" };
    const app = await openPopup();
    expect(heading(app)).toBe("Can't reach your Quark");
    expect(app.querySelector(".intro p")?.textContent).toMatch(/^Tried https:\/\/192\.168\.1\.10\./);
    expect(app.textContent).toContain("http://192.168.1.10");
    expect(app.textContent).not.toContain("Check the address and that it's online");
    await click(app, "Edit address");
    expect(heading(app)).toBe("Connect to your Quark");
    expect(app.querySelector<HTMLInputElement>("#server")?.value).toBe("https://192.168.1.10");
    await click(app, "Cancel");
    expect(buttonNamed(app, "Edit address")).toBeDefined();
  });

  it("keeps the unreachable heading short and leaves the advice to the hint", async () => {
    worker.state = { kind: "unreachable", server: "http://quark.local:8080", message: "fetch failed" };
    const app = await openPopup();
    expect(heading(app)).toBe("Can't reach your Quark");
    const paragraphs = [...app.querySelectorAll(".intro p")].map((p) => p.textContent);
    expect(paragraphs).toEqual([
      "Tried http://quark.local:8080. Check the address and port, and that your Quark is online.",
    ]);
  });

  it("tries again", async () => {
    worker.state = { kind: "unreachable", server, message: "fetch failed" };
    const app = await openPopup();
    worker.state = locked;
    await click(app, "Try again");
    expect(heading(app)).toBe("Vault is locked");
  });

  it("signs out from an account that isn't an admin", async () => {
    worker.state = { kind: "notAdmin", server };
    const app = await openPopup();
    expect(buttonNamed(app, "Edit address")).toBeUndefined();
    await click(app, "Sign out");
    expect(asked("signOut")).toHaveLength(1);
    expect(heading(app)).toBe("Connect to your Quark");
  });

  it.each([
    [{ kind: "notInitialized", server }],
    [{ kind: "driveDisconnected", server }],
  ] as const)("explains %o with a way to try again", async (state) => {
    worker.state = state;
    const app = await openPopup();
    expect(heading(app)).not.toBe("");
    expect(buttonNamed(app, "Try again")).toBeDefined();
  });
});
