import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";
import { opened, openVault, vaultRoutes, type EntryFixture } from "./fakeVault";
import { pendingTtlMs } from "../src/background/save";

const serverUrl = "https://quark.local";
const connection = { server: serverUrl, token: ["session", "credential"].join("-") };
const popup: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionUrl}popup.html` };
const tabId = 17;

const password = (version: string): string => [version, "login", "password"].join("-");
type Call = Readonly<{ method: string; path: string; body: unknown }>;

let fake: ReturnType<typeof fakeChrome>;
let calls: Call[];
let entries: EntryFixture[];
let locked: boolean;

beforeEach(() => {
  vi.resetModules();
  fake = fakeChrome();
  calls = [];
  entries = [];
  locked = false;
  vi.stubGlobal("chrome", fake.chrome);
  vi.stubGlobal("indexedDB", fake.idb.indexedDB);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const startWorker = async (): Promise<void> => {
  const { saveConnection } = await import("../src/background/storage");
  await saveConnection(connection, false);
  if (!locked) {
    await openVault(fake.chrome.storage.session, connection.server);
  }
  const vault = vaultRoutes(entries);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const path = new URL(input).pathname.replace(/^\/api\/v0/, "");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      return Promise.resolve(vault.handle(method, path, body) ?? new Response(null, { status: 404 }));
    }),
  );
  const { main } = await import("../src/background/index");
  main();
};

const page = (url: string): chrome.runtime.MessageSender => ({
  id: extensionId,
  url,
  tab: { id: tabId, url } as chrome.tabs.Tab,
  frameId: 0,
});

const captured = (url: string, username: string, value: string) =>
  fake.send({ type: "captured", username, password: value }, page(url));

const resolveFromPage = (url: string, action: "save" | "update" | "never" | "dismiss" | "unlock") =>
  fake.send({ type: "resolveSave", action }, page(url));

const requests = (method: string, path: string): Call[] =>
  calls.filter((call) => call.method === method && call.path === path);

describe("resolving a captured login in the worker", () => {
  it("saves a new login with the submitted credentials", async () => {
    await startWorker();
    const url = "https://accounts.example/login";
    const submitted = password("new");

    expect(await captured(url, "alice", submitted)).toEqual({
      kind: "save",
      host: "accounts.example",
      username: "alice",
    });
    expect(await resolveFromPage(url, "save")).toEqual({ ok: true, value: null });
    const [sent] = requests("POST", "/vault/items").map(({ body }) => body);
    expect(JSON.stringify(sent)).not.toContain(submitted);
    expect(opened(sent)).toEqual({ kind: "entry", name: "accounts.example", url: "https://accounts.example", username: "alice", password: submitted });
    expect(await fake.send({ type: "pendingOffer", tabId }, popup)).toBeNull();
  });

  it("updates the matching login while preserving its other fields", async () => {
    const previous = password("previous");
    const submitted = password("replacement");
    entries = [
      {
        id: 4,
        name: "Example account",
        url: "https://accounts.example/login",
        username: "alice",
        password: previous,
        notes: "keep me",
        customFields: [{ label: "pin", value: "1234", hidden: true }],
        folderId: 3,
      },
    ];
    await startWorker();

    expect(await captured("https://accounts.example/login", "alice", submitted)).toMatchObject({
      kind: "update",
      entryId: 4,
    });
    expect(await resolveFromPage("https://accounts.example/login", "update")).toEqual({ ok: true, value: null });
    const [sent] = requests("PUT", "/vault/items/4").map(({ body }) => body);
    expect(JSON.stringify(sent)).not.toContain(submitted);
    expect(opened(sent)).toEqual({
      kind: "entry",
      name: "Example account",
      url: "https://accounts.example/login",
      username: "alice",
      password: submitted,
      notes: "keep me",
      customFields: [{ label: "pin", value: "1234", hidden: true }],
      folderId: 3,
    });
  });

  // autobutler-org/quark#3601: an entry's androidApps link, and any field a newer app adds, survive a rewrite here.
  it("keeps fields it doesn't know when it rewrites a login", async () => {
    const submitted = password("replacement");
    const unknown = {
      androidApps: [{ packageName: "com.example.app", sha256CertFingerprints: ["AB:CD:EF"] }],
      futureField: { nested: [1, "two", null] },
    };
    entries = [{ id: 5, name: "Example", url: "https://accounts.example/login", username: "alice", password: password("previous"), ...unknown }];
    await startWorker();

    expect(await captured("https://accounts.example/login", "alice", submitted)).toMatchObject({ kind: "update", entryId: 5 });
    expect(await resolveFromPage("https://accounts.example/login", "update")).toEqual({ ok: true, value: null });
    const [sent] = requests("PUT", "/vault/items/5").map(({ body }) => body);
    expect(opened(sent)).toEqual({
      kind: "entry",
      name: "Example",
      url: "https://accounts.example/login",
      username: "alice",
      password: submitted,
      ...unknown,
    });
  });

  it("remembers when the user never wants save offers for a site", async () => {
    await startWorker();
    const url = "https://accounts.example/login";

    expect(await captured(url, "alice", password("first"))).toMatchObject({ kind: "save" });
    expect(await resolveFromPage(url, "never")).toEqual({ ok: true, value: null });
    expect(await fake.send({ type: "neverSaveList" }, popup)).toEqual(["accounts.example"]);
    expect(await captured(url, "alice", password("second"))).toBeNull();
  });

  it("opens the popup when saving requires an unlock", async () => {
    locked = true;
    const openPopup = vi.spyOn(fake.chrome.action, "openPopup");
    await startWorker();
    const url = "https://accounts.example/login";

    expect(await captured(url, "alice", password("new"))).toMatchObject({ kind: "unlock" });
    expect(await resolveFromPage(url, "unlock")).toEqual({ ok: true, value: null });
    expect(openPopup).toHaveBeenCalledOnce();
  });

  it("explains when there is no longer a captured login to resolve", async () => {
    await startWorker();
    expect(await fake.send({ type: "resolveSave", action: "save", tabId }, popup)).toEqual({
      ok: false,
      error: { kind: "refused", reason: "That login is no longer waiting to be saved." },
    });
  });

  // "Not now" on a bar whose login timed out was refused, so the bar could never be closed.
  it("lets a login that has timed out still be dismissed", async () => {
    await startWorker();
    const url = "https://accounts.example/login";
    expect(await captured(url, "alice", password("new"))).toMatchObject({ kind: "save" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + pendingTtlMs);
    expect(await resolveFromPage(url, "dismiss")).toEqual({ ok: true, value: null });
    expect(await resolveFromPage(url, "save")).toMatchObject({ ok: false, error: { kind: "refused" } });
  });
});
