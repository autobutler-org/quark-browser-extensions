import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { toBase64 } from "../src/shared/authKey";
import { deriveKeys } from "../src/shared/deriveAuthKey";
import { openItem, sealItem, type SealedItem, type VaultItem } from "../src/shared/vaultCrypto";

// The per-account vault as a test Quark serves it (autobutler-org/quark#3459): the vault key wrapped under the login
// password, and every item as ciphertext the test seals with the real crypto. The Argon2id cost is the floor, so
// unlocking takes milliseconds; the shipped cost is pinned in vaultCrypto.test.ts.

export const loginPassword = "correct horse";
export const vaultKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const cheapCost = { opsLimit: 1, memLimit: 8192 };
const salt = Uint8Array.from({ length: 16 }, (_, i) => 100 + i);

const wrapKey = (await deriveKeys(loginPassword, salt, cheapCost)).vaultWrapKey;
const nonce = Uint8Array.from({ length: 24 }, (_, i) => i);
export const wrappedVaultKey = {
  wrappedByPassword: toBase64(Uint8Array.from([...nonce, ...xchacha20poly1305(wrapKey, nonce).encrypt(vaultKey)])),
  saltPw: toBase64(salt),
  wrappedByPhrase: toBase64(new Uint8Array(72)),
  saltRp: toBase64(salt),
  kdfParams: { alg: "argon2id13+hkdf-sha256+recovery", ...cheapCost },
};

// An entry as the extension used to get it from the Quark: the fields the app encrypts, plus its id.
export type EntryFixture = Readonly<{ id: number } & Record<string, unknown>>;

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const sealedFor = (id: number, item: VaultItem, updatedAt = "2024-01-01"): SealedItem & { id: number; createdAt: string; updatedAt: string } => ({
  id,
  ...sealItem(item, vaultKey),
  createdAt: "2024-01-01",
  updatedAt,
});

// What the extension sent in a create or update body, decrypted with the test's vault key.
export const opened = (body: unknown): VaultItem | null => openItem(body as SealedItem, vaultKey);

export const vaultRoutes = (fixtures: readonly EntryFixture[]) => {
  const state = {
    hasVault: true,
    items: new Map<number, { item: VaultItem; updatedAt: string }>(
      fixtures.map(({ id, ...item }) => [id, { item: { kind: "entry", ...item }, updatedAt: "2024-01-01" }]),
    ),
    nextId: 100,
  };
  // The answer to a vault route, or null for any other path.
  const handle = (method: string, path: string, body: unknown): Response | null => {
    if (!path.startsWith("/vault/")) {
      return null;
    }
    if (method === "GET" && path === "/vault/key") {
      return state.hasVault ? json(200, wrappedVaultKey) : json(404, { error: "no vault" });
    }
    if (method === "GET" && path === "/vault/items") {
      return json(200, [...state.items].map(([id, { item, updatedAt }]) => sealedFor(id, item, updatedAt)));
    }
    if (method === "POST" && path === "/vault/items") {
      if (!state.hasVault) {
        return json(409, { error: "no vault" });
      }
      const id = state.nextId++;
      state.items.set(id, { item: opened(body) ?? {}, updatedAt: "2024-02-01" });
      return json(201, { id, ...(body as object) });
    }
    const one = /^\/vault\/items\/(\d+)$/.exec(path);
    const found = one === null ? undefined : state.items.get(Number(one[1]));
    if (one === null || found === undefined) {
      return json(404, { error: "not found" });
    }
    if (method === "GET") {
      return json(200, sealedFor(Number(one[1]), found.item, found.updatedAt));
    }
    if (method === "PUT") {
      state.items.set(Number(one[1]), { item: opened(body) ?? {}, updatedAt: "2024-02-01" });
      return json(200, body);
    }
    return json(404, { error: "no route" });
  };
  return { state, handle };
};

type Area = Readonly<{ set: (items: Record<string, unknown>) => Promise<void> }>;

// What an earlier unlock leaves in storage.session.
export const openVault = (session: Area, server: string, usedAt = Date.now()): Promise<void> =>
  session.set({ vault: { server, key: toBase64(vaultKey), usedAt } });

// A fetch that answers the vault routes for `fixtures` and anything else with an empty 200.
export const vaultFetch = (fixtures: readonly EntryFixture[]) => {
  const routes = vaultRoutes(fixtures);
  return (input: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(input).pathname.replace(/^\/api\/v0/, "");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return Promise.resolve(routes.handle(init?.method ?? "GET", path, body) ?? json(200, {}));
  };
};
