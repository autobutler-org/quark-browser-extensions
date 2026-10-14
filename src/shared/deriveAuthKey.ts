import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64, type DeriveAuthKey } from "./authKey";

// Argon2 and HKDF live apart from authKey.ts so the popup, which only needs the upgrade ledger, doesn't load them.

const encoder = new TextEncoder();

// What Quark v0.47.0+ takes in a password's place (autobutler-org/quark#2430),
// derived exactly as the Quark app's ChatCrypto.deriveAuthKeys does:
//
//   master  = Argon2id13(password, salt, t=3, m=64 MiB, p=1), 32 bytes
//   authKey = HKDF-SHA256(ikm = master, salt = none, info = "auth"), 32 bytes
//
// sent as standard base64. The salt is the account's, from GET /auth/salt.
export const deriveAuthKey: DeriveAuthKey = async (password, salt) => {
  const master = await argon2idAsync(encoder.encode(password), salt, { t: 3, m: 64 * 1024, p: 1, dkLen: 32 });
  try {
    return toBase64(hkdf(sha256, master, undefined, encoder.encode("auth"), 32));
  } finally {
    master.fill(0);
  }
};
