import { extensionId, extensionUrl, fakeChrome } from "./fakeChrome";
import type { PageCommand } from "../src/shared/messages";
import { defaultSettings } from "../src/shared/types";

// "Fill anyway" end to end in the worker: the popup's request, the command to the tab, and the top frame
// collecting the credentials under the one-time grant.

const connection = { server: "https://quark.local", token: "secret-token" };
const popup: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionUrl}popup.html` };
const tabId = 7;
const pageUrl = "https://forum.example/login";

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

const frame = (url: string, frameId: number, tab = tabId): chrome.runtime.MessageSender => ({
  id: extensionId,
  url,
  tab: { id: tab } as chrome.tabs.Tab,
  frameId,
});

type Sent = Readonly<{ tab: number; message: PageCommand; options: { frameId?: number } | undefined }>;

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

// `onFill` plays the tab's content script: it gets each fill command and answers for the tab.
const setup = async (tabUrl: string | undefined, onFill: (sent: Sent) => Promise<unknown> = () => Promise.resolve(undefined)) => {
  const { saveConnection, saveSettings } = await import("../src/background/storage");
  await saveConnection(connection, false);
  await saveSettings({ ...defaultSettings, autoSubmit: true });
  const sent: Sent[] = [];
  fake.chrome.tabs.get = (id: number) => Promise.resolve({ id, ...(tabUrl === undefined ? {} : { url: tabUrl }) } as chrome.tabs.Tab);
  fake.chrome.tabs.sendMessage = ((tab: number, message: PageCommand, options?: { frameId?: number }) => {
    const record = { tab, message, options };
    sent.push(record);
    if (message.type === "whereAmI") {
      return Promise.resolve(options?.frameId === 0 ? tabUrl : undefined);
    }
    return onFill(record);
  }) as typeof fake.chrome.tabs.sendMessage;
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.endsWith("/vault/entries/1") ? json(200, entry) : json(200, {}))));
  const { main } = await import("../src/background/index");
  main();
  return sent;
};

const fillAnyway = (pageHost: string, sender = popup) => fake.send({ type: "fillAnyway", tabId, entryId: 1, pageHost }, sender);
const fillFromPage = (sender: chrome.runtime.MessageSender) => fake.send({ type: "fillFromPage", entryId: 1 }, sender);

describe("fillAnyway", () => {
  it("lets the confirmed top frame collect the entry once, without auto-submitting", async () => {
    const collected: unknown[] = [];
    const sent = await setup(pageUrl, async () => {
      collected.push(await fillFromPage(frame(pageUrl, 0)));
      collected.push(await fillFromPage(frame(pageUrl, 0)));
      return { ok: true, value: null };
    });
    expect(await fillAnyway("forum.example")).toEqual({ ok: true, value: null });
    expect(collected).toEqual([
      { ok: true, value: { username: entry.username, password: entry.password, autoSubmit: false } },
      { ok: false, error: { kind: "refused", reason: "This login doesn't belong to this site." } },
    ]);
    const fills = sent.filter((s) => s.message.type === "fill");
    expect(fills).toEqual([
      { tab: tabId, message: { type: "fill", entryId: 1, entryUrl: pageUrl, entryHost: "forum.example", topUrl: pageUrl }, options: { frameId: 0 } },
    ]);
    expect(JSON.stringify(sent)).not.toContain(entry.password);
    expect(JSON.stringify(sent)).not.toContain(entry.username);
  });

  it.each([
    ["a sub frame of the tab", frame(pageUrl, 3)],
    ["another site's sub frame", frame("https://ads.example/frame", 3)],
    ["the top frame of another tab", frame(pageUrl, 0, 8)],
    ["a top frame on another origin", frame("https://evil.example/login", 0)],
  ])("refuses %s while the grant is open", async (_, sender) => {
    const collected: unknown[] = [];
    await setup(pageUrl, async () => {
      collected.push(await fillFromPage(sender));
      return undefined;
    });
    await fillAnyway("forum.example");
    expect(collected).toEqual([{ ok: false, error: { kind: "refused", reason: expect.any(String) as unknown } }]);
  });

  it("leaves no grant behind once the tab has answered", async () => {
    await setup(pageUrl, () => Promise.resolve(undefined));
    expect(await fillAnyway("forum.example")).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect(await fillFromPage(frame(pageUrl, 0))).toMatchObject({ ok: false, error: { kind: "refused" } });
  });

  it("gives nothing to a page that asks without the user's confirm", async () => {
    await setup(pageUrl);
    expect(await fillFromPage(frame(pageUrl, 0))).toMatchObject({ ok: false, error: { kind: "refused" } });
  });

  it("can't be started by a content script", async () => {
    const sent = await setup(pageUrl);
    expect(fillAnyway("forum.example", frame(pageUrl, 0))).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("refuses when the tab is no longer on the host the user confirmed", async () => {
    const sent = await setup("https://evil.example/login");
    expect(await fillAnyway("forum.example")).toEqual({
      ok: false,
      error: { kind: "refused", reason: "This tab is now on evil.example, not forum.example. Open the popup again to fill it." },
    });
    expect(sent.filter((s) => s.message.type === "fill")).toEqual([]);
  });

  it.each([["a browser page", "chrome://settings"], ["a tab whose URL the browser withholds", undefined]])("refuses %s", async (_, url) => {
    const sent = await setup(url);
    expect(await fillAnyway("")).toEqual({ ok: false, error: { kind: "refused", reason: "This page can't be filled." } });
    expect(sent).toEqual([]);
  });

  it("fills an entry saved for another port on the same host only through the grant", async () => {
    const otherPort = "https://github.com:8443/login";
    const collected: unknown[] = [];
    const sent = await setup(otherPort, async () => {
      collected.push(await fillFromPage(frame(otherPort, 0)));
      return { ok: true, value: null };
    });
    expect(await fillFromPage(frame(otherPort, 0))).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect(await fillAnyway("github.com:8443")).toEqual({ ok: true, value: null });
    expect(collected).toEqual([{ ok: true, value: { username: entry.username, password: entry.password, autoSubmit: false } }]);
    expect(sent.find((s) => s.message.type === "fill")).toMatchObject({ message: { entryUrl: otherPort }, options: { frameId: 0 } });
  });

  it("takes the usual path for an entry that matches the page after all", async () => {
    const sent = await setup("https://github.com/login", () => Promise.resolve({ ok: true, value: null }));
    expect(await fillAnyway("github.com")).toEqual({ ok: true, value: null });
    const fill = sent.find((s) => s.message.type === "fill");
    expect(fill).toMatchObject({ message: { entryUrl: entry.url, entryHost: entry.urlHost }, options: undefined });
  });

  it("says so when the page can't be reached", async () => {
    await setup(pageUrl, () => Promise.reject(new Error("no receiver")));
    expect(await fillAnyway("forum.example")).toEqual({
      ok: false,
      error: { kind: "refused", reason: "This page can't be filled. Reload it and try again." },
    });
  });
});
