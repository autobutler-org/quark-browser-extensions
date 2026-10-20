import { openVault, vaultFetch } from "./fakeVault";
import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";
import type { PageCommand } from "../src/shared/messages";

// A subframe gets a login only if the frame element it is drawn in, and each one above it, is shown (#141). The
// worker can't trust a frame about itself, so it has the parent's content script measure the <iframe>.

const connection = { server: "https://quark.local", token: "secret-token" };
const tabId = 7;

const entry = {
  id: 1,
  name: "Example",
  url: "https://example.com/login",
  urlHost: "example.com",
  username: "alice",
  password: "hunter2-secret",
  totpSecret: "",
};

const frame = (url: string, frameId: number, tab = tabId): chrome.runtime.MessageSender => ({
  id: extensionId,
  url,
  tab: { id: tab } as chrome.tabs.Tab,
  frameId,
});

const hidden = "This login form is in a frame you can't see on this page, so Quark Vault won't fill it.";

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

type Sent = Readonly<{ message: PageCommand; frameId: number | undefined }>;

// `parents` says, for each child frame id, which frame reports on it and what it says. A frame missing from it
// gets no report, as when its parent has no content script.
const setup = async (parents: Readonly<Record<number, readonly [parent: number, shown: boolean]>>) => {
  const { saveConnection } = await import("../src/background/storage");
  await saveConnection(connection, false);
  await openVault(fake.chrome.storage.session, connection.server);
  const sent: Sent[] = [];
  fake.chrome.tabs.sendMessage = ((_tab: number, message: PageCommand, options?: { frameId?: number }) => {
    sent.push({ message, frameId: options?.frameId });
    if (message.type === "whereAmI") {
      return Promise.resolve("https://example.com/");
    }
    const report = options?.frameId === undefined ? undefined : parents[options.frameId];
    if (message.type === "announceFrame" && report !== undefined) {
      const [parent, shown] = report;
      void fake.send({ type: "frameReport", nonce: message.nonce, shown }, frame("https://example.com/", parent));
    }
    return Promise.resolve(undefined);
  }) as typeof fake.chrome.tabs.sendMessage;
  vi.stubGlobal("fetch", vi.fn(vaultFetch([entry])));
  const { main } = await import("../src/background/index");
  main();
  return sent;
};

const fillFromPage = (sender: chrome.runtime.MessageSender) => fake.send({ type: "fillFromPage", entryId: 1 }, sender);

const granted = { ok: true, value: { username: entry.username, password: entry.password, autoSubmit: false } };
const refusedHidden = { ok: false, error: { kind: "refused", reason: hidden } };

it("fills a same-site subframe its parent reports as shown", async () => {
  const sent = await setup({ 4: [0, true] });
  expect(await fillFromPage(frame("https://login.example.com/", 4))).toEqual(granted);
  const probes = sent.filter((found) => found.message.type === "announceFrame");
  expect(probes).toEqual([{ message: { type: "announceFrame", nonce: expect.any(String) as unknown }, frameId: 4 }]);
});

it("refuses a subframe its parent reports as hidden", async () => {
  await setup({ 4: [0, false] });
  expect(await fillFromPage(frame("https://evil.example.com/trap", 4))).toEqual(refusedHidden);
});

it("refuses a subframe no parent reports on", async () => {
  await setup({});
  expect(await fillFromPage(frame("https://evil.example.com/trap", 4))).toEqual(refusedHidden);
});

it("checks every frame up to the top", async () => {
  const sent = await setup({ 9: [3, true], 3: [0, true] });
  expect(await fillFromPage(frame("https://login.example.com/", 9))).toEqual(granted);
  expect(sent.filter((found) => found.message.type === "announceFrame").map((found) => found.frameId)).toEqual([9, 3]);
});

it("refuses a shown subframe inside a hidden one", async () => {
  await setup({ 9: [3, true], 3: [0, false] });
  expect(await fillFromPage(frame("https://login.example.com/", 9))).toEqual(refusedHidden);
});

it("refuses a chain that loops", async () => {
  await setup({ 9: [3, true], 3: [9, true] });
  expect(await fillFromPage(frame("https://login.example.com/", 9))).toEqual(refusedHidden);
});

it("doesn't probe the top frame", async () => {
  const sent = await setup({});
  expect(await fillFromPage(frame("https://example.com/login", 0))).toEqual(granted);
  expect(sent.some((found) => found.message.type === "announceFrame")).toBe(false);
});

it("doesn't probe a frame it refuses for its URL", async () => {
  const sent = await setup({ 4: [0, true] });
  expect(await fillFromPage(frame("https://ads.example.net/", 4))).toMatchObject({ ok: false });
  expect(sent.some((found) => found.message.type === "announceFrame")).toBe(false);
});

describe("reports it doesn't take", () => {
  // The probe goes to frame 4; the report comes from wherever `reporter` says.
  const reportFrom = async (reporter: (nonce: string) => Promise<unknown> | undefined) => {
    await setup({});
    const announced = new Promise<string>((resolve) => {
      const send = fake.chrome.tabs.sendMessage as unknown as (tab: number, message: PageCommand, options?: { frameId?: number }) => Promise<unknown>;
      fake.chrome.tabs.sendMessage = ((tab: number, message: PageCommand, options?: { frameId?: number }) => {
        if (message.type === "announceFrame") {
          resolve(message.nonce);
        }
        return send(tab, message, options);
      }) as typeof fake.chrome.tabs.sendMessage;
    });
    const reply = fillFromPage(frame("https://login.example.com/", 4));
    await reporter(await announced);
    return reply;
  };

  it("ignores a report from another tab", async () => {
    const reply = await reportFrom((nonce) => fake.send({ type: "frameReport", nonce, shown: true }, frame("https://example.com/", 0, 99)));
    expect(reply).toEqual(refusedHidden);
  });

  it("ignores a report for a nonce it never gave out", async () => {
    const reply = await reportFrom(() => fake.send({ type: "frameReport", nonce: "guessed", shown: true }, frame("https://example.com/", 0)));
    expect(reply).toEqual(refusedHidden);
  });

  it("ignores a report from a page rather than a content script", async () => {
    const reply = await reportFrom((nonce) =>
      fake.send({ type: "frameReport", nonce, shown: true }, { id: extensionId, url: `${extensionUrl}popup.html` }),
    );
    expect(reply).toEqual(refusedHidden);
  });

  it("takes only the first report for a nonce", async () => {
    const reply = await reportFrom(async (nonce) => {
      await fake.send({ type: "frameReport", nonce, shown: false }, frame("https://example.com/", 0));
      await fake.send({ type: "frameReport", nonce, shown: true }, frame("https://example.com/", 0));
    });
    expect(reply).toEqual(refusedHidden);
  });
});
