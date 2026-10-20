import type { Api, SignedIn, StoredItem } from "../shared/api";
import { fromBase64, toBase64, type DeriveKeys } from "../shared/authKey";
import { deriveKeys, standardCost } from "../shared/deriveAuthKey";
import { parseOtpSecret } from "../shared/totp";
import { err, ok, type Connection, type Credentials, type EntryDetail, type EntrySummary, type Result } from "../shared/types";
import { isEntry, itemString, openItem, sealItem, unwrapVaultKey, urlHostOf, type VaultItem } from "../shared/vaultCrypto";
import { clearOpenVault, loadOpenVault, saveOpenVault } from "./storage";

// The account's vault, opened in the worker (autobutler-org/quark#3459). The Quark stores the vault key wrapped
// under the login password's vaultWrapKey and every item as ciphertext; the worker unwraps the key with the
// password the user types, keeps it in storage.session, and decrypts and encrypts items itself. Nothing but
// ciphertext goes back to the Quark.

// Like the Quark app's VaultConfig.autoLockAfter: a vault left unused this long locks and forgets its key.
export const autoLockMs = 15 * 60_000;

export type NewEntry = Credentials & Readonly<{ name: string; url: string }>;

const folderIdOf = (item: VaultItem): number | null => (typeof item.folderId === "number" ? item.folderId : null);

const summaryOf = (id: number, updatedAt: string, item: VaultItem): EntrySummary => {
  const url = itemString(item, "url");
  return {
    id,
    name: itemString(item, "name"),
    url,
    urlHost: urlHostOf(url),
    folderId: folderIdOf(item),
    updatedAt,
    hasTotp: parseOtpSecret(itemString(item, "totpSecret")) !== null,
  };
};

const detailOf = (id: number, item: VaultItem): EntryDetail => {
  const url = itemString(item, "url");
  return {
    id,
    name: itemString(item, "name"),
    url,
    urlHost: urlHostOf(url),
    username: itemString(item, "username"),
    password: itemString(item, "password"),
    totpSecret: itemString(item, "totpSecret"),
  };
};

// As the app's VaultItemData.toJson writes a new entry: kind and name always, other fields only when set.
const newItem = (entry: NewEntry): VaultItem =>
  Object.fromEntries(Object.entries({ kind: "entry", ...entry }).filter(([key, value]) => key === "name" || value !== ""));

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

export const createVault = (api: Api, derive: DeriveKeys = deriveKeys, now: () => number = Date.now) => {
  // The open key for this server, or null when locked. Only a user's action (`touch`) restarts the auto-lock; a
  // page asking what matches it does not.
  const openKey = async (server: string, touch: boolean): Promise<Uint8Array | null> => {
    const open = await loadOpenVault();
    if (open === null || open.server !== server) {
      return null;
    }
    if (now() - open.usedAt >= autoLockMs) {
      await clearOpenVault();
      return null;
    }
    if (touch) {
      await saveOpenVault({ ...open, usedAt: now() });
    }
    return fromBase64(open.key);
  };

  const withKey = async <T>(connection: Connection, touch: boolean, run: (key: Uint8Array) => Promise<Result<T>>): Promise<Result<T>> => {
    const key = await openKey(connection.server, touch);
    return key === null ? err({ kind: "locked" }) : run(key);
  };

  const openEntry = (stored: StoredItem, key: Uint8Array): VaultItem | null => {
    const item = openItem(stored, key);
    return item !== null && isEntry(item) ? item : null;
  };

  const getEntry = (connection: Connection, id: number, key: Uint8Array): Promise<Result<VaultItem>> =>
    api.getItem(connection, id).then((stored) => {
      if (!stored.ok) {
        return stored;
      }
      const item = openEntry(stored.value, key);
      return item === null ? err({ kind: "notFound" }) : ok(item);
    });

  return {
    isOpen: async (server: string, touch = false): Promise<boolean> => (await openKey(server, touch)) !== null,

    // Opens the vault with the login password. A sign-in that just derived the vault wrap key over the same salt
    // and cost hands it over in `signedIn`, so connecting costs one Argon2id run, not two.
    unlock: async (connection: Connection, password: string, signedIn?: SignedIn): Promise<Result<null>> => {
      const wrapped = await api.vaultKey(connection);
      if (!wrapped.ok) {
        return wrapped;
      }
      const { salt, cost } = wrapped.value;
      const reuse =
        signedIn !== undefined &&
        sameBytes(signedIn.salt, salt) &&
        cost.opsLimit === standardCost.opsLimit &&
        cost.memLimit === standardCost.memLimit;
      const wrapKey = reuse ? signedIn.vaultWrapKey : (await derive(password, salt, cost)).vaultWrapKey;
      const key = unwrapVaultKey(wrapped.value.wrapped, wrapKey);
      wrapKey.fill(0);
      if (key === null) {
        return err({ kind: "wrongPassword" });
      }
      await saveOpenVault({ server: connection.server, key: toBase64(key), usedAt: now() });
      key.fill(0);
      return ok(null);
    },

    lock: (): Promise<void> => clearOpenVault(),

    // Every entry, decrypted, without its secrets. An item that doesn't open, a folder, or one in a newer layout
    // is left out, as the app leaves it out.
    entries: (connection: Connection, touch: boolean): Promise<Result<readonly EntrySummary[]>> =>
      withKey(connection, touch, async (key) => {
        const listed = await api.listItems(connection);
        if (!listed.ok) {
          return listed;
        }
        return ok(
          listed.value.flatMap((stored) => {
            const item = openEntry(stored, key);
            return item === null ? [] : [summaryOf(stored.id, stored.updatedAt, item)];
          }),
        );
      }),

    // One entry with its secrets, fetched and decrypted when it is used and never kept.
    entry: (connection: Connection, id: number): Promise<Result<EntryDetail>> =>
      withKey(connection, true, async (key) => {
        const item = await getEntry(connection, id, key);
        return item.ok ? ok(detailOf(id, item.value)) : item;
      }),

    create: (connection: Connection, entry: NewEntry): Promise<Result<number>> =>
      withKey(connection, true, (key) => api.createItem(connection, sealItem(newItem(entry), key))),

    // Rewrites the whole item with only the password changed, so its notes, custom fields and folder stay.
    replacePassword: (connection: Connection, id: number, password: string): Promise<Result<null>> =>
      withKey(connection, true, async (key) => {
        const item = await getEntry(connection, id, key);
        return item.ok ? api.updateItem(connection, id, sealItem({ ...item.value, password }, key)) : item;
      }),
  };
};

export type Vault = ReturnType<typeof createVault>;
