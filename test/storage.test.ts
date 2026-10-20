import { extensionUrl, fakeChrome, extensionId } from "./fakeChrome";
import { openVault } from "./fakeVault";

const connection = { server: "https://quark.local", token: "secret-token" };

let fake: ReturnType<typeof fakeChrome>;

beforeEach(() => {
  vi.resetModules();
  fake = fakeChrome();
  vi.stubGlobal("chrome", fake.chrome);
  vi.stubGlobal("indexedDB", fake.idb.indexedDB);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const storage = () => import("../src/background/storage");

const stored = () => ({
  local: fake.chrome.storage.local.items.get("connection"),
  session: fake.chrome.storage.session.items.get("connection"),
});

const sealed = () => fake.chrome.storage.local.items.get("sealedConnection") as Record<string, string> | undefined;

const sealKey = () => fake.idb.stores.get("keys")?.get("seal");

// What content scripts can read: everything in storage.local (storage.session is for trusted contexts).
const readableByContentScripts = () => JSON.stringify([...fake.chrome.storage.local.items.values()]);

// A browser restart empties storage.session and the worker's memory, and keeps storage.local and IndexedDB.
const restart = async () => {
  fake.chrome.storage.session.items.clear();
  vi.resetModules();
  return storage();
};

describe("storage", () => {
  it("keeps a connection for the browser session unless asked to stay signed in", async () => {
    const { saveConnection, loadConnection, loadServer } = await storage();
    expect(await saveConnection(connection, false)).toBe(false);
    expect(stored()).toEqual({ local: undefined, session: connection });
    expect(sealed()).toBeUndefined();
    expect(await loadConnection()).toEqual(connection);
    expect(await loadServer()).toBe(connection.server);

    const restarted = await restart();
    expect(await restarted.loadConnection()).toBeNull();
    expect(await restarted.loadServer()).toBe(connection.server);
  });

  it("never puts the token where content scripts can read it, even to stay signed in", async () => {
    const { saveConnection, loadConnection } = await storage();
    expect(await saveConnection(connection, true)).toBe(true);
    expect(stored()).toEqual({ local: undefined, session: connection });
    expect(sealed()).toEqual({ server: connection.server, iv: expect.any(String) as unknown, data: expect.any(String) as unknown });
    expect(readableByContentScripts()).not.toContain(connection.token);
    expect(sealKey()).toBeInstanceOf(CryptoKey);
    expect((sealKey() as CryptoKey).extractable).toBe(false);
    expect(await loadConnection()).toEqual(connection);
  });

  it("stays signed in across a browser restart", async () => {
    const { saveConnection } = await storage();
    await saveConnection(connection, true);
    const restarted = await restart();
    expect(stored().session).toBeUndefined();
    expect(await restarted.loadConnection()).toEqual(connection);
    expect(stored()).toEqual({ local: undefined, session: connection });
  });

  it("restores once when asked for the connection in parallel", async () => {
    const { saveConnection } = await storage();
    await saveConnection(connection, true);
    const restarted = await restart();
    const loads = await Promise.all([restarted.loadConnection(), restarted.loadConnection(), restarted.loadConnection()]);
    expect(loads).toEqual([connection, connection, connection]);
  });

  it("drops a sealed token whose key is gone", async () => {
    const { saveConnection } = await storage();
    await saveConnection(connection, true);
    fake.idb.stores.get("keys")?.clear();
    const restarted = await restart();
    expect(await restarted.loadConnection()).toBeNull();
    expect(sealed()).toBeUndefined();
  });

  it("drops a sealed token that was tampered with or moved to another server", async () => {
    const { saveConnection } = await storage();
    await saveConnection(connection, true);
    const original = sealed() as Record<string, string>;
    const tampered = [
      { ...original, server: "https://evil.example" },
      { ...original, data: btoa("not the token") },
      { ...original, iv: "%%%" },
    ];
    for (const blob of tampered) {
      await fake.chrome.storage.local.set({ sealedConnection: blob });
      const restarted = await restart();
      expect(await restarted.loadConnection()).toBeNull();
      expect(sealed()).toBeUndefined();
      await restarted.saveConnection(connection, true);
    }
  });

  it("ignores a malformed sealed token", async () => {
    const { loadConnection } = await storage();
    await fake.chrome.storage.local.set({ sealedConnection: { server: connection.server } });
    expect(await loadConnection()).toBeNull();
  });

  // Issue #75: content scripts can write storage.local, so a plaintext connection there may be an attacker's.
  const evil = { server: "https://evil.example", token: "x" };
  const plant = () => fake.chrome.storage.local.set({ connection: evil, server: evil.server });

  it("never adopts a plaintext connection planted in storage.local over a sealed one", async () => {
    const { saveConnection } = await storage();
    await saveConnection(connection, true);
    const original = sealed();
    await plant();
    const restarted = await restart();
    expect(await restarted.loadConnection()).toEqual(connection);
    expect(await restarted.loadServer()).toBe(connection.server);
    expect(sealed()).toEqual(original);
    expect(sealKey()).toBeInstanceOf(CryptoKey);
    expect(stored()).toEqual({ local: undefined, session: connection });
  });

  it("never adopts a plaintext connection when nothing is sealed, and deletes it", async () => {
    await plant();
    const { loadConnection, loadServer } = await storage();
    expect(await loadConnection()).toBeNull();
    expect(await loadServer()).toBe("");
    expect(stored()).toEqual({ local: undefined, session: undefined });
    expect(sealed()).toBeUndefined();
  });

  it("drops the plaintext token an older build left, so the user signs in again", async () => {
    await fake.chrome.storage.local.set({ server: connection.server, connection });
    const { loadConnection } = await storage();
    expect(await loadConnection()).toBeNull();
    expect(readableByContentScripts()).not.toContain(connection.token);
    expect(await (await restart()).loadConnection()).toBeNull();
  });

  it("takes the server from the live connection, not from storage.local", async () => {
    const { saveConnection, loadServer } = await storage();
    await saveConnection(connection, false);
    await plant();
    expect(await loadServer()).toBe(connection.server);
  });

  it("remembers the last server where content scripts can't change it", async () => {
    const { saveConnection, clearConnection } = await storage();
    await saveConnection(connection, false);
    await clearConnection();
    await plant();
    const restarted = await restart();
    expect(await restarted.loadConnection()).toBeNull();
    expect(await restarted.loadServer()).toBe(connection.server);
  });

  it("still signs in for the browser session when the token can't be sealed", async () => {
    vi.stubGlobal("indexedDB", {
      open: () => {
        throw new Error("IndexedDB is off in this profile");
      },
    });
    const { saveConnection, loadConnection } = await storage();
    expect(await saveConnection(connection, true)).toBe(false);
    expect(sealed()).toBeUndefined();
    expect(await loadConnection()).toEqual(connection);
  });

  it("clears the connection from both areas and forgets the seal key", async () => {
    const { saveConnection, clearConnection, loadConnection } = await storage();
    await saveConnection(connection, true);
    await fake.chrome.storage.local.set({ connection });
    await clearConnection();
    expect(stored()).toEqual({ local: undefined, session: undefined });
    expect(sealed()).toBeUndefined();
    expect(sealKey()).toBeUndefined();
    expect(await loadConnection()).toBeNull();
  });

  it("keeps the server address after clearing the connection", async () => {
    const { saveConnection, clearConnection, loadServer } = await storage();
    await saveConnection(connection, true);
    await clearConnection();
    expect(await loadServer()).toBe(connection.server);
  });

  it("remembers the server of a restored sealed session after signing out", async () => {
    const { saveConnection } = await storage();
    await saveConnection(connection, true);
    fake.idb.stores.get("keys")?.delete("server");
    const restarted = await restart();
    expect(await restarted.loadConnection()).toEqual(connection);
    await restarted.clearConnection();
    expect(await restarted.loadServer()).toBe(connection.server);
  });

  it("ignores a malformed stored connection", async () => {
    const { loadConnection } = await storage();
    await fake.chrome.storage.session.set({ connection: { server: "https://quark.local" } });
    await fake.chrome.storage.local.set({ connection: "secret-token" });
    expect(await loadConnection()).toBeNull();
    expect(stored().local).toBeUndefined();
  });

  it("restricts storage.session to trusted contexts", async () => {
    const setAccessLevel = vi.spyOn(fake.chrome.storage.session, "setAccessLevel");
    const { restrictSessionStorage } = await storage();
    await restrictSessionStorage();
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it("gets by without setAccessLevel, as in Firefox, or when it throws", async () => {
    const { restrictSessionStorage } = await storage();
    const session = fake.chrome.storage.session as { setAccessLevel?: unknown };
    session.setAccessLevel = () => Promise.reject(new Error("not supported"));
    await expect(restrictSessionStorage()).resolves.toBeUndefined();
    delete session.setAccessLevel;
    await expect(restrictSessionStorage()).resolves.toBeUndefined();
  });

  it("decodes settings and de-duplicates the never-save list", async () => {
    const { loadSettings, saveSettings, loadNeverSave, saveNeverSave } = await storage();
    const settings = await loadSettings();
    expect(await saveSettings({ ...settings, badge: !settings.badge })).toEqual({ ...settings, badge: !settings.badge });
    expect((await loadSettings()).badge).toBe(!settings.badge);

    expect(await loadNeverSave()).toEqual([]);
    expect(await saveNeverSave(["b.com", "a.com", "b.com"])).toEqual(["a.com", "b.com"]);
    await fake.chrome.storage.local.set({ neverSave: ["c.com", 3, null] });
    expect(await loadNeverSave()).toEqual(["c.com"]);
  });
});

describe("the worker drops the connection", () => {
  const popup: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionUrl}popup.html` };

  const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // Signs in to stay signed in, and leaves an older build's plaintext copy in storage.local as well.
  const signedIn = async () => {
    const { saveConnection } = await storage();
    await saveConnection(connection, true);
    await fake.chrome.storage.local.set({ connection });
  };

  const gone = () => ({ ...stored(), sealed: sealed(), key: sealKey() });

  const signedOut = { local: undefined, session: undefined, sealed: undefined, key: undefined };

  const startWorker = async (fetchFn: (url: string, init?: RequestInit) => Promise<Response>) => {
    const fetchSpy = vi.fn(fetchFn);
    vi.stubGlobal("fetch", fetchSpy);
    const { main } = await import("../src/background/index");
    main();
    return fetchSpy;
  };

  it("on sign-out", async () => {
    await signedIn();
    const fetchSpy = await startWorker(() => Promise.resolve(json(200)));
    const reply = await fake.send({ type: "signOut" }, popup);
    expect(reply).toEqual({ ok: true, value: { kind: "signedOut", server: connection.server } });
    expect(gone()).toEqual(signedOut);
    expect(fetchSpy).toHaveBeenCalledWith(`${connection.server}/api/v0/auth/logout`, expect.objectContaining({ method: "POST" }));
  });

  it("on sign-out even when the server can't be reached", async () => {
    await signedIn();
    await startWorker(() => Promise.reject(new Error("offline")));
    await fake.send({ type: "signOut" }, popup);
    expect(gone()).toEqual(signedOut);
  });

  it("when the server answers 401", async () => {
    await signedIn();
    await openVault(fake.chrome.storage.session, connection.server);
    await startWorker(() => Promise.resolve(json(401, { error: "authentication required" })));
    const reply = await fake.send({ type: "entries" }, popup);
    expect(reply).toEqual({ ok: false, error: { kind: "signedOut" } });
    expect(gone()).toEqual(signedOut);
    expect(fake.chrome.storage.session.items.has("vault")).toBe(false);
  });

  it("when the vault key check answers 401", async () => {
    await signedIn();
    await startWorker(() => Promise.resolve(json(401)));
    const reply = await fake.send({ type: "state" }, popup);
    expect(reply).toEqual({ kind: "signedOut", server: connection.server });
    expect(gone()).toEqual(signedOut);
  });

  it("but keeps it on other errors", async () => {
    await signedIn();
    await openVault(fake.chrome.storage.session, connection.server);
    await startWorker(() => Promise.resolve(json(500, { error: "boom" })));
    await fake.send({ type: "entries" }, popup);
    expect(stored().session).toEqual(connection);
    expect(sealed()).toBeDefined();
  });

  it("but not for a web page that asks", async () => {
    await signedIn();
    const fetchSpy = await startWorker(() => Promise.resolve(json(200)));
    const page = { id: extensionId, url: "https://evil.io/", tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 };
    expect(fake.send({ type: "signOut" }, page)).toBeUndefined();
    expect(stored().session).toEqual(connection);
    expect(sealed()).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
