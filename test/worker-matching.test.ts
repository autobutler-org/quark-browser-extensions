import { openVault, vaultFetch } from "./fakeVault";
import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";

const connection = { server: "https://quark.local", token: "secret-token" };
const popup: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionUrl}popup.html` };
const tabId = 7;

// One box running several services, as self-hosters do, plus a login elsewhere.
const details = [
  { id: 1, name: "Router", url: "http://localhost:8099/basic.html" },
  { id: 2, name: "NAS", url: "http://localhost:8087/login" },
  { id: 3, name: "Quark", url: "https://localhost:8087" },
  { id: 4, name: "GitHub", url: "https://github.com" },
].map((entry) => ({ ...entry, username: `${entry.name}-user`, password: `${entry.name}-secret`, totpSecret: entry.id === 2 ? "JBSWY3DPEHPK3PXP" : "" }));


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

const startWorker = async () => {
  const { saveConnection } = await import("../src/background/storage");
  await saveConnection(connection, false);
  await openVault(fake.chrome.storage.session, connection.server);
  const fetchSpy = vi.fn(vaultFetch(details));
  vi.stubGlobal("fetch", fetchSpy);
  const { main } = await import("../src/background/index");
  main();
  return fetchSpy;
};

const page = (url: string, frameId = 0): chrome.runtime.MessageSender => ({
  id: extensionId,
  url,
  tab: { id: tabId } as chrome.tabs.Tab,
  frameId,
});

const fetched = (fetchSpy: ReturnType<typeof vi.fn>): readonly string[] => fetchSpy.mock.calls.map(([url]) => String(url));

describe("matching logins to the page by origin", () => {
  it("ranks the exact origin first and labels other ports and schemes", async () => {
    await startWorker();
    const reply = (await fake.send({ type: "matches", pageUrl: "http://localhost:8087/login" }, popup)) as {
      ok: true;
      value: readonly { id: number; kind: string; where: string; note: string }[];
    };
    expect(reply.value.map(({ id, kind, where, note }) => ({ id, kind, where, note }))).toEqual([
      { id: 2, kind: "exact", where: "localhost:8087/login", note: "" },
      { id: 1, kind: "otherPort", where: "localhost:8099/basic.html", note: "Different port" },
      { id: 3, kind: "otherScheme", where: "https://localhost:8087", note: "Saved for https" },
    ]);
  });

  it("says which matches have a one-time code, so the popup offers it only there", async () => {
    await startWorker();
    const reply = (await fake.send({ type: "matches", pageUrl: "http://localhost:8087/login" }, popup)) as {
      ok: true;
      value: readonly { id: number; hasTotp?: boolean }[];
    };
    expect(reply.value.map(({ id, hasTotp }) => ({ id, hasTotp }))).toEqual([
      { id: 2, hasTotp: true },
      { id: 1, hasTotp: false },
      { id: 3, hasTotp: false },
    ]);
  });

  it("matches from one decrypted list, fetching no entry on its own", async () => {
    const fetchSpy = await startWorker();
    await fake.send({ type: "matches", pageUrl: "http://localhost:8087/" }, popup);
    await fake.send({ type: "matches", pageUrl: "http://localhost:8099/" }, popup);
    expect(fetched(fetchSpy)).toEqual([`${connection.server}/api/v0/vault/items`]);
  });

  it("badges only the logins for this origin, never the fallbacks", async () => {
    await startWorker();
    const badge = vi.spyOn(fake.chrome.action, "setBadgeText");
    await fake.send({ type: "hello" }, page("http://localhost:8099/basic.html"));
    expect(badge).toHaveBeenLastCalledWith({ tabId, text: "1" });
    await fake.send({ type: "hello" }, page("http://localhost:9000/"));
    expect(badge).toHaveBeenLastCalledWith({ tabId, text: "" });
  });

  it("hands the picker the fallbacks with where they were saved", async () => {
    await startWorker();
    const hello = (await fake.send({ type: "hello" }, page("http://localhost:9000/"))) as {
      matches: readonly { id: number; kind: string; where: string }[];
    };
    expect(hello.matches.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 2, kind: "otherPort" },
      { id: 1, kind: "otherPort" },
      { id: 3, kind: "otherScheme" },
    ]);
  });

  it("rebuilds the context menu for each port on a host", async () => {
    await startWorker();
    const create = vi.spyOn(fake.chrome.contextMenus, "create");
    const titles = () => create.mock.calls.map((args) => ((args as unknown[])[0] as { title?: string } | undefined)?.title).filter((title) => title?.startsWith("Fill"));
    await fake.send({ type: "fieldFocused" }, page("http://localhost:8099/basic.html"));
    expect(titles()).toEqual(["Fill Router"]);
    create.mockClear();
    await fake.send({ type: "fieldFocused" }, page("http://localhost:8087/login"));
    expect(titles()).toEqual(["Fill NAS"]);
    create.mockClear();
    await fake.send({ type: "fieldFocused" }, page("https://localhost:8087/"));
    expect(titles()).toEqual(["Fill Quark"]);
  });

  it("hands a page only the logins saved for its scheme and port", async () => {
    await startWorker();
    expect(await fake.send({ type: "fillFromPage", entryId: 1 }, page("http://localhost:8099/"))).toMatchObject({
      ok: true,
      value: { password: "Router-secret" },
    });
    expect(await fake.send({ type: "fillFromPage", entryId: 2 }, page("http://localhost:8087/"))).toMatchObject({
      ok: true,
      value: { password: "NAS-secret" },
    });
    expect(await fake.send({ type: "fillFromPage", entryId: 3 }, page("https://localhost:8087/"))).toMatchObject({
      ok: true,
      value: { password: "Quark-secret" },
    });
  });

  it("refuses a fallback to the page, so another port or scheme never gets it with one click", async () => {
    await startWorker();
    expect(await fake.send({ type: "fillFromPage", entryId: 1 }, page("http://localhost:9000/"))).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
    expect(await fake.send({ type: "fillFromPage", entryId: 2 }, page("http://localhost:8099/"))).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
    expect(await fake.send({ type: "fillFromPage", entryId: 3 }, page("http://localhost:8087/"))).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
    expect(await fake.send({ type: "otpFromPage", entryId: 2 }, page("http://localhost:8099/"))).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
    expect(await fake.send({ type: "fillFromPage", entryId: 4 }, page("http://localhost:9000/"))).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
  });
});
