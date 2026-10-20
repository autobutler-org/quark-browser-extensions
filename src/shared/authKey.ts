import { sha256 } from "@noble/hashes/sha2.js";

// The Argon2id cost a key was derived at, as the Quark stores it in kdfParams: passes, and memory in bytes.
export type KdfCost = Readonly<{ opsLimit: number; memLimit: number }>;

export type DerivedKeys = Readonly<{ authKey: string; vaultWrapKey: Uint8Array }>;

export type DeriveKeys = (password: string, salt: Uint8Array, cost?: KdfCost) => Promise<DerivedKeys>;

const encoder = new TextEncoder();

// One character at a time: spreading a large ciphertext into String.fromCharCode overflows the stack.
export const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

export const fromBase64 = (text: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

// A legacy account (GET /auth/salt answers legacy: true) has no auth key yet, and its one sign-in that moves it to
// one carries the password. Nothing but the server's word says an account is legacy, so the extension keeps its own
// record (docs/legacy-upgrade.md): accounts it has seen sign in with a key are never sent the password again, and
// the one upgrade goes out only on a consent the connect form records for that server and account just before it
// asks the worker to connect. Both are keyed by a hash of the server and username, not the names themselves.
export type UpgradeLedger = Readonly<{
  // True when the record can't be read, so a broken record never lets the password out.
  hasKey: (server: string, username: string) => Promise<boolean>;
  markKeyed: (server: string, username: string) => Promise<void>;
  // Uses up the consent: true once, and only within consentTtlMs of giveConsent.
  takeConsent: (server: string, username: string) => Promise<boolean>;
  giveConsent: (server: string, username: string) => Promise<void>;
}>;

// Where the upgraded accounts' hashes are kept. The worker's is in the extension's IndexedDB, which content scripts
// can't open (src/background/keyedAccounts.ts).
export type KeyedAccounts = Readonly<{
  load: () => Promise<readonly string[]>;
  save: (ids: readonly string[]) => Promise<void>;
}>;

type Area = Readonly<{
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}>;

export const consentTtlMs = 5 * 60_000;

const consentKey = "legacyUpgradeConsent";

// Usernames are matched without regard to case or surrounding space, so a second request can't slip past the record
// by spelling the account differently.
export const accountId = (server: string, username: string): string =>
  Array.from(sha256(encoder.encode(`${server}\n${username.trim().toLowerCase()}`)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

// chrome.storage.session is open only to extension pages and the worker (src/background/storage.ts), so a page's
// content script can't forge the consent. The connect form records it here before it asks the worker to connect.
export const giveConsent = (
  server: string,
  username: string,
  session: Area = chrome.storage.session,
  now: () => number = Date.now,
): Promise<void> => session.set({ [consentKey]: { id: accountId(server, username), at: now() } });

export const createUpgradeLedger = (keyed: KeyedAccounts, session: () => Area, now: () => number = Date.now): UpgradeLedger => {
  // chrome.storage and IndexedDB reads and writes here are separate steps with no transaction around them. One at a
  // time, so two callers can't both read a consent before either removes it, or lose each other's markKeyed (#140).
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    hasKey: (server, username) =>
      serial(async () => (await keyed.load().catch(() => null))?.includes(accountId(server, username)) ?? true),
    markKeyed: (server, username) =>
      serial(async () => {
        const ids = await keyed.load();
        const id = accountId(server, username);
        if (!ids.includes(id)) {
          await keyed.save([...ids, id]);
        }
      }),
    takeConsent: (server, username) =>
      serial(async () => {
        const stored = (await session().get(consentKey))[consentKey] as { id?: unknown; at?: unknown } | undefined;
        await session().remove(consentKey);
        const age = typeof stored?.at === "number" ? now() - stored.at : Infinity;
        return stored?.id === accountId(server, username) && age >= 0 && age <= consentTtlMs;
      }),
    giveConsent: (server, username) => giveConsent(server, username, session(), now),
  };
};
