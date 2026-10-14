import { errorText, stateText } from "../src/shared/errors";
import type { ApiError, VaultState } from "../src/shared/types";

// What the user reads for each failure and vault state.

describe("errorText", () => {
  it.each<[ApiError, string]>([
    [{ kind: "signedOut" }, "Your Quark session ended. Sign in again."],
    [{ kind: "badCredentials" }, "Invalid username or password."],
    [{ kind: "accountRefused", status: "pending" }, "This account is waiting for an admin to approve it."],
    [{ kind: "accountRefused", status: "disabled" }, "This account is disabled."],
    [{ kind: "notAdmin" }, "The vault needs an admin account."],
    [{ kind: "locked", reason: "" }, "The vault is locked."],
    [{ kind: "locked", reason: "idle" }, "The vault is locked: idle."],
    [{ kind: "badMasterPassword" }, "That password didn't unlock the vault."],
    [{ kind: "notInitialized" }, "The vault isn't set up yet. Create it in the Quark app first."],
    [{ kind: "driveDisconnected" }, "The drive holding the vault is disconnected."],
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
    [{ kind: "notAdmin", server }, "The vault needs an admin account."],
    [{ kind: "notInitialized", server }, "The vault isn't set up yet. Create it in the Quark app first."],
    [{ kind: "driveDisconnected", server }, "The drive holding the vault is disconnected."],
    [{ kind: "locked", server, reason: "" }, "The vault is locked."],
    [{ kind: "locked", server, reason: "drive removed" }, "The vault is locked: drive removed."],
    [{ kind: "unlocked", server, autoLockSeconds: 0 }, "Unlocked"],
    [{ kind: "unreachable", server, message: "ECONNREFUSED" }, "Couldn't reach your Quark. Check the address and that it's online."],
  ])("describes %o", (state, text) => {
    expect(stateText(state)).toBe(text);
  });
});
