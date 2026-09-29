export type EntrySummary = Readonly<{
  id: number;
  name: string;
  urlHost: string;
  folderId: number | null;
  createdAt: string;
  updatedAt: string;
}>;

export type EntryDetail = Readonly<{
  id: number;
  name: string;
  url: string;
  urlHost: string;
  username: string;
  password: string;
}>;

export type VaultStatus = Readonly<{
  initialized: boolean;
  locked: boolean;
  autoLockSeconds: number;
  deviceConnected: boolean;
  lockReason?: string;
}>;

export type Credentials = Readonly<{
  username: string;
  password: string;
}>;

export type Connection = Readonly<{
  server: string;
  token: string;
}>;

export type Settings = Readonly<{
  inlineButton: boolean;
  badge: boolean;
  autoSubmit: boolean;
  othersReviewed: boolean;
}>;

export const defaultSettings: Settings = {
  inlineButton: true,
  badge: true,
  autoSubmit: false,
  othersReviewed: false,
};

export type ApiError =
  | Readonly<{ kind: "signedOut" }>
  | Readonly<{ kind: "badCredentials" }>
  | Readonly<{ kind: "accountRefused"; status: string }>
  | Readonly<{ kind: "notAdmin" }>
  | Readonly<{ kind: "locked"; reason: string }>
  | Readonly<{ kind: "badMasterPassword" }>
  | Readonly<{ kind: "notInitialized" }>
  | Readonly<{ kind: "driveDisconnected" }>
  | Readonly<{ kind: "rateLimited" }>
  | Readonly<{ kind: "notFound" }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "network"; message: string }>
  | Readonly<{ kind: "server"; status: number; message: string }>;

export type Result<T, E = ApiError> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type VaultState =
  | Readonly<{ kind: "disconnected" }>
  | Readonly<{ kind: "signedOut"; server: string }>
  | Readonly<{ kind: "notAdmin"; server: string }>
  | Readonly<{ kind: "notInitialized"; server: string }>
  | Readonly<{ kind: "driveDisconnected"; server: string }>
  | Readonly<{ kind: "locked"; server: string; reason: string }>
  | Readonly<{ kind: "unlocked"; server: string; autoLockSeconds: number }>
  | Readonly<{ kind: "unreachable"; server: string; message: string }>;
