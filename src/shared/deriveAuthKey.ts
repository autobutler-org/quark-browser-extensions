import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64, type DeriveKeys, type KdfCost } from "./authKey";

// Argon2 and HKDF live apart from authKey.ts so the popup, which only needs the upgrade ledger, doesn't load them.

const encoder = new TextEncoder();

// What every auth key is derived at: 3 passes over 64 MiB (the Quark app's KdfParams.standard).
export const standardCost: KdfCost = { opsLimit: 3, memLimit: 64 << 20 };

// The keys a login password stands for, derived exactly as the Quark app's
// AccountCrypto.deriveAuthKeys does (autobutler-org/quark#2430, #3457):
//
//   master       = Argon2id13(password, salt, opsLimit, memLimit), 32 bytes
//   authKey      = HKDF-SHA256(ikm = master, salt = none, info = "auth"), 32 bytes
//   vaultWrapKey = HKDF-SHA256(ikm = master, salt = none, info = "vault-wrap"), 32 bytes
//
// authKey is what Quark v0.47.0+ takes in the password's place, sent as standard base64. vaultWrapKey opens the
// account's wrapped vault key and never leaves the extension. The salt is the account's, from GET /auth/salt.
export const deriveKeys: DeriveKeys = async (password, salt, cost = standardCost) => {
  const master = await argon2idAsync(encoder.encode(password), salt, {
    t: cost.opsLimit,
    // libsodium counts memory in bytes, Argon2 itself in KiB.
    m: cost.memLimit / 1024,
    p: 1,
    dkLen: 32,
  });
  try {
    return {
      authKey: toBase64(hkdf(sha256, master, undefined, encoder.encode("auth"), 32)),
      vaultWrapKey: hkdf(sha256, master, undefined, encoder.encode("vault-wrap"), 32),
    };
  } finally {
    master.fill(0);
  }
};
