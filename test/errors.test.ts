import { errorText, stateText } from "../src/shared/errors";
import type { ApiError, VaultState } from "../src/shared/types";

// What the user reads for each failure and vault state.

describe("errorText", () => {
  it.each<[ApiError, string]>([
    [{ kind: "signedOut" }, "Your Quark session ended. Sign in again."],
    [{ kind: "badCredentials" }, "Invalid username or password."],
    [{ kind: "accountRefused", status: "pending" }, "This account is waiting for an admin to approve it."],
    [{ kind: "accountRefused", status: "disabled" }, "This account is disabled."],
    [{ kind: "locked" }, "The vault is locked."],
    [{ kind: "wrongPassword" }, "That isn't this account's Quark password, so it didn't open the vault."],
    [{ kind: "notInitialized" }, "This account has no vault yet. Set it up on the Vault page of the Quark app, then try again."],
    [{ kind: "rateLimited" }, "Too many attempts. Wait a minute and try again."],
    [{ kind: "notFound" }, "That entry no longer exists."],
    [{ kind: "server", status: 500, message: "stack trace here" }, "Your Quark couldn't finish that. Try again."],
    [{ kind: "refused", reason: "This login doesn't belong to this site." }, "This login doesn't belong to this site."],
  ])("explains %o", (error, text) => {
    expect(errorText(error)).toBe(text);
  });

  it("keeps a network failure's raw message from the user", () => {
    expect(errorText({ kind: "network", message: "TypeError: Failed to fetch https://quark.local" })).toBe(
      "Couldn't reach your Quark. Check the address and that it's online.",
    );
  });
});

describe("stateText", () => {
  const server = "https://quark.local";

  it.each<[VaultState, string]>([
    [{ kind: "disconnected" }, "Not connected"],
    [{ kind: "signedOut", server }, "Signed out"],
    [{ kind: "notInitialized", server }, "This account has no vault yet. Set it up on the Vault page of the Quark app, then try again."],
    [{ kind: "locked", server }, "The vault is locked."],
    [{ kind: "unlocked", server, autoLockSeconds: 0 }, "Unlocked"],
    [{ kind: "unreachable", server, message: "ECONNREFUSED" }, "Couldn't reach your Quark. Check the address and that it's online."],
  ])("describes %o", (state, text) => {
    expect(stateText(state)).toBe(text);
  });
});
