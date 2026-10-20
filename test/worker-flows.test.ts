import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";
import type { PageCommand } from "../src/shared/messages";
import { defaultSettings, type Settings } from "../src/shared/types";
import { loginPassword, openVault, vaultRoutes, wrappedVaultKey } from "./fakeVault";

// The service worker's remaining flows end to end: one-time codes, lock and unlock, sign-out, the context menu,
// the badge, the keyboard shortcut and locking on idle. The Quark is a small in-memory server behind fetch that
// holds only the wrapped vault key and ciphertext (fakeVault.ts).

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
  { id: 1, name: "GitHub", url: "https://github.com/login", username: "octocat", password: "gh-secret", totpSecret: rfcSecret },
  { id: 2, name: "GitLab", url: "https://gitlab.com/users/sign_in", username: "tanuki", password: "gl-secret", totpSecret: "" },
  { id: 3, name: "Forum one", url: "https://forum.example/login", username: "a", password: "f1-secret", totpSecret: "" },
  { id: 4, name: "Forum two", url: "https://forum.example/login", username: "b", password: "f2-secret", totpSecret: "" },
];

type Call = Readonly<{ method: string; path: string; body: unknown }>;

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const quark = () => {
  const server = { signedIn: true, calls: [] as Call[] };
  const vault = vaultRoutes(entries);
  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v0/, "");
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    server.calls.push({ method, path, body });
    if (method === "GET" && path === "/auth/salt") {
      return Promise.resolve(json(200, { salt: wrappedVaultKey.saltPw, legacy: false, legacyRecovery: false }));
    }
    if (method === "POST" && path === "/auth/login") {
      server.signedIn = true;
      return Promise.resolve(json(200, { token: connection.token }));
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    if (!server.signedIn || auth !== `Bearer ${connection.token}`) {
      return Promise.resolve(json(401, { error: "authentication required" }));
    }
    const route = `${method} ${path}`;
    if (route === "POST /auth/logout") {
      server.signedIn = false;
      return Promise.resolve(json(200));
    }
    return Promise.resolve(vault.handle(method, path, body) ?? json(404, { error: "no route" }));
  };
  return { server, vault, fetchFn };
};

type Sent = Readonly<{ tab: number; message: PageCommand; options: { frameId?: number } | undefined }>;

let fake: ReturnType<typeof fakeChrome>;
let server: ReturnType<typeof quark>["server"];
let vault: ReturnType<typeof quark>["vault"];
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
  vault = fakeQuark.vault;
  const { saveConnection, saveSettings } = await import("../src/background/storage");
  if (signedIn) {
    await saveConnection(connection, false);
    await openVault(fake.chrome.storage.session, connection.server);
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

const lockHere = () => fake.chrome.storage.session.remove("vault");
const isOpenHere = () => fake.chrome.storage.session.items.has("vault");

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
    await lockHere();
    expect(await fake.send({ type: "otp", entryId: 1 }, popup)).toMatchObject({ ok: false, error: { kind: "locked" } });
  });

  // #103: the popup offers "Copy one-time code" in the full list only where an entry has one.
  it("tells the popup which listed entries have a code, and nothing of the secrets", async () => {
    await start();
    const reply = (await fake.send({ type: "entries" }, popup)) as { ok: true; value: { name: string; hasTotp?: boolean }[] };
    expect(Object.fromEntries(reply.value.map((entry) => [entry.name, entry.hasTotp]))).toEqual({
      GitHub: true,
      GitLab: false,
      "Forum one": false,
      "Forum two": false,
    });
    expect(JSON.stringify(reply)).not.toMatch(/gh-secret|gl-secret|f1-secret|f2-secret|GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/);
  });
});

describe("locking and unlocking", () => {
  it("unlocks with the login password on the device and reports the new state", async () => {
    await start();
    await lockHere();
    expect(await fake.send({ type: "unlock", password: loginPassword }, popup)).toEqual({
      ok: true,
      value: { kind: "unlocked", server: connection.server, autoLockSeconds: 900 },
    });
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /vault/key"]);
    expect(JSON.stringify(server.calls)).not.toContain(loginPassword);
    expect(await fake.send({ type: "reveal", entryId: 2 }, popup)).toEqual({ ok: true, value: { username: "tanuki", password: "gl-secret" } });
  });

  it("reports a wrong password and stays locked", async () => {
    await start();
    await lockHere();
    expect(await fake.send({ type: "unlock", password: "wrong" }, popup)).toEqual({
      ok: false,
      error: { kind: "wrongPassword" },
    });
    expect(isOpenHere()).toBe(false);
    expect(await fake.send({ type: "state" }, popup)).toEqual({ kind: "locked", server: connection.server });
  });

  it("says when the account has no vault to unlock", async () => {
    await start();
    await lockHere();
    vault.state.hasVault = false;
    expect(await fake.send({ type: "unlock", password: loginPassword }, popup)).toEqual({ ok: false, error: { kind: "notInitialized" } });
    expect(await fake.send({ type: "state" }, popup)).toEqual({ kind: "notInitialized", server: connection.server });
  });

  it("refuses unlock from a web page", async () => {
    await start();
    await lockHere();
    expect(fake.send({ type: "unlock", password: loginPassword }, frame("https://github.com/", 0))).toBeUndefined();
    await settle();
    expect(server.calls).toEqual([]);
  });

  it("locks itself after 15 minutes unused, and a user's action restarts the count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    await start();
    vi.setSystemTime(14 * 60_000);
    expect(await fake.send({ type: "entries" }, popup)).toMatchObject({ ok: true });
    vi.setSystemTime(28 * 60_000);
    // A page asking what matches it doesn't count as use.
    expect(await fake.send({ type: "matches", pageUrl: "https://github.com/" }, frame("https://github.com/", 0))).toMatchObject({ ok: true });
    vi.setSystemTime(29 * 60_000);
    expect(await fake.send({ type: "reveal", entryId: 2 }, popup)).toEqual({ ok: false, error: { kind: "locked" } });
    expect(isOpenHere()).toBe(false);
    expect(await fake.send({ type: "state" }, popup)).toEqual({ kind: "locked", server: connection.server });
  });

  it("forgets the vault key when the vault is deleted from the app", async () => {
    await start();
    vault.state.hasVault = false;
    await fake.send({ type: "captured", username: "new-user", password: "new-pass" }, frame("https://newsite.example/login", 0));
    expect(await fake.send({ type: "resolveSave", action: "save", tabId }, popup)).toEqual({ ok: false, error: { kind: "notInitialized" } });
    expect(isOpenHere()).toBe(false);
  });

  it("locks the vault and forgets the cached logins", async () => {
    await start();
    expect(await fake.send({ type: "entries" }, popup)).toMatchObject({ ok: true });
    expect(await fake.send({ type: "entries" }, popup)).toMatchObject({ ok: true });
    expect(calls("GET", "/vault/items")).toHaveLength(1);
    expect(await fake.send({ type: "lock" }, popup)).toEqual({
      ok: true,
      value: { kind: "locked", server: connection.server },
    });
    expect(isOpenHere()).toBe(false);
    expect(await fake.send({ type: "entries" }, popup)).toMatchObject({ ok: false, error: { kind: "locked" } });
    expect(calls("GET", "/vault/items")).toHaveLength(1);
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
    expect(isOpenHere()).toBe(false);
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
    expect(isOpenHere()).toBe(false);
  });

  it("locks on idle only when the user asked for it", async () => {
    await start({ settings: { ...defaultSettings, lockOnIdle: false } });
    fired(fake.chrome.idle.onStateChanged, "idle");
    await settle();
    expect(isOpenHere()).toBe(true);
  });

  it("locks on idle when asked to", async () => {
    await start({ settings: { ...defaultSettings, lockOnIdle: true } });
    fired(fake.chrome.idle.onStateChanged, "idle");
    await settle();
    expect(isOpenHere()).toBe(false);
  });

  it("does nothing when the user comes back", async () => {
    await start({ settings: { ...defaultSettings, lockOnIdle: true } });
    fired(fake.chrome.idle.onStateChanged, "active");
    await settle();
    expect(isOpenHere()).toBe(true);
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

  it("fills a password generated on the device into the clicked tab, even while locked", async () => {
    await start();
    await lockHere();
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "generate" }, { id: tabId });
    await settle();
    const [message] = sent.map((record) => record.message);
    expect(message).toMatchObject({ type: "fillGenerated" });
    expect((message as { password: string }).password).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[2-9])(?=.*[^a-zA-Z0-9]).{20}$/);
    expect(server.calls).toEqual([]);
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
  const every = ["lower", "upper", "digit", "symbol"] as const;

  it.each([
    [4, 4],
    [16, 16],
    [500, 64],
  ])("draws %i characters on the device and gets %i", async (length, clamped) => {
    await start();
    const reply = (await fake.send({ type: "generateForPage", length, classes: every }, frame("https://forum.example/join", 0))) as {
      ok: true;
      value: string;
    };
    expect(reply.value).toHaveLength(clamped);
    expect(server.calls).toEqual([]);
  });

  it("draws only the classes the field allows", async () => {
    await start();
    const reply = (await fake.send({ type: "generateForPage", length: 8, classes: ["lower", "digit"] }, frame("https://forum.example/join", 0))) as {
      ok: true;
      value: string;
    };
    expect(reply.value).toMatch(/^(?=.*[a-z])(?=.*[2-9])[a-z2-9]{8}$/);
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
  const signIn = (password: string) =>
    fake.send({ type: "connect", server: connection.server, username: "member", password, persist: false, allowInsecure: false }, popup);

  it("opens the vault with the password it signed in with, and sends neither", async () => {
    await start({ signedIn: false });
    expect(await signIn(loginPassword)).toEqual({ ok: true, value: { kind: "unlocked", server: connection.server, autoLockSeconds: 900 } });
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /auth/salt", "POST /auth/login", "GET /vault/key"]);
    expect(JSON.stringify(server.calls)).not.toContain(loginPassword);
    expect(await fake.send({ type: "reveal", entryId: 1 }, popup)).toEqual({ ok: true, value: { username: "octocat", password: "gh-secret" } });
  }, 60_000);

  it("signs in but stays locked when the password doesn't open the vault", async () => {
    await start({ signedIn: false });
    expect(await signIn("an older password")).toEqual({ ok: true, value: { kind: "locked", server: connection.server } });
    expect(isOpenHere()).toBe(false);
  }, 60_000);

  it("signs in to an account with no vault yet", async () => {
    await start({ signedIn: false });
    vault.state.hasVault = false;
    expect(await signIn(loginPassword)).toEqual({ ok: true, value: { kind: "notInitialized", server: connection.server } });
  }, 60_000);

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
