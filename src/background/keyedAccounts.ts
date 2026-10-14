import { createUpgradeLedger, type KeyedAccounts, type UpgradeLedger } from "../shared/authKey";
import { loadKeyedAccounts, saveKeyedAccounts } from "./sealKey";

// Older builds kept the list in storage.local, which content scripts can write. Deleting it there let a legacy
// answer get the password again (#143), so it now lives in the extension's IndexedDB beside the seal key.
const legacyKey = "keyedAccounts";

const idsIn = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

// The first time this build looks, there is no IndexedDB record: bring over an older build's list, then delete it so
// a later write there means nothing. A content script could have planted hashes in it; those only refuse upgrades,
// never allow one. With no list anywhere, as on a fresh install, nothing has upgraded yet.
const migrate = async (): Promise<readonly string[]> => {
  const ids = idsIn((await chrome.storage.local.get(legacyKey))[legacyKey]);
  await saveKeyedAccounts(ids);
  await chrome.storage.local.remove(legacyKey);
  return ids;
};

let migrating: Promise<readonly string[]> | null = null;

export const keyedAccounts: KeyedAccounts = {
  load: async () => {
    const stored = await loadKeyedAccounts();
    if (stored !== null) {
      return stored;
    }
    migrating ??= migrate().finally(() => {
      migrating = null;
    });
    return migrating;
  },
  save: saveKeyedAccounts,
};

export const upgradeLedger: UpgradeLedger = createUpgradeLedger(keyedAccounts, () => chrome.storage.session);
