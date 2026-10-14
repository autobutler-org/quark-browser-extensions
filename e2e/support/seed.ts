import { authKey } from "./authKey.ts";
import { client } from "./client.ts";

// What every test can rely on, on the real Quark and the mock alike.
export type Seeded = Readonly<{
  owner: Readonly<{ username: string; password: string }>;
  // An admin account from before auth keys: GET /auth/salt calls it legacy
  // until its first sign-in sends the password beside the key.
  legacy: Readonly<{ username: string; password: string }>;
  masterPassword: string;
  folderId: number;
  // "Local Test" matches the test site, with a TOTP secret, notes and a custom
  // field the update test checks survive; "GitHub" is another site's login.
  local: number;
  github: number;
}>;

export const owner = { username: "admin", password: "correct horse battery" };
export const legacy = { username: "oldadmin", password: "legacy-pw" };
export const masterPassword = "master-pass-123";
// The RFC 6238 test vectors' shared secret, "12345678901234567890", in the
// base32 a TOTP secret is stored as.
const base32 = (bytes: Uint8Array): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  return (bits.match(/.{1,5}/g) ?? []).map((chunk) => alphabet[parseInt(chunk.padEnd(5, "0"), 2)]).join("");
};
export const totpSecret = base32(new TextEncoder().encode("12345678901234567890"));

// Seeds a fresh Quark through its public API, as the Quark app would: first-boot
// setup with an auth key, then the vault, a folder and two entries. addLegacy
// puts the legacy account in, which the API can't do, since every way to make
// an account through it takes an auth key.
export const seed = async (server: string, site: string, addLegacy: () => Promise<void>): Promise<Seeded> => {
  const api = client(server);
  const { salt } = await api.salt(owner.username);
  const setup = await api.expectOk(
    api.call("POST", "/auth/setup", { username: owner.username, authKey: authKey(owner.password, salt) }),
    "POST /auth/setup",
  );
  const token = setup.token as string;
  await api.expectOk(api.call("POST", "/vault/setup", { masterPassword }, token), "POST /vault/setup");
  const folder = await api.expectOk(api.call("POST", "/vault/folders", { name: "Work" }, token), "POST /vault/folders");
  const local = await api.expectOk(
    api.call(
      "POST",
      "/vault/entries",
      {
        name: "Local Test",
        url: site,
        username: "alice",
        password: "s3cret",
        totpSecret,
        notes: "keep me",
        customFields: [{ name: "pin", value: "1234", hidden: true }],
        folderId: folder.id,
      },
      token,
    ),
    "POST /vault/entries",
  );
  const github = await api.expectOk(
    api.call("POST", "/vault/entries", { name: "GitHub", url: "https://github.com", username: "gh", password: "ghpw" }, token),
    "POST /vault/entries",
  );
  await api.expectOk(api.call("POST", "/vault/lock", undefined, token), "POST /vault/lock");
  await api.expectOk(api.call("POST", "/auth/logout", undefined, token), "POST /auth/logout");
  await addLegacy();
  const legacySalt = await api.salt(legacy.username);
  if (!legacySalt.legacy) throw new Error(`${legacy.username} should read as legacy: ${JSON.stringify(legacySalt)}`);
  return { owner, legacy, masterPassword, folderId: folder.id, local: local.id, github: github.id };
};
