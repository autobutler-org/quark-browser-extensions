import { t } from "./i18n";
import type { ApiError, VaultState } from "./types";

export const extensionTooOld = (): string => t("errorExtensionTooOld");

export const quarkTooOld = (): string => t("errorQuarkTooOld");

export const errorText = (error: ApiError): string => {
  switch (error.kind) {
    case "signedOut":
      return t("errorSignedOut");
    case "badCredentials":
      return t("errorBadCredentials");
    case "accountRefused":
      return error.status === "pending" ? t("errorAccountPending") : t("errorAccountDisabled");
    case "notAdmin":
      return t("errorNotAdmin");
    case "locked":
      return error.reason === "" ? t("errorLocked") : t("errorLockedReason", error.reason);
    case "badMasterPassword":
      return t("errorBadMasterPassword");
    case "notInitialized":
      return t("errorNotInitialized");
    case "driveDisconnected":
      return t("errorDriveDisconnected");
    case "rateLimited":
      return t("errorRateLimited");
    case "notFound":
      return t("errorNotFound");
    case "network":
      return t("errorNetwork");
    case "server":
      return t("errorServer");
    case "refused":
      return error.reason;
  }
};

export const stateText = (state: VaultState): string => {
  switch (state.kind) {
    case "disconnected":
      return t("stateDisconnected");
    case "signedOut":
      return t("stateSignedOut");
    case "notAdmin":
      return errorText({ kind: "notAdmin" });
    case "notInitialized":
      return errorText({ kind: "notInitialized" });
    case "driveDisconnected":
      return errorText({ kind: "driveDisconnected" });
    case "locked":
      return errorText({ kind: "locked", reason: state.reason });
    case "unlocked":
      return t("stateUnlocked");
    case "unreachable":
      return errorText({ kind: "network", message: state.message });
  }
};
