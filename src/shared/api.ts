import { fromBase64, type DeriveKeys, type KdfCost, type UpgradeLedger } from "./authKey";
import { deriveKeys } from "./deriveAuthKey";
import { extensionTooOld, legacyAgain, legacyInsecure, legacyUpgradeNeeded, quarkTooOld } from "./errors";
import { serverTransport } from "./host";
import { err, ok, type ApiError, type Connection, type Result } from "./types";
import type { SealedItem } from "./vaultCrypto";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

type Method = "GET" | "POST" | "PUT";

type Request = Readonly<{
  method: Method;
  path: string;
  body?: unknown;
}>;

type Failure = Readonly<{ status: number; message: string; state: string }>;

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const stringField = (value: unknown, key: string): string => {
  const found = field(value, key);
  return typeof found === "string" ? found : "";
};

export const toApiError = ({ status, message }: Failure): ApiError => {
  switch (status) {
    case 401:
      return { kind: "signedOut" };
    case 404:
      return { kind: "notFound" };
    case 426:
      return { kind: "refused", reason: extensionTooOld() };
    case 429:
      return { kind: "rateLimited" };
    default:
      return { kind: "server", status, message };
  }
};

// The answer has to come from the origin that was asked. A redirect is never followed, even to the same origin:
// fetch would resend the method and body (a 307 or 308 keeps both) to wherever Location points, so a password
// could reach another server before any check here ran (#144). The origin check catches a fetch that followed
// one anyway. A Response built in memory has no url, so it has no origin to compare.
const answeredFrom = (requested: string, response: Response): string | null => {
  if (response.url === "") {
    return response.redirected ? "" : null;
  }
  const origin = new URL(response.url).origin;
  return !response.redirected && origin === new URL(requested).origin ? null : origin;
};

const send =
  (fetchFn: FetchFn) =>
  async (server: string, token: string | null, request: Request): Promise<Result<unknown, Failure | ApiError>> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token !== null) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    try {
      const url = `${server}/api/v0${request.path}`;
      const response = await fetchFn(url, {
        method: request.method,
        headers,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const elsewhere = answeredFrom(url, response);
      if (elsewhere !== null) {
        return err({ kind: "network", message: `the answer came from ${elsewhere || "a redirect"}, not ${new URL(url).origin}` });
      }
      const payload = await readJson(response);
      return response.ok
        ? ok(payload)
        : err({ status: response.status, message: stringField(payload, "error"), state: stringField(payload, "status") });
    } catch (cause) {
      return err({ kind: "network", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

const isFailure = (error: Failure | ApiError): error is Failure => "status" in error && !("kind" in error);

const normalizeError = (error: Failure | ApiError): ApiError => (isFailure(error) ? toApiError(error) : error);

const mapResult = <T>(result: Result<unknown, Failure | ApiError>, decode: (payload: unknown) => T): Result<T> =>
  result.ok ? ok(decode(result.value)) : err(normalizeError(result.error));

// GET /vault/key: the account's vault key, wrapped under its login password's vaultWrapKey. The phrase wrap beside
// it is for the app's account recovery and isn't read here.
export type WrappedKey = Readonly<{ wrapped: Uint8Array; salt: Uint8Array; cost: KdfCost }>;

export type StoredItem = SealedItem & Readonly<{ id: number; updatedAt: string }>;

const asWrappedKey = (value: unknown): WrappedKey | null => {
  const wrapped = fromBase64(stringField(value, "wrappedByPassword"));
  const salt = fromBase64(stringField(value, "saltPw"));
  const params = field(value, "kdfParams");
  const [opsLimit, memLimit] = [field(params, "opsLimit"), field(params, "memLimit")];
  return wrapped === null || salt === null || typeof opsLimit !== "number" || typeof memLimit !== "number"
    ? null
    : { wrapped, salt, cost: { opsLimit, memLimit } };
};

const asStoredItem = (value: unknown): StoredItem => ({
  id: Number(field(value, "id")),
  ciphertext: stringField(value, "ciphertext"),
  nonce: stringField(value, "nonce"),
  formatVersion: Number(field(value, "formatVersion")),
  updatedAt: stringField(value, "updatedAt"),
});

const itemPath = (id: number): string => `/vault/items/${encodeURIComponent(String(id))}`;

// What a sign-in leaves the worker: the session token, and the vault wrap key the same Argon2id run derived, which
// opens the vault right away when it was wrapped over the same salt and cost (src/background/vault.ts).
export type SignedIn = Readonly<{ token: string; salt: Uint8Array; vaultWrapKey: Uint8Array }>;

type AuthSalt = Readonly<{ salt: Uint8Array; legacy: boolean }>;

// GET /auth/salt answers 401 or 404 on a Quark from before auth keys, or 200
// with its web app's index.html before setup, so anything without a salt in it
// means the Quark is too old to take an auth key.
const asAuthSalt = (payload: unknown): AuthSalt | null => {
  const salt = field(payload, "salt");
  const bytes = typeof salt === "string" ? fromBase64(salt) : null;
  return bytes === null ? null : { salt: bytes, legacy: field(payload, "legacy") === true };
};

// The worker passes the ledger in src/background/keyedAccounts.ts.
export const createApi = (fetchFn: FetchFn, ledger: UpgradeLedger, derive: DeriveKeys = deriveKeys) => {
  const request = send(fetchFn);
  const authed = (connection: Connection, req: Request) => request(connection.server, connection.token, req);

  // One legacy sign-in at a time, from the record check to recording the key. Otherwise a second sign-in, with a
  // consent of its own from a second submit, passes the check before the first records the account, and the
  // password goes out twice (#140).
  let upgrading: Promise<unknown> = Promise.resolve();
  const oneUpgrade = <T>(run: () => Promise<T>): Promise<T> => {
    const next = upgrading.then(run);
    upgrading = next.catch(() => undefined);
    return next;
  };

  const signIn = async (server: string, username: string, password: string, salt: AuthSalt): Promise<Result<SignedIn>> => {
    const { authKey, vaultWrapKey } = await derive(password, salt.salt);
    const result = await request(server, null, {
      method: "POST",
      path: "/auth/login",
      body: salt.legacy ? { username, password, authKey } : { username, authKey },
    });
    if (result.ok) {
      const token = stringField(result.value, "token");
      if (token === "") {
        return err({ kind: "server", status: 200, message: "no token in response" });
      }
      await ledger.markKeyed(server, username);
      return ok({ token, salt: salt.salt, vaultWrapKey });
    }
    if (isFailure(result.error) && result.error.status === 401) {
      return err({ kind: "badCredentials" });
    }
    if (isFailure(result.error) && result.error.status === 403) {
      return err({ kind: "accountRefused", status: result.error.state });
    }
    return err(normalizeError(result.error));
  };

  const upgrade = async (server: string, username: string, password: string, salt: AuthSalt): Promise<Result<SignedIn>> => {
    if (await ledger.hasKey(server, username)) {
      return err({ kind: "refused", reason: legacyAgain(server) });
    }
    if (!(await ledger.takeConsent(server, username))) {
      return err({ kind: "refused", reason: legacyUpgradeNeeded(server), legacyUpgrade: { server, username } });
    }
    return signIn(server, username, password, salt);
  };

  return {
    // Quark v0.47.0+ takes an auth key derived from the password, never the
    // password alone (autobutler-org/quark#2430). An account the Quark marks
    // legacy has no auth key yet, so it is sent the password beside the key
    // once, which moves it to the key. Only the server says an account is
    // legacy, so that password goes out only over https or loopback, only on
    // the user's consent from the connect form, and never for an account this
    // extension has seen sign in with a key (docs/legacy-upgrade.md).
    login: async (server: string, username: string, password: string): Promise<Result<SignedIn>> => {
      const saltReply = await request(server, null, {
        method: "GET",
        path: `/auth/salt?${new URLSearchParams({ username })}`,
      });
      if (!saltReply.ok && !(isFailure(saltReply.error) && [401, 404].includes(saltReply.error.status))) {
        return err(normalizeError(saltReply.error));
      }
      const salt = saltReply.ok ? asAuthSalt(saltReply.value) : null;
      if (salt === null) {
        return err({ kind: "refused", reason: quarkTooOld() });
      }
      if (!salt.legacy) {
        return signIn(server, username, password, salt);
      }
      if (serverTransport(server) === "insecure") {
        return err({ kind: "refused", reason: legacyInsecure(server) });
      }
      return oneUpgrade(() => upgrade(server, username, password, salt));
    },

    logout: async (connection: Connection): Promise<Result<null>> =>
      mapResult(await authed(connection, { method: "POST", path: "/auth/logout" }), () => null),

    // The per-account vault (autobutler-org/quark#3459). The Quark holds only the wrapped key and ciphertext; every
    // route answers for the signed-in account alone, and another account's item is a 404 like a missing one.
    vaultKey: async (connection: Connection): Promise<Result<WrappedKey>> => {
      const result = await authed(connection, { method: "GET", path: "/vault/key" });
      if (!result.ok) {
        return isFailure(result.error) && result.error.status === 404 ? err({ kind: "notInitialized" }) : err(normalizeError(result.error));
      }
      const key = asWrappedKey(result.value);
      return key === null ? err({ kind: "server", status: 200, message: "unreadable vault key" }) : ok(key);
    },

    listItems: async (connection: Connection): Promise<Result<readonly StoredItem[]>> =>
      mapResult(await authed(connection, { method: "GET", path: "/vault/items" }), (payload) =>
        Array.isArray(payload) ? payload.map(asStoredItem) : [],
      ),

    getItem: async (connection: Connection, id: number): Promise<Result<StoredItem>> =>
      mapResult(await authed(connection, { method: "GET", path: itemPath(id) }), asStoredItem),

    createItem: async (connection: Connection, item: SealedItem): Promise<Result<number>> => {
      const result = await authed(connection, { method: "POST", path: "/vault/items", body: item });
      // 409: the account has no vault to add to, as when it was deleted from the app since this one was unlocked.
      return !result.ok && isFailure(result.error) && result.error.status === 409
        ? err({ kind: "notInitialized" })
        : mapResult(result, (payload) => Number(field(payload, "id")));
    },

    updateItem: async (connection: Connection, id: number, item: SealedItem): Promise<Result<null>> =>
      mapResult(await authed(connection, { method: "PUT", path: itemPath(id), body: item }), () => null),
  };
};

export type Api = ReturnType<typeof createApi>;
