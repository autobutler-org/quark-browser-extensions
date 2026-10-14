import { accountId, consentTtlMs, createUpgradeLedger, fromBase64 } from "../src/shared/authKey";
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
  const ledger = (now: () => number = () => 0) => {
    const { storage } = fakeChrome().chrome;
    return { storage, ledger: createUpgradeLedger(() => storage.local, () => storage.session, now) };
  };

  it("keeps a hash of the server and account, never the names", async () => {
    const { storage, ledger: record } = ledger();
    await record.markKeyed("https://quark.local", "brandon");
    await record.markKeyed("https://quark.local", "Brandon");
    expect(storage.local.items.get("keyedAccounts")).toEqual([accountId("https://quark.local", "brandon")]);
    expect(JSON.stringify([...storage.local.items])).not.toContain("brandon");
    expect(await record.hasKey("https://quark.local", "BRANDON")).toBe(true);
    expect(await record.hasKey("https://quark.lan", "brandon")).toBe(false);
  });

  it("hands out a consent once, for its own server and account only", async () => {
    const { ledger: record } = ledger();
    await record.giveConsent("https://quark.local", "brandon");
    expect(await record.takeConsent("https://quark.local", "sam")).toBe(false);
    await record.giveConsent("https://quark.local", "brandon");
    expect(await record.takeConsent("https://quark.local", "brandon")).toBe(true);
    expect(await record.takeConsent("https://quark.local", "brandon")).toBe(false);
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
