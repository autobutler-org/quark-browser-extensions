import type { ApiError, Result, VaultState } from "../shared/types";
import { autoLockMs } from "./vault";

// `vault`: whether this browser holds the vault key, or why the Quark couldn't say there is one to unlock.
export const deriveState = (server: string, hasToken: boolean, vault: Result<boolean> | null): VaultState => {
  if (server === "") {
    return { kind: "disconnected" };
  }
  if (!hasToken || vault === null) {
    return { kind: "signedOut", server };
  }
  if (!vault.ok) {
    return stateFromError(server, vault.error);
  }
  return vault.value ? { kind: "unlocked", server, autoLockSeconds: autoLockMs / 1000 } : { kind: "locked", server };
};

export const stateFromError = (server: string, error: ApiError): VaultState => {
  switch (error.kind) {
    case "signedOut":
    case "badCredentials":
    case "accountRefused":
      return { kind: "signedOut", server };
    case "notInitialized":
      return { kind: "notInitialized", server };
    case "network":
      return { kind: "unreachable", server, message: error.message };
    case "locked":
    case "wrongPassword":
    case "rateLimited":
    case "notFound":
    case "refused":
    case "server":
      return { kind: "locked", server };
  }
};

export type Cache<T> = Readonly<{
  get: () => T | undefined;
  set: (value: T) => void;
  clear: () => void;
}>;

export const createCache = <T>(ttlMs: number, now: () => number = Date.now): Cache<T> => {
  let slot: Readonly<{ value: T; at: number }> | undefined;
  return {
    get: () => (slot !== undefined && now() - slot.at < ttlMs ? slot.value : undefined),
    set: (value) => {
      slot = { value, at: now() };
    },
    clear: () => {
      slot = undefined;
    },
  };
};
