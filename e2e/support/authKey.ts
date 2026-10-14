import { argon2id } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();

// The auth key Quark v0.47.0+ takes in a password's place (quark#2430),
// computed here independently of the extension's src/shared/authKey.ts:
// HKDF-SHA256(Argon2id(password, salt, t=3, m=64 MiB, p=1), info "auth").
export const authKey = (password: string, saltBase64: string): string =>
  Buffer.from(
    hkdf(
      sha256,
      argon2id(encoder.encode(password), Buffer.from(saltBase64, "base64"), { t: 3, m: 64 * 1024, p: 1, dkLen: 32 }),
      undefined,
      encoder.encode("auth"),
      32,
    ),
  ).toString("base64");
