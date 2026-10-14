import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";
import type { PageCommand } from "../src/shared/messages";
import { defaultSettings, type Settings } from "../src/shared/types";

// The service worker's remaining flows end to end: one-time codes, lock and unlock, sign-out, the context menu,
// the badge, the keyboard shortcut and locking on idle. The Quark is a small in-memory server behind fetch.

const connection = { server: "https://quark.local", token: "secret-token" };
const popup: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionUrl}popup.html` };
const tabId = 7;

// RFC 6238's SHA-1 test key, the ASCII digits "1234567890" twice, saved base32-encoded as an authenticator
// would hold it. At T=59s its six-digit code is 287082.
const base32 = (bytes: Uint8Array): string => {
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  return (bits.match(/.{1,5}/g) ?? []).map((chunk) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(chunk.padEnd(5, "0"), 2)]).join("");
};
const rfcSecret = base32(new TextEncoder().encode("1234567890".repeat(2)));

const entries = [
  { id: 1, name: "GitHub", url: "https://github.com/login", urlHost: "github.com", username: "octocat", password: "gh-secret", totpSecret: rfcSecret },
  { id: 2, name: "GitLab", url: "https://gitlab.com/users/sign_in", urlHost: "gitlab.com", username: "tanuki", password: "gl-secret", totpSecret: "" },
  { id: 3, name: "Forum one", url: "https://forum.example/login", urlHost: "forum.example", username: "a", password: "f1-secret", totpSecret: "" },
  { id: 4, name: "Forum two", url: "https://forum.example/login", urlHost: "forum.example", username: "b", password: "f2-secret", totpSecret: "" },
].map((entry) => ({ ...entry, folderId: null, createdAt: "2024-01-01", updatedAt: "2024-01-01" }));

type Call = Readonly<{ method: string; path: string; body: unknown }>;

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const quark = () => {
  const server = { locked: false, signedIn: true, masterPassword: "correct horse", calls: [] as Call[] };
  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v0/, "");
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    server.calls.push({ method, path, body });
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    if (!server.signedIn || auth !== `Bearer ${connection.token}`) {
      return Promise.resolve(json(401, { error: "authentication required" }));
    }
    const lockedReply = () => json(423, { error: "vault is locked: idle" });
    const route = `${method} ${path}`;
    if (route === "GET /vault/status") {
      return Promise.resolve(json(200, { initialized: true, locked: server.locked, deviceConnected: true, autoLockSeconds: 900, lockReason: "" }));
    }
    if (route === "POST /vault/unlock") {
      if ((body as { masterPassword: string }).masterPassword !== server.masterPassword) {
        return Promise.resolve(json(401, { error: "wrong master password" }));
      }
      server.locked = false;
      return Promise.resolve(json(200));
    }
    if (route === "POST /vault/lock") {
      server.locked = true;
      return Promise.resolve(json(200));
    }
    if (route === "POST /auth/logout") {
      server.signedIn = false;
      return Promise.resolve(json(200));
    }
    if (server.locked) {
      return Promise.resolve(lockedReply());
    }
    if (route === "GET /vault/entries") {
      return Promise.resolve(json(200, { entries: entries.map(({ id, name, urlHost, folderId, createdAt, updatedAt }) => ({ id, name, urlHost, folderId, createdAt, updatedAt })) }));
    }
    const one = /^\/vault\/entries\/(\d+)$/.exec(path);
    if (method === "GET" && one !== null) {
      const found = entries.find((entry) => entry.id === Number(one[1]));
      return Promise.resolve(found === undefined ? json(404, { error: "not found" }) : json(200, found));
    }
    if (route === "POST /vault/generate") {
      return Promise.resolve(json(200, { password: "G".repeat((body as { length: number }).length) }));
    }
    return Promise.resolve(json(404, { error: "no route" }));
  };
  return { server, fetchFn };
};

type Sent = Readonly<{ tab: number; message: PageCommand; options: { frameId?: number } | undefined }>;

let fake: ReturnType<typeof fakeChrome>;
let server: ReturnType<typeof quark>["server"];
let sent: Sent[];
let frameReply: (message: PageCommand) => unknown;
let topUrl: string;
const menu: { removeAll: number; items: Record<string, unknown>[] } = { removeAll: 0, items: [] };
const badges: { tabId: number; text: string }[] = [];
const popupsOpened: number[] = [];
const intervals: number[] = [];

beforeEach(() => {
  vi.resetModules();
  fake = fakeChrome();
  vi.stubGlobal("chrome", fake.chrome);
  vi.stubGlobal("indexedDB", fake.idb.indexedDB);
  sent = [];
  frameReply = () => undefined;
  topUrl = "https://github.com/login";
  menu.removeAll = 0;
  menu.items = [];
  badges.length = 0;
  popupsOpened.length = 0;
  intervals.length = 0;
  fake.chrome.tabs.sendMessage = ((tab: number, message: PageCommand, options?: { frameId?: number }) => {
    sent.push({ tab, message, options });
    if (message.type === "whereAmI") {
      return Promise.resolve(options?.frameId === 0 ? topUrl : undefined);
    }
    return Promise.resolve(frameReply(message));
  }) as typeof fake.chrome.tabs.sendMessage;
  fake.chrome.contextMenus.removeAll = () => {
    menu.removeAll += 1;
    menu.items = [];
    return Promise.resolve(undefined);
  };
  fake.chrome.contextMenus.create = ((item: Record<string, unknown>) => void menu.items.push(item)) as typeof fake.chrome.contextMenus.create;
  fake.chrome.action.setBadgeText = ((details: { tabId: number; text: string }) => {
    badges.push(details);
    return Promise.resolve(undefined);
  }) as typeof fake.chrome.action.setBadgeText;
  fake.chrome.action.openPopup = () => {
    popupsOpened.push(1);
    return Promise.resolve(undefined);
  };
  fake.chrome.idle.setDetectionInterval = ((seconds: number) => void intervals.push(seconds)) as typeof fake.chrome.idle.setDetectionInterval;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const start = async ({ signedIn = true, settings = defaultSettings }: { signedIn?: boolean; settings?: Settings } = {}) => {
  const fakeQuark = quark();
  server = fakeQuark.server;
  const { saveConnection, saveSettings } = await import("../src/background/storage");
  if (signedIn) {
    await saveConnection(connection, false);
  }
  await saveSettings(settings);
  vi.stubGlobal("fetch", vi.fn(fakeQuark.fetchFn));
  const { main } = await import("../src/background/index");
  main();
  await settle();
};

const frame = (url: string, frameId: number): chrome.runtime.MessageSender => ({
  id: extensionId,
  url,
  tab: { id: tabId, url } as chrome.tabs.Tab,
  frameId,
});

const calls = (method: string, path: string) => server.calls.filter((call) => call.method === method && call.path === path);
const fired = <T extends unknown[]>(event: { listeners: unknown[] }, ...args: T): void =>
  event.listeners.forEach((listener) => (listener as (...a: T) => void)(...args));

describe("one-time codes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(59_000);
  });

  it("gives the popup the entry's current code", async () => {
    await start();
    expect(await fake.send({ type: "otp", entryId: 1 }, popup)).toEqual({ ok: true, value: { code: "287082", secondsLeft: 1 } });
  });

  it("says so when the entry has no one-time code", async () => {
    await start();
    expect(await fake.send({ type: "otp", entryId: 2 }, popup)).toEqual({
      ok: false,
      error: { kind: "refused", reason: "This login has no one-time code saved." },
    });
  });

  it("gives the code to the entry's own top frame", async () => {
    await start();
    expect(await fake.send({ type: "otpFromPage", entryId: 1 }, frame("https://github.com/sessions/two-factor", 0))).toMatchObject({
      ok: true,
      value: { code: "287082" },
    });
  });

  it("refuses the code to another site's page", async () => {
    await start();
    const reply = await fake.send({ type: "otpFromPage", entryId: 1 }, frame("https://evil.example/2fa", 0));
    expect(reply).toEqual({ ok: false, error: { kind: "refused", reason: "This login doesn't belong to this site." } });
    expect(JSON.stringify(reply)).not.toContain("287082");
  });

  it("refuses the code to the entry's site framed by another site", async () => {
    topUrl = "https://evil.example/";
    await start();
    const reply = await fake.send({ type: "otpFromPage", entryId: 1 }, frame("https://github.com/sessions/two-factor", 3));
    expect(reply).toEqual({
      ok: false,
      error: { kind: "refused", reason: "This login form is embedded in evil.example, so Quark Vault won't fill it." },
    });
  });

  it("refuses the code to a frame whose top page didn't answer", async () => {
    topUrl = "";
    await start();
    const reply = await fake.send({ type: "otpFromPage", entryId: 1 }, frame("https://github.com/sessions/two-factor", 3));
    expect(reply).toMatchObject({ ok: false, error: { kind: "refused" } });
  });

  it("passes on a locked vault", async () => {
    await start();
    server.locked = true;
    expect(await fake.send({ type: "otp", entryId: 1 }, popup)).toMatchObject({ ok: false, error: { kind: "locked" } });
  });

  // #103: the popup offers "Copy one-time code" in the full list only where an entry may have one.
  it("tells the popup which listed entries have a code, once it has looked them up", async () => {
    await start();
    const hasTotp = async (): Promise<Record<string, boolean | undefined>> => {
      const reply = (await fake.send({ type: "entries" }, popup)) as { ok: true; value: { name: string; hasTotp?: boolean }[] };
      return Object.fromEntries(reply.value.map((entry) => [entry.name, entry.hasTotp]));
    };
    expect(await hasTotp()).toEqual({ GitHub: undefined, GitLab: undefined, "Forum one": undefined, "Forum two": undefined });
    await fake.send({ type: "matches", pageUrl: "https://github.com/login" }, popup);
    await fake.send({ type: "otp", entryId: 2 }, popup);
    expect(await hasTotp()).toEqual({ GitHub: true, GitLab: false, "Forum one": undefined, "Forum two": undefined });
  });
});

describe("locking and unlocking", () => {
  it("unlocks with the master password and reports the new state", async () => {
    await start();
    server.locked = true;
    expect(await fake.send({ type: "unlock", masterPassword: "correct horse" }, popup)).toEqual({
      ok: true,
      value: { kind: "unlocked", server: connection.server, autoLockSeconds: 900 },
    });
    expect(calls("POST", "/vault/unlock").map((call) => call.body)).toEqual([{ masterPassword: "correct horse" }]);
  });

  it("reports a wrong master password and stays locked", async () => {
    await start();
    server.locked = true;
    expect(await fake.send({ type: "unlock", masterPassword: "wrong" }, popup)).toEqual({
      ok: false,
      error: { kind: "badMasterPassword" },
    });
    expect(server.locked).toBe(true);
  });

  it("refuses unlock from a web page", async () => {
    await start();
    server.locked = true;
    expect(fake.send({ type: "unlock", masterPassword: "correct horse" }, frame("https://github.com/", 0))).toBeUndefined();
    await settle();
    expect(calls("POST", "/vault/unlock")).toEqual([]);
  });

  it("locks the vault and forgets the cached logins", async () => {
    await start();
    expect(await fake.send({ type: "entries" }, popup)).toMatchObject({ ok: true });
    expect(await fake.send({ type: "entries" }, popup)).toMatchObject({ ok: true });
    expect(calls("GET", "/vault/entries")).toHaveLength(1);
    expect(await fake.send({ type: "lock" }, popup)).toEqual({
      ok: true,
      value: { kind: "locked", server: connection.server, reason: "" },
    });
    expect(await fake.send({ type: "entries" }, popup)).toMatchObject({ ok: false, error: { kind: "locked" } });
    expect(calls("GET", "/vault/entries")).toHaveLength(2);
  });

  it("drops the connection when the Quark says the session is gone", async () => {
    await start();
    server.signedIn = false;
    expect(await fake.send({ type: "entries" }, popup)).toEqual({ ok: false, error: { kind: "signedOut" } });
    expect(await fake.send({ type: "state" }, popup)).toEqual({ kind: "signedOut", server: connection.server });
    const fetches = server.calls.length;
    expect(await fake.send({ type: "reveal", entryId: 1 }, popup)).toEqual({ ok: false, error: { kind: "signedOut" } });
    expect(server.calls).toHaveLength(fetches);
  });

  it("signs out on the Quark and forgets the token", async () => {
    await start();
    expect(await fake.send({ type: "signOut" }, popup)).toEqual({ ok: true, value: { kind: "signedOut", server: connection.server } });
    expect(calls("POST", "/auth/logout")).toHaveLength(1);
    expect(fake.chrome.storage.session.items.has("connection")).toBe(false);
  });

  it("reveals a login to the popup", async () => {
    await start();
    expect(await fake.send({ type: "reveal", entryId: 2 }, popup)).toEqual({ ok: true, value: { username: "tanuki", password: "gl-secret" } });
  });

  it("answers a failure with an error instead of hanging", async () => {
    await start();
    fake.chrome.storage.local.get = () => Promise.reject(new Error("storage broke"));
    expect(await fake.send({ type: "settings" }, popup)).toEqual({ ok: false, error: { kind: "network", message: "storage broke" } });
  });
});

describe("locking on idle", () => {
  it("sets the detection interval from the settings at start and on save", async () => {
    await start({ settings: { ...defaultSettings, idleMinutes: 15 } });
    expect(intervals).toEqual([900]);
    await fake.send({ type: "saveSettings", settings: { ...defaultSettings, idleMinutes: 5 } }, popup);
    expect(intervals).toEqual([900, 300]);
  });

  it("locks the vault when the screen locks", async () => {
    await start();
    fired(fake.chrome.idle.onStateChanged, "locked");
    await settle();
    expect(calls("POST", "/vault/lock")).toHaveLength(1);
  });

  it("locks on idle only when the user asked for it", async () => {
    await start({ settings: { ...defaultSettings, lockOnIdle: false } });
    fired(fake.chrome.idle.onStateChanged, "idle");
    await settle();
    expect(calls("POST", "/vault/lock")).toEqual([]);
  });

  it("locks on idle when asked to", async () => {
    await start({ settings: { ...defaultSettings, lockOnIdle: true } });
    fired(fake.chrome.idle.onStateChanged, "idle");
    await settle();
    expect(calls("POST", "/vault/lock")).toHaveLength(1);
  });

  it("does nothing when the user comes back", async () => {
    await start({ settings: { ...defaultSettings, lockOnIdle: true } });
    fired(fake.chrome.idle.onStateChanged, "active");
    await settle();
    expect(calls("POST", "/vault/lock")).toEqual([]);
  });

  it("doesn't call the Quark when signed out", async () => {
    await start({ signedIn: false });
    fired(fake.chrome.idle.onStateChanged, "locked");
    await settle();
    expect(server.calls).toEqual([]);
  });
});

describe("the badge", () => {
  it("counts the logins for the top frame's site", async () => {
    await start();
    await fake.send({ type: "hello" }, frame("https://forum.example/login", 0));
    expect(badges).toEqual([{ tabId, text: "2" }]);
  });

  it("is blank when the badge is turned off", async () => {
    await start({ settings: { ...defaultSettings, badge: false } });
    await fake.send({ type: "hello" }, frame("https://forum.example/login", 0));
    expect(badges).toEqual([{ tabId, text: "" }]);
  });

  it("is left alone by child frames", async () => {
    await start();
    const reply = await fake.send({ type: "hello" }, frame("https://forum.example/widget", 2));
    expect(reply).toMatchObject({ connected: true });
    expect(badges).toEqual([]);
  });

  it("says hello without matches when signed out", async () => {
    await start({ signedIn: false });
    expect(await fake.send({ type: "hello" }, frame("https://forum.example/login", 0))).toEqual({
      settings: defaultSettings,
      matches: [],
      connected: false,
    });
    expect(badges).toEqual([{ tabId, text: "" }]);
  });
});

describe("the context menu", () => {
  const titles = () => menu.items.map((item) => item.title ?? item.type);

  it("lists the focused page's logins and a generator", async () => {
    await start();
    await fake.send({ type: "fieldFocused" }, frame("https://forum.example/login", 0));
    expect(titles()).toEqual(["Quark Vault", "Fill Forum one", "Fill Forum two", "separator", "Generate password"]);
    expect(menu.items.find((item) => item.title === "Fill Forum one")?.id).toBe("fill:3");
  });

  it("rebuilds only when the origin changes", async () => {
    await start();
    await fake.send({ type: "fieldFocused" }, frame("https://forum.example/login", 0));
    await fake.send({ type: "fieldFocused" }, frame("https://forum.example/other", 0));
    expect(menu.removeAll).toBe(1);
    await fake.send({ type: "fieldFocused" }, frame("https://forum.example:8443/login", 0));
    expect(menu.removeAll).toBe(2);
  });

  it("shows a disabled placeholder when nothing matches", async () => {
    await start();
    await fake.send({ type: "fieldFocused" }, frame("https://nothing.example/", 0));
    expect(menu.items.find((item) => item.id === "none")).toMatchObject({ enabled: false });
  });

  it("rebuilds after a lock even on the same origin", async () => {
    await start();
    await fake.send({ type: "fieldFocused" }, frame("https://forum.example/login", 0));
    await fake.send({ type: "lock" }, popup);
    await fake.send({ type: "fieldFocused" }, frame("https://forum.example/login", 0));
    expect(menu.removeAll).toBe(2);
    expect(menu.items.find((item) => item.id === "none")).toBeDefined();
  });

  it("fills a clicked login through the frames' own checks, with no secret in the message", async () => {
    await start();
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "fill:1" }, { id: tabId });
    await settle();
    const fill = sent.find((record) => record.message.type === "fill");
    expect(fill?.message).toEqual({ type: "fill", entryId: 1, entryUrl: entries[0]?.url, entryHost: "github.com", topUrl });
    expect(JSON.stringify(sent)).not.toContain("gh-secret");
  });

  it("fills a generated password into the clicked tab", async () => {
    await start();
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "generate" }, { id: tabId });
    await settle();
    expect(sent.map((record) => record.message)).toEqual([{ type: "fillGenerated", password: "G".repeat(20) }]);
  });

  it("sends nothing when generating fails", async () => {
    await start();
    server.locked = true;
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "generate" }, { id: tabId });
    await settle();
    expect(sent).toEqual([]);
  });

  it("ignores clicks without a tab or on the placeholder", async () => {
    await start();
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "fill:1" }, undefined);
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "none" }, { id: tabId });
    await settle();
    expect(sent).toEqual([]);
  });
});

describe("generating a password for a page", () => {
  it.each([
    [4, 12],
    [16, 16],
    [500, 64],
  ])("asks the Quark for %i characters as %i", async (length, clamped) => {
    await start();
    expect(await fake.send({ type: "generateForPage", length }, frame("https://forum.example/join", 0))).toEqual({
      ok: true,
      value: "G".repeat(clamped),
    });
  });
});

describe("the keyboard shortcut", () => {
  const shortcut = async (tab: Partial<chrome.tabs.Tab> | undefined, command = "fill-login") => {
    fired(fake.chrome.commands.onCommand, command, tab);
    await settle();
  };

  it("opens the popup outside a tab", async () => {
    await start();
    await shortcut(undefined);
    expect(popupsOpened).toHaveLength(1);
  });

  it("ignores other commands", async () => {
    await start();
    await shortcut(undefined, "_execute_action");
    expect(popupsOpened).toEqual([]);
  });

  it("fills the only login for the site straight away", async () => {
    frameReply = () => ({ ok: true, value: null });
    await start();
    await shortcut({ id: tabId, url: "https://github.com/login" });
    expect(sent.find((record) => record.message.type === "fill")?.message).toMatchObject({ entryId: 1 });
    expect(popupsOpened).toEqual([]);
  });

  it("opens the popup when that fill fails", async () => {
    await start();
    await shortcut({ id: tabId, url: "https://github.com/login" });
    expect(popupsOpened).toHaveLength(1);
  });

  it("opens the page's picker when several logins fit", async () => {
    frameReply = () => ({ ok: true, value: null });
    await start();
    await shortcut({ id: tabId, url: "https://forum.example/login" });
    expect(sent.map((record) => record.message)).toEqual([{ type: "openPicker" }]);
    expect(popupsOpened).toEqual([]);
  });

  it("falls back to the popup when no frame has a picker", async () => {
    await start();
    await shortcut({ id: tabId, url: "https://forum.example/login" });
    expect(popupsOpened).toHaveLength(1);
  });

  it("opens the popup on a page with no logins", async () => {
    await start();
    await shortcut({ id: tabId, url: "https://nothing.example/" });
    expect(sent).toEqual([]);
    expect(popupsOpened).toHaveLength(1);
  });

  it("survives a browser that can't open the popup", async () => {
    await start();
    fake.chrome.action.openPopup = () => Promise.reject(new Error("no window"));
    await expect(shortcut(undefined)).resolves.toBeUndefined();
  });
});

describe("connecting", () => {
  it("rejects an address that isn't one", async () => {
    await start({ signedIn: false });
    expect(
      await fake.send({ type: "connect", server: "   ", username: "a", password: "b", persist: false, allowInsecure: false }, popup),
    ).toEqual({ ok: false, error: { kind: "network", message: "invalid address" } });
  });
});

describe("the never-save list", () => {
  it("removes a host the user un-blocks", async () => {
    await start();
    fake.chrome.storage.local.items.set("neverSave", ["a.example", "b.example"]);
    expect(await fake.send({ type: "removeNeverSave", host: "a.example" }, popup)).toEqual(["b.example"]);
    expect(await fake.send({ type: "neverSaveList" }, popup)).toEqual(["b.example"]);
  });

  it("can't be read by a web page", async () => {
    await start();
    expect(fake.send({ type: "neverSaveList" }, frame("https://evil.example/", 0))).toBeUndefined();
  });
});

describe("the popup's save offer", () => {
  it("refuses to resolve a save without a tab", async () => {
    await start();
    expect(await fake.send({ type: "resolveSave", action: "save" }, popup)).toEqual({
      ok: false,
      error: { kind: "refused", reason: "No tab to save from." },
    });
  });

  it("forgets a captured login when its tab closes", async () => {
    await start();
    await fake.send({ type: "captured", username: "new-user", password: "new-pass" }, frame("https://newsite.example/login", 0));
    expect(await fake.send({ type: "pendingOffer", tabId }, popup)).toMatchObject({ kind: "save" });
    fired(fake.chrome.tabs.onRemoved, tabId);
    expect(await fake.send({ type: "pendingOffer", tabId }, popup)).toBeNull();
  });
});
