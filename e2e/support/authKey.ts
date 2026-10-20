import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();

// The keys a password stands for (quark#2430, #3457), computed here independently of the extension's
// src/shared/deriveAuthKey.ts: one Argon2id(password, salt, t=3, m=64 MiB, p=1), split by HKDF-SHA256 into the auth
// key Quark v0.47.0+ takes in the password's place (info "auth") and the key that wraps the vault key (info
// "vault-wrap").
export const accountKeys = (password: string, saltBase64: string): { authKey: string; vaultWrapKey: Uint8Array } => {
  const master = argon2id(encoder.encode(password), Buffer.from(saltBase64, "base64"), { t: 3, m: 64 * 1024, p: 1, dkLen: 32 });
  return {
    authKey: Buffer.from(hkdf(sha256, master, undefined, encoder.encode("auth"), 32)).toString("base64"),
    vaultWrapKey: hkdf(sha256, master, undefined, encoder.encode("vault-wrap"), 32),
  };
};

export const authKey = (password: string, saltBase64: string): string => accountKeys(password, saltBase64).authKey;
