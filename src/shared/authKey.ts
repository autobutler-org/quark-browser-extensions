import { sha256 } from "@noble/hashes/sha2.js";

export type DeriveAuthKey = (password: string, salt: Uint8Array) => Promise<string>;

const encoder = new TextEncoder();

export const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

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
  hasKey: (server: string, username: string) => Promise<boolean>;
  markKeyed: (server: string, username: string) => Promise<void>;
  // Uses up the consent: true once, and only within consentTtlMs of giveConsent.
  takeConsent: (server: string, username: string) => Promise<boolean>;
  giveConsent: (server: string, username: string) => Promise<void>;
}>;

type Area = Readonly<{
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}>;

export const consentTtlMs = 5 * 60_000;

const keyedKey = "keyedAccounts";
const consentKey = "legacyUpgradeConsent";

// Usernames are matched without regard to case or surrounding space, so a second request can't slip past the record
// by spelling the account differently.
export const accountId = (server: string, username: string): string =>
  Array.from(sha256(encoder.encode(`${server}\n${username.trim().toLowerCase()}`)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const createUpgradeLedger = (local: () => Area, session: () => Area, now: () => number = Date.now): UpgradeLedger => {
  const keyed = async (): Promise<readonly string[]> => {
    const stored = (await local().get(keyedKey))[keyedKey];
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  };
  return {
    hasKey: async (server, username) => (await keyed()).includes(accountId(server, username)),
    markKeyed: async (server, username) => {
      const ids = await keyed();
      const id = accountId(server, username);
      if (!ids.includes(id)) {
        await local().set({ [keyedKey]: [...ids, id] });
      }
    },
    takeConsent: async (server, username) => {
      const stored = (await session().get(consentKey))[consentKey] as { id?: unknown; at?: unknown } | undefined;
      await session().remove(consentKey);
      const age = typeof stored?.at === "number" ? now() - stored.at : Infinity;
      return stored?.id === accountId(server, username) && age >= 0 && age <= consentTtlMs;
    },
    giveConsent: (server, username) => session().set({ [consentKey]: { id: accountId(server, username), at: now() } }),
  };
};

// chrome.storage.session is open only to extension pages and the worker (src/background/storage.ts), so a page's
// content script can't forge the consent.
export const upgradeLedger: UpgradeLedger = createUpgradeLedger(
  () => chrome.storage.local,
  () => chrome.storage.session,
);
