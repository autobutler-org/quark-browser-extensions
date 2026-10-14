import { createApi, type FetchFn } from "../src/shared/api";
import { accountId } from "../src/shared/authKey";
import { fakeChrome } from "./fakeChrome";

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

const ledger = async () => (await import("../src/background/keyedAccounts")).upgradeLedger;

const salt = btoa(String.fromCharCode(...Uint8Array.from({ length: 16 }, (_, i) => i)));

const legacyQuark = (bodies: Record<string, unknown>[]): FetchFn => (url, init) => {
  if (init?.body !== undefined) {
    bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
  }
  const body = url.includes("/auth/salt") ? { salt, legacy: true } : { token: "abc" };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
};

describe("the upgraded-account record (#143)", () => {
  it("still refuses a second legacy upgrade after a content script deletes keyedAccounts", async () => {
    const record = await ledger();
    const bodies: Record<string, unknown>[] = [];
    const api = createApi(legacyQuark(bodies), record, () => Promise.resolve("key"));
    await record.giveConsent("https://quark.local", "brandon");
    expect((await api.login("https://quark.local", "brandon", "pw")).ok).toBe(true);

    await fake.chrome.storage.local.remove("keyedAccounts");
    await record.giveConsent("https://quark.local", "brandon");
    expect((await api.login("https://quark.local", "brandon", "pw")).ok).toBe(false);
    expect(bodies.filter((body) => "password" in body)).toHaveLength(1);
  });

  it("keeps nothing about upgraded accounts where content scripts can write", async () => {
    const record = await ledger();
    await record.markKeyed("https://quark.local", "brandon");
    expect(JSON.stringify([...fake.chrome.storage.local.items])).not.toContain(accountId("https://quark.local", "brandon"));
  });

  it("survives a restart, which keeps IndexedDB", async () => {
    await (await ledger()).markKeyed("https://quark.local", "brandon");
    vi.resetModules();
    expect(await (await ledger()).hasKey("https://quark.local", "brandon")).toBe(true);
  });

  it("brings an older build's list over from storage.local once, then deletes it", async () => {
    const id = accountId("https://quark.local", "brandon");
    await fake.chrome.storage.local.set({ keyedAccounts: [id, 7] });
    const record = await ledger();
    expect(await record.hasKey("https://quark.local", "brandon")).toBe(true);
    expect(fake.idb.stores.get("keys")?.get("keyedAccounts")).toEqual([id]);
    expect(fake.chrome.storage.local.items.has("keyedAccounts")).toBe(false);

    // A list planted there later means nothing.
    await fake.chrome.storage.local.set({ keyedAccounts: [accountId("https://quark.local", "sam")] });
    expect(await record.hasKey("https://quark.local", "sam")).toBe(false);
  });

  it("migrates once when asked in parallel", async () => {
    const id = accountId("https://quark.local", "brandon");
    await fake.chrome.storage.local.set({ keyedAccounts: [id] });
    const { keyedAccounts } = await import("../src/background/keyedAccounts");
    expect(await Promise.all([keyedAccounts.load(), keyedAccounts.load()])).toEqual([[id], [id]]);
    expect(fake.idb.stores.get("keys")?.get("keyedAccounts")).toEqual([id]);
  });

  it("starts empty on a fresh install, so a first upgrade can go out with consent", async () => {
    const record = await ledger();
    expect(await record.hasKey("https://quark.local", "brandon")).toBe(false);
    expect(fake.idb.stores.get("keys")?.get("keyedAccounts")).toEqual([]);
  });
});
