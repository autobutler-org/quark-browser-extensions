import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";

const connection = { server: "https://quark.local", token: "secret-token" };
const popup: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionUrl}popup.html` };
const tabId = 7;

// One box running several services, as self-hosters do, plus a login elsewhere.
const details = [
  { id: 1, name: "Router", url: "http://localhost:8099/basic.html", urlHost: "localhost" },
  { id: 2, name: "NAS", url: "http://localhost:8087/login", urlHost: "localhost" },
  { id: 3, name: "Quark", url: "https://localhost:8087", urlHost: "localhost" },
  { id: 4, name: "GitHub", url: "https://github.com", urlHost: "github.com" },
].map((entry) => ({ ...entry, username: `${entry.name}-user`, password: `${entry.name}-secret`, totpSecret: "" }));

const summaries = details.map(({ id, name, urlHost }) => ({ id, name, urlHost, folderId: null, createdAt: "", updatedAt: "v1" }));

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

const startWorker = async () => {
  const { saveConnection } = await import("../src/background/storage");
  await saveConnection(connection, false);
  const fetchSpy = vi.fn(async (url: string) => {
    if (url.endsWith("/vault/entries")) {
      return json(200, { entries: summaries });
    }
    const detail = details.find((entry) => url.endsWith(`/vault/entries/${entry.id}`));
    return detail === undefined ? json(404) : json(200, detail);
  });
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

const detailFetches = (fetchSpy: ReturnType<typeof vi.fn>): readonly string[] =>
  fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => /\/vault\/entries\/\d+$/.test(url));

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

  it("looks up only the entries on the page's host, and only once", async () => {
    const fetchSpy = await startWorker();
    await fake.send({ type: "matches", pageUrl: "http://localhost:8087/" }, popup);
    await fake.send({ type: "matches", pageUrl: "http://localhost:8099/" }, popup);
    const fetched = detailFetches(fetchSpy);
    expect(fetched).toHaveLength(3);
    expect(fetched.some((url) => url.endsWith("/vault/entries/4"))).toBe(false);
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
    expect(titles()).toEqual(["Fill Router", "Fill NAS (localhost:8087/login)", "Fill Quark (https://localhost:8087)"]);
    create.mockClear();
    await fake.send({ type: "fieldFocused" }, page("http://localhost:8087/login"));
    expect(titles()).toEqual(["Fill NAS", "Fill Router (localhost:8099/basic.html)", "Fill Quark (https://localhost:8087)"]);
  });

  it("still fills a fallback the user picks, on the same host only", async () => {
    await startWorker();
    expect(await fake.send({ type: "fillFromPage", entryId: 1 }, page("http://localhost:9000/"))).toMatchObject({
      ok: true,
      value: { password: "Router-secret" },
    });
    expect(await fake.send({ type: "fillFromPage", entryId: 4 }, page("http://localhost:9000/"))).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
  });
});
