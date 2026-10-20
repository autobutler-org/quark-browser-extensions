import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "node:crypto";
import type { Client } from "./client.ts";

// The per-account vault the way the Quark app writes it (quark#3459, AccountCrypto), written here independently of
// the extension's src/shared/vaultCrypto.ts, so the e2e tests seed and read what the app would.

const ad = Buffer.concat([Buffer.from("quark-vault-item-v1"), Buffer.from([0, 1])]);

export type Item = Record<string, unknown>;

export const sealItem = (vaultKey: Uint8Array, item: Item) => {
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(vaultKey, nonce, ad).encrypt(Buffer.from(JSON.stringify(item)));
  return { ciphertext: Buffer.from(ciphertext).toString("base64"), nonce: nonce.toString("base64"), formatVersion: 1 };
};

export const openItem = (vaultKey: Uint8Array, stored: { ciphertext: string; nonce: string }): Item =>
  JSON.parse(
    Buffer.from(xchacha20poly1305(vaultKey, Buffer.from(stored.nonce, "base64"), ad).decrypt(Buffer.from(stored.ciphertext, "base64"))).toString(),
  ) as Item;

// A new random vault key, wrapped as `nonce || XChaCha20-Poly1305(key)` under the password's vault wrap key, in the
// body PUT /vault/key takes: the auth key re-confirms the password, and the salt is the account's auth salt.
export const newVault = (authKey: string, vaultWrapKey: Uint8Array, saltBase64: string) => {
  const vaultKey = randomBytes(32);
  const nonce = randomBytes(24);
  const wrapped = Buffer.concat([nonce, xchacha20poly1305(vaultWrapKey, nonce).encrypt(vaultKey)]);
  return {
    vaultKey: new Uint8Array(vaultKey),
    body: {
      password: authKey,
      wrappedByPassword: wrapped.toString("base64"),
      saltPw: saltBase64,
      kdfParams: { alg: "argon2id13+hkdf-sha256", opsLimit: 3, memLimit: 64 << 20 },
    },
  };
};

// The account's items, decrypted, by id: what the extension has stored, as the app would read it.
export const vaultItems = (api: Client, token: string, vaultKey: Uint8Array) => {
  const key = Buffer.from(vaultKey);
  return {
    add: async (item: Item): Promise<number> =>
      (await api.expectOk<{ id: number }>(api.call("POST", "/vault/items", sealItem(key, item), token), "POST /vault/items")).id,
    get: async (id: number): Promise<Item> =>
      openItem(key, await api.expectOk<{ ciphertext: string; nonce: string }>(api.call("GET", `/vault/items/${id}`, undefined, token), "GET item")),
    list: async (): Promise<Map<number, Item>> => {
      const stored = await api.expectOk<{ id: number; ciphertext: string; nonce: string }[]>(api.call("GET", "/vault/items", undefined, token), "GET items");
      return new Map(stored.map((item) => [item.id, openItem(key, item)]));
    },
    put: async (id: number, item: Item): Promise<void> =>
      void (await api.expectOk(api.call("PUT", `/vault/items/${id}`, sealItem(key, item), token), "PUT item")),
    remove: async (id: number): Promise<void> => void (await api.call("DELETE", `/vault/items/${id}`, undefined, token)),
  };
};
