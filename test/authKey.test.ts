import { accountId, consentTtlMs, createUpgradeLedger, fromBase64, type KeyedAccounts } from "../src/shared/authKey";
import { deriveAuthKey } from "../src/shared/deriveAuthKey";
import { fakeChrome } from "./fakeChrome";

describe("deriveAuthKey", () => {
  // The Quark app's own vector (quark test/services/chat_crypto_test.dart) at
  // the shipped cost: accounts depend on this never changing.
  it("matches the Quark app's pinned vector", async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(await deriveAuthKey("correct horse battery staple", salt)).toBe(
      "zNR6rA8kTcAq8wwj0fjQh9lSZ0A3+VNjah0pZEMf7XU=",
    );
  }, 60_000);
});

describe("fromBase64", () => {
  it("decodes standard base64 and rejects anything else", () => {
    expect(fromBase64("AAEC")).toEqual(Uint8Array.from([0, 1, 2]));
    expect(fromBase64("<!doctype html>")).toBeNull();
  });
});

describe("the upgrade ledger", () => {
  const ledger = (now: () => number = () => 0, load?: () => Promise<readonly string[]>) => {
    const { storage } = fakeChrome().chrome;
    const keyed: { ids: readonly string[] } & KeyedAccounts = {
      ids: [],
      load: load ?? (() => Promise.resolve(keyed.ids)),
      save: (ids) => Promise.resolve(void (keyed.ids = ids)),
    };
    return { storage, keyed, ledger: createUpgradeLedger(keyed, () => storage.session, now) };
  };

  it("keeps a hash of the server and account, never the names", async () => {
    const { keyed, ledger: record } = ledger();
    await record.markKeyed("https://quark.local", "brandon");
    await record.markKeyed("https://quark.local", "Brandon");
    expect(keyed.ids).toEqual([accountId("https://quark.local", "brandon")]);
    expect(await record.hasKey("https://quark.local", "BRANDON")).toBe(true);
    expect(await record.hasKey("https://quark.lan", "brandon")).toBe(false);
  });

  it("loses no account when two are marked at once", async () => {
    const { keyed, ledger: record } = ledger();
    await Promise.all([record.markKeyed("https://quark.local", "brandon"), record.markKeyed("https://quark.local", "sam")]);
    expect(keyed.ids).toHaveLength(2);
  });

  it("says an account has a key when the record can't be read, so the password stays home", async () => {
    const { ledger: record } = ledger(undefined, () => Promise.reject(new Error("IndexedDB is gone")));
    expect(await record.hasKey("https://quark.local", "brandon")).toBe(true);
  });

  it("hands out a consent once, for its own server and account only", async () => {
    const { ledger: record } = ledger();
    await record.giveConsent("https://quark.local", "brandon");
    expect(await record.takeConsent("https://quark.local", "sam")).toBe(false);
    await record.giveConsent("https://quark.local", "brandon");
    expect(await record.takeConsent("https://quark.local", "brandon")).toBe(true);
    expect(await record.takeConsent("https://quark.local", "brandon")).toBe(false);
  });

  it("hands out a consent once to callers that ask at the same time (#140)", async () => {
    const { ledger: record } = ledger();
    await record.giveConsent("https://quark.local", "brandon");
    const taken = await Promise.all([1, 2, 3].map(() => record.takeConsent("https://quark.local", "brandon")));
    expect(taken.filter(Boolean)).toHaveLength(1);
  });

  it("lets a consent lapse", async () => {
    let now = 1_000;
    const { ledger: record } = ledger(() => now);
    await record.giveConsent("https://quark.local", "brandon");
    now += consentTtlMs + 1;
    expect(await record.takeConsent("https://quark.local", "brandon")).toBe(false);
  });

  it("keeps the consent in session storage, which content scripts can't write", async () => {
    const { storage, ledger: record } = ledger();
    await record.giveConsent("https://quark.local", "brandon");
    expect(storage.session.items.has("legacyUpgradeConsent")).toBe(true);
    expect(storage.local.items.has("legacyUpgradeConsent")).toBe(false);
  });
});
