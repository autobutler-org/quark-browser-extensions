import { fakeChrome } from "./fakeChrome";
import type { PageCommand } from "../src/shared/messages";
import { defaultSettings } from "../src/shared/types";

// The context menu's Generate password goes to the one frame the user right-clicked, never to every frame
// in the tab (#74). A broadcast would hand a fresh password to the embedding page and to other iframes.

const connection = { server: "https://quark.local", token: "secret-token" };
const tabId = 7;

type Sent = Readonly<{ tab: number; message: PageCommand; options: { frameId?: number } | undefined }>;

let fake: ReturnType<typeof fakeChrome>;
let sent: Sent[];

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
  const path = new URL(input).pathname.replace(/^\/api\/v0/, "");
  if (`${init?.method ?? "GET"} ${path}` === "POST /vault/generate") {
    return Promise.resolve(json(200, { password: "GEN-SECRET" }));
  }
  return Promise.resolve(json(404, { error: "no route" }));
};

const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const fired = <T extends unknown[]>(event: { listeners: unknown[] }, ...args: T): void =>
  event.listeners.forEach((listener) => (listener as (...a: T) => void)(...args));

beforeEach(async () => {
  vi.resetModules();
  fake = fakeChrome();
  vi.stubGlobal("chrome", fake.chrome);
  vi.stubGlobal("indexedDB", fake.idb.indexedDB);
  sent = [];
  fake.chrome.tabs.sendMessage = ((tab: number, message: PageCommand, options?: { frameId?: number }) => {
    sent.push({ tab, message, options });
    return Promise.resolve(undefined);
  }) as typeof fake.chrome.tabs.sendMessage;
  fake.chrome.contextMenus.removeAll = () => Promise.resolve(undefined);
  fake.chrome.contextMenus.create = () => undefined;
  const { saveConnection, saveSettings } = await import("../src/background/storage");
  await saveConnection(connection, false);
  await saveSettings(defaultSettings);
  vi.stubGlobal("fetch", vi.fn(fetchFn));
  const { main } = await import("../src/background/index");
  main();
  await settle();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const generated = (): readonly Sent[] => sent.filter((record) => record.message.type === "fillGenerated");

describe("a generated password from the context menu", () => {
  it("goes only to the child frame the user right-clicked", async () => {
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "generate", frameId: 5 }, { id: tabId });
    await settle();
    expect(generated()).toEqual([{ tab: tabId, message: { type: "fillGenerated", password: "GEN-SECRET" }, options: { frameId: 5 } }]);
  });

  it("goes only to the top frame when the user right-clicked there", async () => {
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "generate", frameId: 0 }, { id: tabId });
    await settle();
    expect(generated()).toEqual([{ tab: tabId, message: { type: "fillGenerated", password: "GEN-SECRET" }, options: { frameId: 0 } }]);
  });

  it("is never broadcast, even when the browser doesn't say which frame was clicked", async () => {
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "generate" }, { id: tabId });
    await settle();
    expect(generated().map((record) => record.options?.frameId)).toEqual([0]);
  });

  it("isn't sent when the click came from no tab", async () => {
    fired(fake.chrome.contextMenus.onClicked, { menuItemId: "generate", frameId: 0 }, undefined);
    await settle();
    expect(JSON.stringify(sent)).not.toContain("GEN-SECRET");
  });
});
