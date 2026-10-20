// What the worker keeps of a decrypted entry for listing and matching: no password and no one-time code secret.
export type EntrySummary = Readonly<{
  id: number;
  name: string;
  url: string;
  urlHost: string;
  folderId: number | null;
  updatedAt: string;
  // Whether the entry has a one-time code.
  hasTotp?: boolean;
}>;

export type EntryDetail = Readonly<{
  id: number;
  name: string;
  url: string;
  urlHost: string;
  username: string;
  password: string;
  totpSecret: string;
}>;

export type Credentials = Readonly<{
  username: string;
  password: string;
}>;

export type Connection = Readonly<{
  server: string;
  token: string;
}>;

export const idleMinuteChoices = [5, 15, 30] as const;

export type IdleMinutes = (typeof idleMinuteChoices)[number];

export type Settings = Readonly<{
  inlineButton: boolean;
  badge: boolean;
  autoSubmit: boolean;
  othersReviewed: boolean;
  lockOnIdle: boolean;
  idleMinutes: IdleMinutes;
  welcomeSeen: boolean;
}>;

export type BooleanSetting = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

export const defaultSettings: Settings = {
  inlineButton: true,
  badge: true,
  autoSubmit: false,
  othersReviewed: false,
  lockOnIdle: false,
  idleMinutes: 15,
  welcomeSeen: false,
};

export type LegacyUpgrade = Readonly<{ server: string; username: string }>;

export type ApiError =
  | Readonly<{ kind: "signedOut" }>
  | Readonly<{ kind: "badCredentials" }>
  | Readonly<{ kind: "accountRefused"; status: string }>
  | Readonly<{ kind: "locked" }>
  // The password typed to unlock didn't open the vault key's wrap.
  | Readonly<{ kind: "wrongPassword" }>
  // The account has no vault yet; it is set up in the Quark app.
  | Readonly<{ kind: "notInitialized" }>
  | Readonly<{ kind: "rateLimited" }>
  | Readonly<{ kind: "notFound" }>
  // legacyUpgrade: the Quark calls the account legacy and wants its password once, which the connect form asks
  // the user about before anything is sent.
  | Readonly<{ kind: "refused"; reason: string; legacyUpgrade?: LegacyUpgrade }>
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
  | Readonly<{ kind: "notInitialized"; server: string }>
  | Readonly<{ kind: "locked"; server: string }>
  | Readonly<{ kind: "unlocked"; server: string; autoLockSeconds: number }>
  | Readonly<{ kind: "unreachable"; server: string; message: string }>;
