import { createCache, deriveState } from "../src/background/state";

const server = "https://quark.local";

describe("deriveState", () => {
  it("is disconnected without a server", () => {
    expect(deriveState("", false, null)).toEqual({ kind: "disconnected" });
  });

  it("is signed out without a token", () => {
    expect(deriveState(server, false, null)).toEqual({ kind: "signedOut", server });
  });

  it("is unlocked while this browser holds the vault key, which locks after 15 minutes unused", () => {
    expect(deriveState(server, true, { ok: true, value: true })).toEqual({ kind: "unlocked", server, autoLockSeconds: 900 });
    expect(deriveState(server, true, { ok: true, value: false })).toEqual({ kind: "locked", server });
  });

  it("maps errors", () => {
    expect(deriveState(server, true, { ok: false, error: { kind: "notInitialized" } })).toEqual({ kind: "notInitialized", server });
    expect(deriveState(server, true, { ok: false, error: { kind: "network", message: "down" } })).toEqual({
      kind: "unreachable",
      server,
      message: "down",
    });
  });
});

describe("createCache", () => {
  it("expires after its ttl and can be cleared", () => {
    let now = 0;
    const cache = createCache<string>(1000, () => now);
    cache.set("a");
    now = 999;
    expect(cache.get()).toBe("a");
    now = 1000;
    expect(cache.get()).toBeUndefined();
    cache.set("b");
    cache.clear();
    expect(cache.get()).toBeUndefined();
  });
});
