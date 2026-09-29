import type { ApiError, Result, VaultState, VaultStatus } from "../shared/types";

export const deriveState = (
  server: string,
  hasToken: boolean,
  status: Result<VaultStatus> | null,
): VaultState => {
  if (server === "") {
    return { kind: "disconnected" };
  }
  if (!hasToken || status === null) {
    return { kind: "signedOut", server };
  }
  if (!status.ok) {
    return stateFromError(server, status.error);
  }
  const { initialized, locked, deviceConnected, autoLockSeconds, lockReason } = status.value;
  if (!deviceConnected) {
    return { kind: "driveDisconnected", server };
  }
  if (!initialized) {
    return { kind: "notInitialized", server };
  }
  return locked
    ? { kind: "locked", server, reason: lockReason ?? "" }
    : { kind: "unlocked", server, autoLockSeconds };
};

export const stateFromError = (server: string, error: ApiError): VaultState => {
  switch (error.kind) {
    case "signedOut":
    case "badCredentials":
    case "accountRefused":
      return { kind: "signedOut", server };
    case "notAdmin":
      return { kind: "notAdmin", server };
    case "notInitialized":
      return { kind: "notInitialized", server };
    case "driveDisconnected":
      return { kind: "driveDisconnected", server };
    case "locked":
      return { kind: "locked", server, reason: error.reason };
    case "network":
      return { kind: "unreachable", server, message: error.message };
    case "badMasterPassword":
    case "rateLimited":
    case "notFound":
    case "refused":
    case "server":
      return { kind: "locked", server, reason: "" };
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
