import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeChrome } from "./fakeChrome";
import { detectionIntervalSeconds, idleAction } from "../src/background/idle";
import { defaultSettings, type Settings } from "../src/shared/types";

// Firefox's idle API never reports "locked" (#132): a screen lock only shows up as "idle" once the detection
// interval passes with no input. So on Firefox "idle" stands in for the screen lock and locks the vault even
// with lock-on-idle off.

const settingsFor = (lockOnIdle: boolean): Settings => ({ ...defaultSettings, lockOnIdle, idleMinutes: 15 });
const off = settingsFor(false);

describe("idleAction", () => {
  it.each([
    ["chrome", "locked", false, "lock"],
    ["chrome", "idle", false, "none"],
    ["chrome", "idle", true, "lock"],
    ["chrome", "active", true, "none"],
    ["firefox", "idle", false, "lock"],
    ["firefox", "idle", true, "lock"],
    ["firefox", "active", false, "none"],
    ["firefox", "locked", false, "lock"],
  ] as const)("on %s, %s with lock-on-idle %s is %s", (browser, state, lockOnIdle, action) => {
    expect(idleAction(state, settingsFor(lockOnIdle), browser)).toBe(action);
  });

  it("uses the idle time as the detection interval on both browsers", () => {
    expect(detectionIntervalSeconds(off)).toBe(900);
    expect(detectionIntervalSeconds({ ...off, idleMinutes: 5 })).toBe(300);
  });
});

describe("the worker on Firefox", () => {
  let fake: ReturnType<typeof fakeChrome>;
  const lockCalls: string[] = [];
  const intervals: number[] = [];

  beforeEach(() => {
    vi.resetModules();
    fake = fakeChrome();
    fake.chrome.runtime.getURL = (path: string) => `moz-extension://quark/${path}`;
    // Firefox 158's idle API: only "active" and "idle".
    fake.chrome.idle.setDetectionInterval = ((seconds: number) => void intervals.push(seconds)) as typeof fake.chrome.idle.setDetectionInterval;
    vi.stubGlobal("chrome", fake.chrome);
    vi.stubGlobal("indexedDB", fake.idb.indexedDB);
    lockCalls.length = 0;
    intervals.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        if (init?.method === "POST" && new URL(input).pathname.endsWith("/vault/lock")) {
          lockCalls.push(input);
        }
        return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 20; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const start = async (settings: Settings): Promise<void> => {
    const { saveConnection, saveSettings } = await import("../src/background/storage");
    await saveConnection({ server: "https://quark.local", token: "secret-token" }, false);
    await saveSettings(settings);
    const { main } = await import("../src/background/index");
    main();
    await settle();
  };

  const fire = (state: string): void =>
    fake.chrome.idle.onStateChanged.listeners.forEach((listener) => (listener as (state: string) => void)(state));

  it("locks the vault when Firefox reports idle, even with lock-on-idle off", async () => {
    await start(off);
    expect(intervals).toEqual([900]);
    fire("idle");
    await settle();
    expect(lockCalls).toEqual(["https://quark.local/api/v0/vault/lock"]);
  });

  it("does not lock when Firefox reports active", async () => {
    await start(off);
    fire("active");
    await settle();
    expect(lockCalls).toEqual([]);
  });
});
