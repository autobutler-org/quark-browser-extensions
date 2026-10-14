import { extensionId, fakeChrome } from "./fakeChrome";
import { postSubmitWindowMs } from "../src/background/save";

// The worker keeps a submitted login per tab and offers it again when a page in that tab finishes loading.
// These tests drive that lifetime through tabs.onUpdated, the way Chrome reports navigations (#44).

const tabId = 7;
const loginPage = "https://example.com/login";
const top = (url: string): chrome.runtime.MessageSender => ({
  id: extensionId,
  tab: { id: tabId } as chrome.tabs.Tab,
  frameId: 0,
  url,
});
// With every Quark call failing the worker treats the vault as locked, so any capture on https yields an unlock offer.
const unlockOffer = { kind: "unlock", host: "example.com", username: "alice" };

let fake: ReturnType<typeof fakeChrome>;
let checks: number;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  fake = fakeChrome();
  vi.stubGlobal("chrome", fake.chrome);
  vi.stubGlobal("indexedDB", fake.idb.indexedDB);
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 500 })));
  checks = 0;
  fake.chrome.tabs.sendMessage = () => {
    checks += 1;
    return Promise.resolve(undefined);
  };
  const { saveConnection } = await import("../src/background/storage");
  await saveConnection({ server: "https://quark.local", token: "t" }, false);
  const { main } = await import("../src/background/index");
  main();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const updated = (status: "loading" | "complete"): void => {
  (fake.chrome.tabs.onUpdated.listeners as ((id: number, info: { status: string }) => void)[]).forEach((listener) =>
    listener(tabId, { status }),
  );
};

const navigate = (): void => {
  updated("loading");
  updated("complete");
};

const capture = () => fake.send({ type: "captured", username: "alice", password: "s3cret" }, top(loginPage));
const myOffer = (url: string) => fake.send({ type: "myOffer" }, top(url));
const popupOffer = () =>
  fake.send(
    { type: "pendingOffer", tabId },
    {
      id: fake.chrome.runtime.id,
      url: fake.chrome.runtime.getURL("popup.html"),
    },
  );

describe("how long a submitted login is offered", () => {
  it("offers on the page that submitted", async () => {
    expect(await capture()).toEqual(unlockOffer);
  });

  it("offers again on the page the submit lands on", async () => {
    await capture();
    navigate();
    expect(checks).toBe(1);
    expect(await myOffer("https://example.com/home")).toEqual(unlockOffer);
    expect(await popupOffer()).toEqual(unlockOffer);
  });

  it("drops the login on the next navigation after that", async () => {
    await capture();
    navigate();
    navigate();
    expect(checks).toBe(1);
    expect(await myOffer("https://example.com/settings")).toBeNull();
    expect(await popupOffer()).toBeNull();
  });

  it("drops the login when the first navigation comes after the post-submit window", async () => {
    await capture();
    vi.setSystemTime(Date.now() + postSubmitWindowMs);
    navigate();
    expect(checks).toBe(0);
    expect(await popupOffer()).toBeNull();
  });

  it("drops the login when the landing page is on another site", async () => {
    await capture();
    navigate();
    expect(await myOffer("https://elsewhere.test/")).toBeNull();
    expect(await popupOffer()).toBeNull();
  });

  it("drops the login when the tab closes", async () => {
    await capture();
    (fake.chrome.tabs.onRemoved.listeners as ((id: number) => void)[]).forEach((listener) => listener(tabId));
    expect(await popupOffer()).toBeNull();
  });

  it("starts over when the landing page submits another login", async () => {
    await capture();
    navigate();
    await capture();
    navigate();
    expect(checks).toBe(2);
    expect(await popupOffer()).toEqual(unlockOffer);
  });
});
