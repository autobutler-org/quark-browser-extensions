import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { fromBase64, toBase64 } from "./authKey";

// The per-account vault's client-side crypto, byte for byte as the Quark app's AccountCrypto
// (autobutler-org/quark#3457, #3461). The Quark stores only what comes out of here: the vault key wrapped, and
// each item as ciphertext. It never sees the vault key, the wrap key or an item's plaintext.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const nonceBytes = 24;

// The plaintext layout this extension reads and writes (the app's VaultItemData.formatVersion), sent beside the
// ciphertext and bound into it as additional data.
export const itemFormatVersion = 1;

// One item as the Quark stores it (/api/v0/vault/items): base64 ciphertext and nonce, and the layout's version.
export type SealedItem = Readonly<{ ciphertext: string; nonce: string; formatVersion: number }>;

// A decrypted item: the JSON object the app encrypts. Entries and folders are both items, told apart by `kind`;
// fields this extension doesn't know (notes, custom fields, a folder) ride along untouched when it rewrites one.
export type VaultItem = Readonly<Record<string, unknown>>;

// ad = utf8("quark-vault-item-v1") || 0x00 || formatVersion as one byte, so neither a key wrap nor an item
// relabelled with another version opens as an item.
const itemAd = (formatVersion: number): Uint8Array => Uint8Array.from([...encoder.encode("quark-vault-item-v1"), 0, formatVersion]);

const randomNonce = (): Uint8Array => crypto.getRandomValues(new Uint8Array(nonceBytes));

// Opens `nonce || XChaCha20-Poly1305(vaultKey)`, the password wrap of GET /vault/key, with the vaultWrapKey the
// login password derives. Null for anything that doesn't open: a wrong password, or a wrap that isn't one.
export const unwrapVaultKey = (wrapped: Uint8Array, wrapKey: Uint8Array): Uint8Array | null => {
  if (wrapped.length <= nonceBytes) {
    return null;
  }
  try {
    return xchacha20poly1305(wrapKey, wrapped.subarray(0, nonceBytes)).decrypt(wrapped.subarray(nonceBytes));
  } catch {
    return null;
  }
};

// Encrypts an item under the vault key with a fresh random nonce. `nonce` is for the fixed test vectors only.
export const sealItem = (item: VaultItem, vaultKey: Uint8Array, nonce: Uint8Array = randomNonce()): SealedItem => ({
  ciphertext: toBase64(xchacha20poly1305(vaultKey, nonce, itemAd(itemFormatVersion)).encrypt(encoder.encode(JSON.stringify(item)))),
  nonce: toBase64(nonce),
  formatVersion: itemFormatVersion,
});

// Decrypts what sealItem (or the app) produced. Null for an item that doesn't open, isn't a JSON object, or is in
// a layout newer than this extension's, which the app also leaves out rather than guess at.
export const openItem = (sealed: SealedItem, vaultKey: Uint8Array): VaultItem | null => {
  const [ciphertext, nonce] = [fromBase64(sealed.ciphertext), fromBase64(sealed.nonce)];
  if (sealed.formatVersion !== itemFormatVersion || ciphertext === null || nonce?.length !== nonceBytes) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(decoder.decode(xchacha20poly1305(vaultKey, nonce, itemAd(sealed.formatVersion)).decrypt(ciphertext)));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as VaultItem) : null;
  } catch {
    return null;
  }
};

export const itemString = (item: VaultItem, key: string): string => {
  const value = item[key];
  return typeof value === "string" ? value : "";
};

// An item with no kind is an entry, as in the app; "folder" and anything newer are not logins.
export const isEntry = (item: VaultItem): boolean => (item.kind ?? "entry") === "entry";

// The lowercased host of an item's URL, reading a URL typed with no scheme as https, or empty when it has none:
// the app's VaultItemData.hostOf.
export const urlHostOf = (url: string): string => {
  const trimmed = url.trim();
  if (trimmed === "") {
    return "";
  }
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return "";
  }
};
