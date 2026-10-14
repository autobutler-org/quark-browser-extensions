import { fakeI18n } from "./fakeChrome";
import type { Request } from "../src/shared/messages";
import { idleAction } from "../src/background/idle";
import type { Browser } from "../src/shared/platform";
import { defaultSettings, type VaultState } from "../src/shared/types";

// The options page's flows: settings, signing out, the shortcut, and the "other password managers" section with
// its permission prompts. The worker answers through chrome.runtime.sendMessage.

type Extension = Readonly<{ id: string; name: string; enabled: boolean; type: string; mayDisable: boolean }>;

const browser = {
  url: "chrome-extension://quark/",
  granted: new Set<string>(),
  grant: true as boolean | "throw",
  passwordSaving: { value: true, levelOfControl: "controllable_by_this_extension" },
  setPasswordSaving: "ok" as "ok" | "throw",
  extensions: [] as Extension[],
  disabled: [] as string[],
  tabsOpened: [] as string[],
  shortcut: "",
};

const worker = {
  state: { kind: "unlocked", server: "https://quark.local", autoLockSeconds: 0 } as VaultState,
  settings: defaultSettings,
  neverSave: [] as string[],
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
    case "neverSaveList":
      return worker.neverSave;
    case "signOut":
      worker.state = { kind: "signedOut", server: "https://quark.local" };
      return { ok: true, value: worker.state };
    default:
      return undefined;
  }
};

beforeEach(() => {
  Object.assign(browser, {
    url: "chrome-extension://quark/",
    granted: new Set<string>(),
    grant: true,
    passwordSaving: { value: true, levelOfControl: "controllable_by_this_extension" },
    setPasswordSaving: "ok",
    extensions: [],
    disabled: [],
    tabsOpened: [],
    shortcut: "",
  });
  Object.assign(worker, {
    state: { kind: "unlocked", server: "https://quark.local", autoLockSeconds: 0 },
    settings: { ...defaultSettings, othersReviewed: true },
    neverSave: [],
    asked: [],
  });
  const permission = (request: { permissions: string[] }) => request.permissions[0] ?? "";
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: {
      id: "quark",
      getURL: (path: string) => `${browser.url}${path}`,
      sendMessage: (request: Request) => Promise.resolve(answer(request)),
    },
    tabs: { create: ({ url }: { url: string }) => Promise.resolve(void browser.tabsOpened.push(url)) },
    commands: { getAll: () => Promise.resolve([{ name: "fill-login", shortcut: browser.shortcut }]) },
    permissions: {
      contains: (request: { permissions: string[] }) => Promise.resolve(browser.granted.has(permission(request))),
      request: (request: { permissions: string[] }) => {
        if (browser.grant === "throw") {
          return Promise.reject(new Error("blocked"));
        }
        if (browser.grant) {
          browser.granted.add(permission(request));
        }
        return Promise.resolve(browser.grant);
      },
    },
    privacy: {
      services: {
        passwordSavingEnabled: {
          get: () => Promise.resolve(browser.passwordSaving),
          set: ({ value }: { value: boolean }) => {
            if (browser.setPasswordSaving === "throw") {
              return Promise.reject(new Error("not allowed"));
            }
            browser.passwordSaving = { ...browser.passwordSaving, value };
            return Promise.resolve();
          },
        },
      },
    },
    management: {
      getAll: () => Promise.resolve(browser.extensions),
      setEnabled: (id: string, enabled: boolean) => {
        browser.disabled.push(id);
        browser.extensions = browser.extensions.map((extension) => (extension.id === id ? { ...extension, enabled } : extension));
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.location.hash = "";
});

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const buttonNamed = (scope: ParentNode, name: string): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll("button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent) === name);

const click = async (scope: ParentNode, name: string): Promise<void> => {
  const button = buttonNamed(scope, name);
  expect(button, name).toBeDefined();
  button?.click();
  await settle();
};

describe("other password managers", () => {
  const openSection = async (): Promise<HTMLElement> => {
    vi.resetModules();
    const { othersSection } = await import("../src/options/others");
    const section = othersSection();
    document.body.append(section);
    await settle();
    return section;
  };

  const passwordManagers: Extension[] = [
    { id: "bw", name: "Bitwarden", enabled: true, type: "extension", mayDisable: true },
    { id: "pp", name: "Proton Pass", enabled: true, type: "extension", mayDisable: false },
    { id: "lp", name: "LastPass", enabled: false, type: "extension", mayDisable: true },
    { id: "ub", name: "uBlock Origin", enabled: true, type: "extension", mayDisable: true },
    { id: "quark", name: "Quark Vault 1Password importer", enabled: true, type: "extension", mayDisable: true },
  ];

  it("asks before reading anything", async () => {
    const section = await openSection();
    expect(buttonNamed(section, "Check Google Password Manager")).toBeDefined();
    expect(buttonNamed(section, "Check password manager extensions")).toBeDefined();
  });

  it("lists the enabled password managers once allowed, leaving out itself and other extensions", async () => {
    browser.extensions = passwordManagers;
    const section = await openSection();
    await click(section, "Check password manager extensions");
    expect(browser.granted.has("management")).toBe(true);
    expect(section.textContent).toContain("Bitwarden");
    expect(section.textContent).toContain("Proton Pass");
    expect(section.textContent).not.toContain("LastPass");
    expect(section.textContent).not.toContain("uBlock");
    expect(section.textContent).not.toContain("importer");
  });

  it("turns off the extension the user picks and lists the rest", async () => {
    browser.granted.add("management");
    browser.extensions = passwordManagers;
    const section = await openSection();
    await click(section, "Turn off Bitwarden");
    expect(browser.disabled).toEqual(["bw"]);
    expect(section.textContent).not.toContain("Bitwarden");
  });

  it("offers no button for one the organization manages", async () => {
    browser.granted.add("management");
    browser.extensions = passwordManagers;
    const section = await openSection();
    expect(buttonNamed(section, "Turn off Proton Pass")).toBeUndefined();
    expect(section.textContent).toContain("Managed by your organization");
  });

  it("points Firefox users to about:addons instead of turning extensions off", async () => {
    browser.url = "moz-extension://quark/";
    browser.granted.add("management");
    browser.extensions = passwordManagers;
    const section = await openSection();
    expect(buttonNamed(section, "Turn off Bitwarden")).toBeUndefined();
    expect(section.textContent).toContain("Turn off in about:addons");
    expect(section.textContent).toContain("Firefox Password Manager");
  });

  it("says when there are none", async () => {
    browser.granted.add("management");
    const section = await openSection();
    expect(section.textContent).toContain("No other password manager extensions are turned on.");
  });

  it("stays put when the user declines the permission", async () => {
    browser.grant = false;
    browser.extensions = passwordManagers;
    const section = await openSection();
    await click(section, "Check password manager extensions");
    expect(section.textContent).not.toContain("Also fills logins");
    expect(buttonNamed(section, "Check password manager extensions")).toBeDefined();
  });

  it("explains where to go when the browser blocks the request", async () => {
    browser.grant = "throw";
    const section = await openSection();
    await click(section, "Check Google Password Manager");
    expect(section.querySelector('[role="alert"]')?.textContent).toBe(
      "The browser didn't allow that change. Try it from chrome://settings instead.",
    );
  });

  it("turns off the browser's own password saving", async () => {
    const section = await openSection();
    await click(section, "Check Google Password Manager");
    expect(section.textContent).toContain("The browser is still offering to save passwords.");
    await click(section, "Turn off Google Password Manager");
    expect(browser.passwordSaving.value).toBe(false);
    expect(section.textContent).toContain("The browser's password saving is off.");
    expect(buttonNamed(section, "Turn off Google Password Manager")).toBeUndefined();
  });

  it("shows the error when turning it off is refused, and clears it after a later success", async () => {
    browser.granted.add("privacy");
    browser.setPasswordSaving = "throw";
    const section = await openSection();
    await click(section, "Turn off Google Password Manager");
    expect(section.querySelector('[role="alert"]')).not.toBeNull();
    browser.setPasswordSaving = "ok";
    await click(section, "Turn off Google Password Manager");
    expect(section.querySelector('[role="alert"]')).toBeNull();
  });

  it("leaves a setting someone else controls alone", async () => {
    browser.granted.add("privacy");
    browser.passwordSaving = { value: true, levelOfControl: "controlled_by_other_extensions" };
    const section = await openSection();
    expect(section.textContent).toContain("set by your organization or another extension");
    expect(buttonNamed(section, "Turn off Google Password Manager")).toBeUndefined();
  });
});

describe("the options page", () => {
  const openOptions = async (hash = ""): Promise<HTMLElement> => {
    window.location.hash = hash;
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    await import("../src/options/index");
    await vi.waitFor(() => expect(document.querySelector("main")).not.toBeNull());
    await settle();
    return document.getElementById("app")!;
  };

  const saved = () => worker.asked.filter((request) => request.type === "saveSettings");

  it("marks the other managers as reviewed on the first visit", async () => {
    worker.settings = { ...defaultSettings, othersReviewed: false };
    await openOptions();
    expect(worker.settings.othersReviewed).toBe(true);
  });

  it("doesn't save anything on a later visit", async () => {
    await openOptions();
    expect(saved()).toEqual([]);
  });

  it("enables the idle time only with lock-on-idle, and saves the chosen time", async () => {
    const app = await openOptions();
    const select = app.querySelector<HTMLSelectElement>("#idle-minutes")!;
    expect(select.disabled).toBe(true);
    app.querySelector<HTMLInputElement>("#lockOnIdle")!.click();
    await settle();
    expect(worker.settings.lockOnIdle).toBe(true);
    const enabled = app.querySelector<HTMLSelectElement>("#idle-minutes")!;
    expect(enabled.disabled).toBe(false);
    enabled.value = "5";
    enabled.dispatchEvent(new Event("change"));
    await settle();
    expect(worker.settings).toMatchObject({ lockOnIdle: true, idleMinutes: 5 });
  });

  // Chrome reports a locked screen, so the vault locks then, and idle locking is the user's choice. Firefox can't
  // see a screen lock, so idle.ts always locks after the idle time, and the page says so instead (#151).
  const locking = (app: HTMLElement) => {
    const toggle = app.querySelector<HTMLInputElement>("#lockOnIdle")!;
    return {
      intro: app.querySelector("#locking p")?.textContent ?? "",
      checked: toggle.checked,
      disabled: toggle.disabled,
      hint: app.querySelector("#lockOnIdle-hint")?.textContent ?? "",
      idleTimeDisabled: app.querySelector<HTMLSelectElement>("#idle-minutes")!.disabled,
    };
  };

  it("says Chrome locks with the screen, and leaves idle locking to the user (#151)", async () => {
    const shown = locking(await openOptions());
    expect(shown.intro).toContain("The vault locks when your screen locks.");
    expect(shown.intro).toContain("Turn on idle locking to also lock it after a set time.");
    expect(shown.intro).not.toContain("Firefox");
    expect(shown).toMatchObject({ checked: false, disabled: false, hint: "Off by default, so someone else mid-task isn't locked out", idleTimeDisabled: true });
  });

  it("says Firefox locks after the idle time, with idle locking shown on and fixed (#151)", async () => {
    browser.url = "moz-extension://quark/";
    const app = await openOptions();
    const shown = locking(app);
    expect(shown.intro).toContain("Firefox can't tell when your screen locks, so the vault locks after the idle time below.");
    expect(shown.intro).not.toContain("otherwise");
    expect(shown).toMatchObject({ checked: true, disabled: true, idleTimeDisabled: false });
    expect(shown.hint).toContain("Always on in Firefox");
    const select = app.querySelector<HTMLSelectElement>("#idle-minutes")!;
    select.value = "5";
    select.dispatchEvent(new Event("change"));
    await settle();
    expect(worker.settings).toMatchObject({ lockOnIdle: false, idleMinutes: 5 });
  });

  // What the page says happens on an idle computer must be what the worker does.
  it.each([
    ["chrome", false],
    ["chrome", true],
    ["firefox", false],
    ["firefox", true],
  ] as const)("matches idle.ts on %s with lock-on-idle %s (#151)", async (name: Browser, lockOnIdle) => {
    browser.url = name === "firefox" ? "moz-extension://quark/" : "chrome-extension://quark/";
    worker.settings = { ...worker.settings, lockOnIdle };
    const shown = locking(await openOptions());
    expect(idleAction("idle", worker.settings, name)).toBe(shown.checked ? "lock" : "none");
    expect(idleAction("locked", worker.settings, name)).toBe("lock");
    expect(shown.idleTimeDisabled, "the idle time is editable exactly when it applies").toBe(!shown.checked);
  });

  it("signs out of the Quark", async () => {
    const app = await openOptions();
    expect(app.querySelector("#connection")?.textContent).toContain("https://quark.local");
    await click(app, "Sign out");
    expect(worker.asked.some((request) => request.type === "signOut")).toBe(true);
    expect(buttonNamed(app, "Sign out")).toBeUndefined();
    expect(app.querySelector("#connection")?.textContent).toContain("Open the Quark Vault toolbar button to connect.");
  });

  it("says no Quark is connected before one is", async () => {
    worker.state = { kind: "disconnected" };
    const app = await openOptions();
    expect(app.querySelector("#connection")?.textContent).toContain("No Quark connected");
  });

  it("opens Chrome's shortcuts page to set the shortcut", async () => {
    const app = await openOptions();
    await click(app, "Set a shortcut");
    expect(browser.tabsOpened).toEqual(["chrome://extensions/shortcuts"]);
  });

  it("offers to change a shortcut that is set", async () => {
    browser.shortcut = "Ctrl+Shift+L";
    const app = await openOptions();
    expect(app.querySelector("#shortcut")?.textContent).toContain("Ctrl+Shift+L");
    expect(buttonNamed(app, "Change")).toBeDefined();
  });

  it("has no shortcut button on Firefox, which can't open about:addons", async () => {
    browser.url = "moz-extension://quark/";
    const app = await openOptions();
    expect(app.querySelector("#shortcut button")).toBeNull();
  });

  it("says there are no never-save sites yet", async () => {
    const app = await openOptions();
    expect(app.querySelector("#never-save")?.textContent).toContain("None yet.");
  });

  it("lands on the other managers when linked there", async () => {
    Element.prototype.scrollIntoView = () => undefined;
    await openOptions("#others");
    await vi.waitFor(() => expect(document.activeElement?.id).toBe("others"));
  });
});
