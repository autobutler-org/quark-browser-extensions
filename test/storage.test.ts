import { extensionUrl, fakeChrome, extensionId } from "./fakeChrome";

const connection = { server: "https://quark.local", token: "secret-token" };

let fake: ReturnType<typeof fakeChrome>;

beforeEach(() => {
  vi.resetModules();
  fake = fakeChrome();
  vi.stubGlobal("chrome", fake.chrome);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const storage = () => import("../src/background/storage");

const stored = () => ({
  local: fake.chrome.storage.local.items.get("connection"),
  session: fake.chrome.storage.session.items.get("connection"),
});

describe("storage", () => {
  it("keeps a connection for the browser session unless asked to persist it", async () => {
    const { saveConnection, loadConnection, loadServer } = await storage();
    await saveConnection(connection, false);
    expect(stored()).toEqual({ local: undefined, session: connection });
    expect(await loadConnection()).toEqual(connection);
    expect(await loadServer()).toBe(connection.server);

    await saveConnection(connection, true);
    expect(stored()).toEqual({ local: connection, session: undefined });
    expect(await loadConnection()).toEqual(connection);
  });

  it("clears the connection from both areas", async () => {
    const { clearConnection, loadConnection } = await storage();
    await fake.chrome.storage.local.set({ connection });
    await fake.chrome.storage.session.set({ connection: { ...connection, token: "other" } });
    await clearConnection();
    expect(stored()).toEqual({ local: undefined, session: undefined });
    expect(await loadConnection()).toBeNull();
  });

  it("keeps the server address after clearing the connection", async () => {
    const { saveConnection, clearConnection, loadServer } = await storage();
    await saveConnection(connection, true);
    await clearConnection();
    expect(await loadServer()).toBe(connection.server);
  });

  it("ignores a malformed stored connection", async () => {
    const { loadConnection } = await storage();
    await fake.chrome.storage.session.set({ connection: { server: "https://quark.local" } });
    await fake.chrome.storage.local.set({ connection: "secret-token" });
    expect(await loadConnection()).toBeNull();
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

  // Puts a token in both areas, the way an upgrade from an older build or a race could leave it.
  const signedIn = async () => {
    await fake.chrome.storage.local.set({ server: connection.server, connection });
    await fake.chrome.storage.session.set({ connection });
  };

  const startWorker = async (fetchFn: (url: string, init?: RequestInit) => Promise<Response>) => {
    const fetchSpy = vi.fn(fetchFn);
    vi.stubGlobal("fetch", fetchSpy);
    const { main } = await import("../src/background/index");
    main();
    return fetchSpy;
  };

  it("on sign-out", async () => {
    await signedIn();
    const fetchSpy = await startWorker(async () => json(200));
    const reply = await fake.send({ type: "signOut" }, popup);
    expect(reply).toEqual({ ok: true, value: { kind: "signedOut", server: connection.server } });
    expect(stored()).toEqual({ local: undefined, session: undefined });
    expect(fetchSpy).toHaveBeenCalledWith(`${connection.server}/api/v0/auth/logout`, expect.objectContaining({ method: "POST" }));
  });

  it("on sign-out even when the server can't be reached", async () => {
    await signedIn();
    await startWorker(async () => {
      throw new Error("offline");
    });
    await fake.send({ type: "signOut" }, popup);
    expect(stored()).toEqual({ local: undefined, session: undefined });
  });

  it("when the server answers 401", async () => {
    await signedIn();
    await startWorker(async () => json(401, { error: "authentication required" }));
    const reply = await fake.send({ type: "entries" }, popup);
    expect(reply).toEqual({ ok: false, error: { kind: "signedOut" } });
    expect(stored()).toEqual({ local: undefined, session: undefined });
  });

  it("when the vault status check answers 401", async () => {
    await signedIn();
    await startWorker(async () => json(401));
    const reply = await fake.send({ type: "state" }, popup);
    expect(reply).toEqual({ kind: "signedOut", server: connection.server });
    expect(stored()).toEqual({ local: undefined, session: undefined });
  });

  it("but keeps it on other errors", async () => {
    await signedIn();
    await startWorker(async () => json(500, { error: "boom" }));
    await fake.send({ type: "entries" }, popup);
    expect(stored()).toEqual({ local: connection, session: connection });
  });

  it("but not for a web page that asks", async () => {
    await signedIn();
    const fetchSpy = await startWorker(async () => json(200));
    const page = { id: extensionId, url: "https://evil.io/", tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 };
    expect(fake.send({ type: "signOut" }, page)).toBeUndefined();
    expect(stored()).toEqual({ local: connection, session: connection });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
