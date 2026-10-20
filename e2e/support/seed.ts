import { accountKeys } from "./authKey.ts";
import { client } from "./client.ts";
import { newVault, vaultItems } from "./vault.ts";

// What every test can rely on, on the real Quark and the mock alike.
export type Seeded = Readonly<{
  owner: Readonly<{ username: string; password: string }>;
  // An admin account from before auth keys: GET /auth/salt calls it legacy
  // until its first sign-in sends the password beside the key.
  legacy: Readonly<{ username: string; password: string }>;
  // The owner's vault key, base64, so a test can read and write items as the app would.
  vaultKey: string;
  folderId: number;
  // "Local Test" matches the test site, with a TOTP secret, notes and a custom
  // field the update test checks survive; "GitHub" is another site's login.
  local: number;
  github: number;
}>;

export const owner = { username: "admin", password: "correct horse battery" };
export const legacy = { username: "oldadmin", password: "legacy-pw" };
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
// setup with an auth key, then the owner's vault, wrapped under the vault key
// the same password derives, with a folder and two entries sealed on the
// client. addLegacy puts the legacy account in, which the API can't do, since
// every way to make an account through it takes an auth key.
export const seed = async (server: string, site: string, addLegacy: () => Promise<void>): Promise<Seeded> => {
  const api = client(server);
  const { salt } = await api.salt(owner.username);
  const keys = accountKeys(owner.password, salt);
  const setup = await api.expectOk<{ token: string }>(
    api.call("POST", "/auth/setup", { username: owner.username, authKey: keys.authKey }),
    "POST /auth/setup",
  );
  const token = setup.token;
  const vault = newVault(keys.authKey, keys.vaultWrapKey, salt);
  await api.expectOk(api.call("PUT", "/vault/key", vault.body, token), "PUT /vault/key");
  const items = vaultItems(api, token, vault.vaultKey);
  const folderId = await items.add({ kind: "folder", name: "Work" });
  const local = await items.add({
    kind: "entry",
    name: "Local Test",
    url: site,
    username: "alice",
    password: "s3cret",
    notes: "keep me",
    totpSecret,
    customFields: [{ label: "pin", value: "1234", hidden: true }],
    folderId,
  });
  const github = await items.add({ kind: "entry", name: "GitHub", url: "https://github.com", username: "gh", password: "ghpw" });
  await api.expectOk(api.call("POST", "/auth/logout", undefined, token), "POST /auth/logout");
  await addLegacy();
  const legacySalt = await api.salt(legacy.username);
  if (!legacySalt.legacy) throw new Error(`${legacy.username} should read as legacy: ${JSON.stringify(legacySalt)}`);
  return { owner, legacy, vaultKey: Buffer.from(vault.vaultKey).toString("base64"), folderId, local, github };
};
