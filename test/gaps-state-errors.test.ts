import { stateFromError } from "../src/background/state";
import type { ApiError, VaultState } from "../src/shared/types";

const server = "https://quark.local";

describe("vault states reported for API failures", () => {
  it.each<[ApiError, VaultState]>([
    [{ kind: "signedOut" }, { kind: "signedOut", server }],
    [{ kind: "badCredentials" }, { kind: "signedOut", server }],
    [{ kind: "accountRefused", status: "disabled" }, { kind: "signedOut", server }],
    [{ kind: "notInitialized" }, { kind: "notInitialized", server }],
    [{ kind: "locked" }, { kind: "locked", server }],
    [{ kind: "network", message: "offline" }, { kind: "unreachable", server, message: "offline" }],
    [{ kind: "wrongPassword" }, { kind: "locked", server }],
    [{ kind: "rateLimited" }, { kind: "locked", server }],
    [{ kind: "notFound" }, { kind: "locked", server }],
    [{ kind: "refused", reason: "not allowed" }, { kind: "locked", server }],
    [{ kind: "server", status: 500, message: "failed" }, { kind: "locked", server }],
  ])("maps $kind into the state the interface can present", (error, expected) => {
    expect(stateFromError(server, error)).toEqual(expected);
  });
});
