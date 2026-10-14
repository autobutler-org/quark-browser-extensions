import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";
import type { PageCommand } from "../src/shared/messages";

const connection = { server: "https://quark.local", token: "secret-token" };
const popup: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionUrl}popup.html` };
const tabId = 7;

const entry = {
  id: 1,
  name: "GitHub",
  url: "https://github.com/login",
  urlHost: "github.com",
  username: "octocat",
  password: "hunter2-secret",
  totpSecret: "",
};

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

const startWorker = async (fetchFn: (url: string) => Promise<Response>) => {
  const fetchSpy = vi.fn(fetchFn);
  vi.stubGlobal("fetch", fetchSpy);
  const { main } = await import("../src/background/index");
  main();
  return fetchSpy;
};

describe("connecting to a Quark over plain http", () => {
  const connect = (server: string, allowInsecure: boolean) =>
    fake.send({ type: "connect", server, username: "admin", password: "pw", persist: false, allowInsecure }, popup);

  // A Quark too old for auth keys answers 404 here, which ends the sign-in before any key derivation.
  const tooOld = () => Promise.resolve(json(404));

  it.each(["http://quark.local", "http://192.168.1.10:8080"])("refuses %s without a confirmation", async (server) => {
    const fetchSpy = await startWorker(tooOld);
    const reply = await connect(server, false);
    expect(reply).toEqual({ ok: false, error: { kind: "refused", reason: expect.stringContaining("plain http") as unknown } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("talks to a non-loopback http Quark once the user confirms", async () => {
    const fetchSpy = await startWorker(tooOld);
    await connect("http://192.168.1.10:8080", true);
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/192\.168\.1\.10:8080\/api\/v0\/auth\/salt/), expect.anything());
  });

  it.each(["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080", "https://quark.local", "quark.local"])(
    "needs no confirmation for %s",
    async (server) => {
      const fetchSpy = await startWorker(tooOld);
      await connect(server, false);
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/api/v0/auth/salt"), expect.anything());
    },
  );
});

describe("filling from the popup, shortcut or context menu", () => {
  type Sent = Readonly<{ message: PageCommand; options: { frameId?: number } | undefined }>;

  const setup = async (topUrl: string) => {
    const { saveConnection } = await import("../src/background/storage");
    await saveConnection(connection, false);
    const sent: Sent[] = [];
    let frameReply: unknown = undefined;
    fake.chrome.tabs.sendMessage = ((_tab: number, message: PageCommand, options?: { frameId?: number }) => {
      sent.push({ message, options });
      if (message.type === "whereAmI") {
        return Promise.resolve(options?.frameId === 0 ? topUrl : undefined);
      }
      // The top frame reports every subframe's <iframe> as shown (#141; worker-frames.test.ts covers the rest).
      if (message.type === "announceFrame") {
        void fake.send({ type: "frameReport", nonce: message.nonce, shown: true }, frame(topUrl, 0));
        return Promise.resolve(undefined);
      }
      return Promise.resolve(frameReply);
    }) as typeof fake.chrome.tabs.sendMessage;
    const fetchSpy = await startWorker((url) => Promise.resolve(url.endsWith("/vault/entries/1") ? json(200, entry) : json(200, {})));
    return { sent, fetchSpy, replyFromFrame: (value: unknown) => (frameReply = value) };
  };

  const frame = (url: string, frameId: number): chrome.runtime.MessageSender => ({
    id: extensionId,
    url,
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId,
  });

  const fillFromPage = (sender: chrome.runtime.MessageSender) => fake.send({ type: "fillFromPage", entryId: 1 }, sender);

  it("sends every frame a command with no username or password in it", async () => {
    const { sent, replyFromFrame } = await setup("https://github.com/login");
    replyFromFrame({ ok: true, value: null });
    const reply = await fake.send({ type: "fillInTab", tabId, entryId: 1 }, popup);
    expect(reply).toEqual({ ok: true, value: null });
    const fill = sent.find((s) => s.message.type === "fill");
    expect(fill?.message).toEqual({
      type: "fill",
      entryId: 1,
      entryUrl: entry.url,
      entryHost: entry.urlHost,
      topUrl: "https://github.com/login",
    });
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain(entry.password);
    expect(everything).not.toContain(entry.username);
  });

  it("says so when no frame has the login fields", async () => {
    await setup("https://github.com/login");
    const reply = await fake.send({ type: "fillInTab", tabId, entryId: 1 }, popup);
    expect(reply).toMatchObject({ ok: false, error: { kind: "refused" } });
  });

  it("hands the credentials to the top frame of the entry's site", async () => {
    await setup("https://github.com/login");
    expect(await fillFromPage(frame("https://github.com/login", 0))).toEqual({
      ok: true,
      value: { username: entry.username, password: entry.password, autoSubmit: false },
    });
  });

  it("hands the credentials to a same-site iframe", async () => {
    await setup("https://github.com/");
    expect(await fillFromPage(frame("https://auth.github.com/frame", 4))).toMatchObject({
      ok: true,
      value: { password: entry.password },
    });
  });

  it("refuses another site's iframe on the entry's site", async () => {
    await setup("https://github.com/login");
    expect(await fillFromPage(frame("https://ads.example/frame", 5))).toEqual({
      ok: false,
      error: { kind: "refused", reason: "This login doesn't belong to this site." },
    });
  });

  it("refuses the entry's site framed by another site", async () => {
    await setup("https://evil.example/");
    expect(await fillFromPage(frame("https://github.com/login", 6))).toMatchObject({
      ok: false,
      error: { kind: "refused", reason: expect.stringContaining("evil.example") as unknown },
    });
  });
});

// Issue #75: a compromised renderer's content script can write storage.local but must not pick the Quark.
describe("a connection planted in storage.local", () => {
  const evil = "https://evil.example";

  const plantAndRestart = async () => {
    await fake.chrome.storage.local.set({ connection: { server: evil, token: "x" }, server: evil });
    fake.chrome.storage.session.items.clear();
    vi.resetModules();
  };

  it("never receives the master password after a restart", async () => {
    const { saveConnection } = await import("../src/background/storage");
    await saveConnection(connection, true);
    await plantAndRestart();
    const fetchSpy = await startWorker(() => Promise.resolve(json(200, {})));
    await fake.send({ type: "unlock", masterPassword: "master-secret" }, popup);
    const urls = fetchSpy.mock.calls.map(([url]) => url);
    expect(urls).toContain(`${connection.server}/api/v0/vault/unlock`);
    expect(urls.filter((url) => url.startsWith(evil))).toEqual([]);
    expect(fake.chrome.storage.local.items.get("sealedConnection")).toBeDefined();
  });

  it("isn't shown as the server when signed out", async () => {
    await plantAndRestart();
    const fetchSpy = await startWorker(() => Promise.resolve(json(200, {})));
    expect(await fake.send({ type: "state" }, popup)).toEqual({ kind: "disconnected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
