import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";
import type { EntryDetail } from "../src/shared/types";

const serverUrl = "https://quark.local";
const connection = { server: serverUrl, token: ["session", "credential"].join("-") };
const popup: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionUrl}popup.html` };
const tabId = 17;

const password = (version: string): string => [version, "login", "password"].join("-");
const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = Readonly<{ method: string; path: string; body: unknown }>;

let fake: ReturnType<typeof fakeChrome>;
let calls: Call[];
let entries: EntryDetail[];
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
});

const startWorker = async (): Promise<void> => {
  const { saveConnection } = await import("../src/background/storage");
  await saveConnection(connection, false);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/v0/, "");
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });

      if (method === "GET" && path === "/vault/status") {
        return Promise.resolve(
          json(200, { initialized: true, locked, deviceConnected: true, autoLockSeconds: 900, lockReason: "" }),
        );
      }
      if (method === "GET" && path === "/vault/entries") {
        return Promise.resolve(
          json(200, {
            entries: entries.map(({ id, name, urlHost }) => ({
              id,
              name,
              urlHost,
              folderId: null,
              createdAt: "created",
              updatedAt: "updated",
            })),
          }),
        );
      }
      const detail = /^\/vault\/entries\/(\d+)$/.exec(path);
      if (method === "GET" && detail !== null) {
        const found = entries.find((entry) => entry.id === Number(detail[1]));
        return Promise.resolve(found === undefined ? json(404, { error: "not found" }) : json(200, found));
      }
      if (method === "POST" && path === "/vault/entries") {
        return Promise.resolve(json(200, { id: 99 }));
      }
      if (method === "PUT" && detail !== null) {
        return Promise.resolve(json(200));
      }
      return Promise.resolve(json(404, { error: "not found" }));
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
    expect(requests("POST", "/vault/entries").map(({ body }) => body)).toEqual([
      { name: "accounts.example", url: "https://accounts.example", username: "alice", password: submitted },
    ]);
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
        urlHost: "accounts.example",
        username: "alice",
        password: previous,
        totpSecret: "",
      },
    ];
    await startWorker();

    expect(await captured("https://accounts.example/login", "alice", submitted)).toMatchObject({
      kind: "update",
      entryId: 4,
    });
    expect(await resolveFromPage("https://accounts.example/login", "update")).toEqual({ ok: true, value: null });
    expect(requests("PUT", "/vault/entries/4").map(({ body }) => body)).toEqual([
      expect.objectContaining({ name: "Example account", username: "alice", password: submitted }),
    ]);
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
    expect(await fake.send({ type: "resolveSave", action: "dismiss", tabId }, popup)).toEqual({
      ok: false,
      error: { kind: "refused", reason: "That login is no longer waiting to be saved." },
    });
  });
});
