import { createCache, deriveState } from "../src/background/state";

const status = (overrides: Partial<{ initialized: boolean; locked: boolean; deviceConnected: boolean }> = {}) => ({
  ok: true as const,
  value: {
    initialized: true,
    locked: false,
    autoLockSeconds: 900,
    deviceConnected: true,
    lockReason: "",
    ...overrides,
  },
});

const server = "https://quark.local";

describe("deriveState", () => {
  it("is disconnected without a server", () => {
    expect(deriveState("", false, null)).toEqual({ kind: "disconnected" });
  });

  it("is signed out without a token", () => {
    expect(deriveState(server, false, null)).toEqual({ kind: "signedOut", server });
  });

  it("reads the vault status", () => {
    expect(deriveState(server, true, status())).toEqual({ kind: "unlocked", server, autoLockSeconds: 900 });
    expect(deriveState(server, true, status({ locked: true }))).toEqual({ kind: "locked", server, reason: "" });
    expect(deriveState(server, true, status({ initialized: false }))).toEqual({ kind: "notInitialized", server });
    expect(deriveState(server, true, status({ deviceConnected: false }))).toEqual({ kind: "driveDisconnected", server });
  });

  it("maps errors", () => {
    expect(deriveState(server, true, { ok: false, error: { kind: "notAdmin" } })).toEqual({ kind: "notAdmin", server });
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
