import type { ApiError, VaultState } from "./types";

export const errorText = (error: ApiError): string => {
  switch (error.kind) {
    case "signedOut":
      return "Your Quark session ended. Sign in again.";
    case "badCredentials":
      return "Invalid username or password.";
    case "accountRefused":
      return error.status === "pending"
        ? "This account is waiting for an admin to approve it."
        : "This account is disabled.";
    case "notAdmin":
      return "The vault needs an admin account.";
    case "locked":
      return error.reason === "" ? "The vault is locked." : `The vault is locked: ${error.reason}.`;
    case "badMasterPassword":
      return "That password didn't unlock the vault.";
    case "notInitialized":
      return "The vault isn't set up yet. Create it in the Quark app first.";
    case "driveDisconnected":
      return "The drive holding the vault is disconnected.";
    case "rateLimited":
      return "Too many attempts. Wait a minute and try again.";
    case "notFound":
      return "That entry no longer exists.";
    case "network":
      return "Couldn't reach your Quark. Check the address and that it's online.";
    case "server":
      return "Your Quark couldn't finish that. Try again.";
    case "refused":
      return error.reason;
  }
};

export const stateText = (state: VaultState): string => {
  switch (state.kind) {
    case "disconnected":
      return "Not connected";
    case "signedOut":
      return "Signed out";
    case "notAdmin":
      return errorText({ kind: "notAdmin" });
    case "notInitialized":
      return errorText({ kind: "notInitialized" });
    case "driveDisconnected":
      return errorText({ kind: "driveDisconnected" });
    case "locked":
      return errorText({ kind: "locked", reason: state.reason });
    case "unlocked":
      return "Unlocked";
    case "unreachable":
      return errorText({ kind: "network", message: state.message });
  }
};
