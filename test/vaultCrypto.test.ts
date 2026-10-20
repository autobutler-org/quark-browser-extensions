import { fromBase64, toBase64 } from "../src/shared/authKey";
import { deriveKeys } from "../src/shared/deriveAuthKey";
import { openItem, sealItem, unwrapVaultKey, urlHostOf, type SealedItem } from "../src/shared/vaultCrypto";

// Fixed vectors for the per-account vault (autobutler-org/quark#3457, #3461). The derived keys are the Quark app's
// own pinned vectors (quark test/services/account_crypto_test.dart). The wrap and the item were sealed outside
// this codebase, with the libsodium the Quark app links (crypto_aead_xchacha20poly1305_ietf_encrypt, as
// AccountCrypto.wrapVaultKey and encryptVaultItem call it) over these fixed keys and nonces. A mismatch here means
// the extension can't read the vaults the app writes.

const bytes = (start: number, length: number): Uint8Array => Uint8Array.from({ length }, (_, i) => start + i);
const b64 = (text: string): Uint8Array => fromBase64(text) ?? new Uint8Array();

const salt = bytes(0, 16);
const vaultKey = bytes(32, 32);
const wrapped = b64("ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7M45niWoOxKIqWBomnR5XGosNWUs6nlDxxGALxh6o2U//gocn6gTU3XzufauINP3w");

// The app's VaultItemData.toJson for an entry, as jsonEncode writes it.
const item = {
  kind: "entry",
  name: "GitHub",
  url: "https://github.com/login",
  username: "octocat",
  password: "hunter2",
  totpSecret: "JBSWY3DPEHPK3PXP",
  customFields: [{ label: "pin", value: "1234", hidden: true }],
  folderId: 7,
};
const sealed: SealedItem = {
  nonce: "yMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f",
  ciphertext:
    "nRaocNRVSI97ErtFpUexy2+9h8kAqG70gerDdF5P675IgeOVPdkDuqzFkVmzbpFM+Jfna+dFb34+av88LMwq3ipSUGgEPW1DZlNDSrWtUBcSf5nbRpfgSq0IklWPVq5zk044OjmSJH5CzvkxVoP15Vct/TqTfh3bUj8nmM/nTbLNztgj9IsKPbhA8EuF5W18linIKjueXmvvV+yKb/KxDwgAwoBXJ+yT7rk/VeWj8V8VIlyRieyY82Bf/1r/wvconShHc+DoPSnFs/8m0W4EcRRwO9mlue1TEtqWcQy+3ZFp+SNx/Kw=",
  formatVersion: 1,
};

describe("deriveKeys", () => {
  it("gives the app's authKey and vaultWrapKey, and the wrap key opens the app's wrap", async () => {
    const keys = await deriveKeys("correct horse battery staple", salt);
    expect(keys.authKey).toBe("zNR6rA8kTcAq8wwj0fjQh9lSZ0A3+VNjah0pZEMf7XU=");
    expect(toBase64(keys.vaultWrapKey)).toBe("v/TmPg0XmN2JiMZAMQUHkHZQ7jNwNtgxdiFD9MZRlEE=");
    expect(unwrapVaultKey(wrapped, keys.vaultWrapKey)).toEqual(vaultKey);
  }, 60_000);

  it("takes the cost from the stored kdfParams", async () => {
    const cheap = await deriveKeys("one-password", salt, { opsLimit: 1, memLimit: 8192 });
    const again = await deriveKeys("one-password", salt, { opsLimit: 1, memLimit: 8192 });
    const dearer = await deriveKeys("one-password", salt, { opsLimit: 2, memLimit: 8192 });
    expect(again).toEqual(cheap);
    expect(dearer.vaultWrapKey).not.toEqual(cheap.vaultWrapKey);
    expect(cheap.vaultWrapKey).not.toEqual(b64(cheap.authKey));
  });
});

describe("unwrapVaultKey", () => {
  it("refuses a wrong password's key, a tampered wrap and a wrap too short to hold a nonce", async () => {
    const wrong = await deriveKeys("Correct horse battery staple", salt, { opsLimit: 1, memLimit: 8192 });
    const tampered = Uint8Array.from(wrapped, (byte, i) => (i === 30 ? byte ^ 1 : byte));
    expect(unwrapVaultKey(wrapped, wrong.vaultWrapKey)).toBeNull();
    expect(unwrapVaultKey(tampered, vaultKey)).toBeNull();
    expect(unwrapVaultKey(bytes(0, 24), vaultKey)).toBeNull();
  });
});

describe("a vault item", () => {
  it("opens the item the app sealed", () => {
    expect(openItem(sealed, vaultKey)).toEqual(item);
  });

  it("seals to the app's exact bytes under the same nonce, so the app opens what the extension writes", () => {
    expect(sealItem(item, vaultKey, b64(sealed.nonce))).toEqual(sealed);
  });

  it("round-trips with a fresh nonce each time", () => {
    const [a, b] = [sealItem(item, vaultKey), sealItem(item, vaultKey)];
    expect(a.nonce).not.toBe(b.nonce);
    expect(b64(a.nonce)).toHaveLength(24);
    expect(openItem(a, vaultKey)).toEqual(item);
  });

  it("doesn't open under another key, another format version, a tampered byte, a bad nonce or as a key wrap", () => {
    const tampered = b64(sealed.ciphertext).map((byte, i) => (i === 0 ? byte ^ 1 : byte));
    const attempts: SealedItem[] = [
      { ...sealed, formatVersion: 2 },
      { ...sealed, ciphertext: toBase64(tampered) },
      { ...sealed, nonce: toBase64(bytes(0, 3)) },
      { ...sealed, nonce: "not base64!" },
    ];
    for (const attempt of attempts) {
      expect(openItem(attempt, vaultKey)).toBeNull();
    }
    expect(openItem(sealed, bytes(0, 32))).toBeNull();
    // The additional data keeps an item from opening as a wrap.
    expect(unwrapVaultKey(Uint8Array.from([...b64(sealed.nonce), ...b64(sealed.ciphertext)]), vaultKey)).toBeNull();
  });

  it("is refused when the plaintext isn't a JSON object", () => {
    const nonce = bytes(1, 24);
    const array = sealItem([] as unknown as Record<string, unknown>, vaultKey, nonce);
    expect(openItem(array, vaultKey)).toBeNull();
  });
});

describe("urlHostOf", () => {
  it("reads the host as the app does", () => {
    expect(urlHostOf(" https://GitHub.com/login ")).toBe("github.com");
    expect(urlHostOf("example.com/login")).toBe("example.com");
    expect(urlHostOf("")).toBe("");
    expect(urlHostOf("http://exa mple.com")).toBe("");
  });
});
