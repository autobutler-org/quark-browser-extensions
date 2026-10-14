import { deriveState, stateFromError } from "../src/background/state";
import type { ApiError, VaultState } from "../src/shared/types";

const server = "https://quark.local";

describe("vault states reported for API failures", () => {
  it.each<[ApiError, VaultState]>([
    [{ kind: "signedOut" }, { kind: "signedOut", server }],
    [{ kind: "badCredentials" }, { kind: "signedOut", server }],
    [{ kind: "accountRefused", status: "disabled" }, { kind: "signedOut", server }],
    [{ kind: "notAdmin" }, { kind: "notAdmin", server }],
    [{ kind: "notInitialized" }, { kind: "notInitialized", server }],
    [{ kind: "driveDisconnected" }, { kind: "driveDisconnected", server }],
    [{ kind: "locked", reason: "screen locked" }, { kind: "locked", server, reason: "screen locked" }],
    [{ kind: "network", message: "offline" }, { kind: "unreachable", server, message: "offline" }],
    [{ kind: "badMasterPassword" }, { kind: "locked", server, reason: "" }],
    [{ kind: "rateLimited" }, { kind: "locked", server, reason: "" }],
    [{ kind: "notFound" }, { kind: "locked", server, reason: "" }],
    [{ kind: "refused", reason: "not allowed" }, { kind: "locked", server, reason: "" }],
    [{ kind: "server", status: 500, message: "failed" }, { kind: "locked", server, reason: "" }],
  ])("maps $kind into the state the interface can present", (error, expected) => {
    expect(stateFromError(server, error)).toEqual(expected);
  });

  it("reports a locked status without a supplied reason", () => {
    expect(
      deriveState(server, true, {
        ok: true,
        value: { initialized: true, locked: true, deviceConnected: true, autoLockSeconds: 900 },
      }),
    ).toEqual({ kind: "locked", server, reason: "" });
  });
});
