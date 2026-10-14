import { deriveAuthKey, fromBase64, upgradeLedger, type DeriveAuthKey, type UpgradeLedger } from "./authKey";
import { extensionTooOld, legacyAgain, legacyInsecure, legacyUpgradeNeeded, quarkTooOld } from "./errors";
import { serverTransport } from "./host";
import {
  err,
  ok,
  type ApiError,
  type Connection,
  type EntryDetail,
  type EntrySummary,
  type Result,
  type VaultStatus,
} from "./types";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

type Method = "GET" | "POST" | "PUT";

export type NewEntry = Readonly<{
  name: string;
  url: string;
  username: string;
  password: string;
}>;

export const replacementBody = (current: unknown, password: string): Record<string, unknown> => {
  const folderId = field(current, "folderId");
  const customFields = field(current, "customFields");
  return {
    name: stringField(current, "name"),
    url: stringField(current, "url"),
    username: stringField(current, "username"),
    password,
    notes: stringField(current, "notes"),
    totpSecret: stringField(current, "totpSecret"),
    customFields: Array.isArray(customFields) ? customFields : [],
    folderId: typeof folderId === "number" ? folderId : null,
  };
};

type Request = Readonly<{
  method: Method;
  path: string;
  body?: unknown;
}>;

type Failure = Readonly<{ status: number; message: string; state: string }>;

const authRequired = "authentication required";

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
    case 403:
      return { kind: "notAdmin" };
    case 404:
      return { kind: "notFound" };
    case 423:
      return { kind: "locked", reason: message.replace(/^vault is locked:?\s*/i, "") };
    case 426:
      return { kind: "refused", reason: extensionTooOld() };
    case 429:
      return { kind: "rateLimited" };
    case 503:
      return { kind: "driveDisconnected" };
    default:
      return { kind: "server", status, message };
  }
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
      const response = await fetchFn(`${server}/api/v0${request.path}`, {
        method: request.method,
        headers,
        credentials: "omit",
        cache: "no-store",
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
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

const asEntrySummary = (value: unknown): EntrySummary => ({
  id: Number(field(value, "id")),
  name: stringField(value, "name"),
  urlHost: stringField(value, "urlHost"),
  folderId: typeof field(value, "folderId") === "number" ? (field(value, "folderId") as number) : null,
  createdAt: stringField(value, "createdAt"),
  updatedAt: stringField(value, "updatedAt"),
});

const asEntryDetail = (value: unknown): EntryDetail => ({
  id: Number(field(value, "id")),
  name: stringField(value, "name"),
  url: stringField(value, "url"),
  urlHost: stringField(value, "urlHost"),
  username: stringField(value, "username"),
  password: stringField(value, "password"),
  totpSecret: stringField(value, "totpSecret"),
});

const asStatus = (value: unknown): VaultStatus => ({
  initialized: field(value, "initialized") === true,
  locked: field(value, "locked") !== false,
  autoLockSeconds: Number(field(value, "autoLockSeconds") ?? 0),
  deviceConnected: field(value, "deviceConnected") !== false,
  lockReason: stringField(value, "lockReason"),
});

type AuthSalt = Readonly<{ salt: Uint8Array; legacy: boolean }>;

// GET /auth/salt answers 401 or 404 on a Quark from before auth keys, or 200
// with its web app's index.html before setup, so anything without a salt in it
// means the Quark is too old to take an auth key.
const asAuthSalt = (payload: unknown): AuthSalt | null => {
  const salt = field(payload, "salt");
  const bytes = typeof salt === "string" ? fromBase64(salt) : null;
  return bytes === null ? null : { salt: bytes, legacy: field(payload, "legacy") === true };
};

export const createApi = (fetchFn: FetchFn, deriveKey: DeriveAuthKey = deriveAuthKey, ledger: UpgradeLedger = upgradeLedger) => {
  const request = send(fetchFn);
  const authed = (connection: Connection, req: Request) => request(connection.server, connection.token, req);

  return {
    // Quark v0.47.0+ takes an auth key derived from the password, never the
    // password alone (autobutler-org/quark#2430). An account the Quark marks
    // legacy has no auth key yet, so it is sent the password beside the key
    // once, which moves it to the key. Only the server says an account is
    // legacy, so that password goes out only over https or loopback, only on
    // the user's consent from the connect form, and never for an account this
    // extension has seen sign in with a key (docs/legacy-upgrade.md).
    login: async (server: string, username: string, password: string): Promise<Result<string>> => {
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
      if (salt.legacy) {
        if (serverTransport(server) === "insecure") {
          return err({ kind: "refused", reason: legacyInsecure(server) });
        }
        if (await ledger.hasKey(server, username)) {
          return err({ kind: "refused", reason: legacyAgain(server) });
        }
        if (!(await ledger.takeConsent(server, username))) {
          return err({ kind: "refused", reason: legacyUpgradeNeeded(server), legacyUpgrade: { server, username } });
        }
      }
      const authKey = await deriveKey(password, salt.salt);
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
        return ok(token);
      }
      if (isFailure(result.error) && result.error.status === 401) {
        return err({ kind: "badCredentials" });
      }
      if (isFailure(result.error) && result.error.status === 403) {
        return err({ kind: "accountRefused", status: result.error.state });
      }
      return err(normalizeError(result.error));
    },

    logout: async (connection: Connection): Promise<Result<null>> =>
      mapResult(await authed(connection, { method: "POST", path: "/auth/logout" }), () => null),

    status: async (connection: Connection): Promise<Result<VaultStatus>> =>
      mapResult(await authed(connection, { method: "GET", path: "/vault/status" }), asStatus),

    unlock: async (connection: Connection, masterPassword: string): Promise<Result<null>> => {
      const result = await authed(connection, {
        method: "POST",
        path: "/vault/unlock",
        body: { masterPassword },
      });
      if (!result.ok && isFailure(result.error)) {
        const { status, message } = result.error;
        if (status === 401 && message !== authRequired) {
          return err({ kind: "badMasterPassword" });
        }
        if (status === 400 && /not (been )?initiali[sz]ed/i.test(message)) {
          return err({ kind: "notInitialized" });
        }
      }
      return mapResult(result, () => null);
    },

    lock: async (connection: Connection): Promise<Result<null>> =>
      mapResult(await authed(connection, { method: "POST", path: "/vault/lock" }), () => null),

    listEntries: async (connection: Connection): Promise<Result<readonly EntrySummary[]>> =>
      mapResult(await authed(connection, { method: "GET", path: "/vault/entries" }), (payload) => {
        const entries = field(payload, "entries");
        return Array.isArray(entries) ? entries.map(asEntrySummary) : [];
      }),

    getEntry: async (connection: Connection, id: number): Promise<Result<EntryDetail>> =>
      mapResult(
        await authed(connection, { method: "GET", path: `/vault/entries/${encodeURIComponent(String(id))}` }),
        asEntryDetail,
      ),

    createEntry: async (connection: Connection, entry: NewEntry): Promise<Result<number>> =>
      mapResult(
        await authed(connection, { method: "POST", path: "/vault/entries", body: entry }),
        (payload) => Number(field(payload, "id")),
      ),

    replacePassword: async (connection: Connection, id: number, password: string): Promise<Result<null>> => {
      const path = `/vault/entries/${encodeURIComponent(String(id))}`;
      const current = await authed(connection, { method: "GET", path });
      if (!current.ok) {
        return err(normalizeError(current.error));
      }
      return mapResult(
        await authed(connection, { method: "PUT", path, body: replacementBody(current.value, password) }),
        () => null,
      );
    },

    generate: async (connection: Connection, length = 20): Promise<Result<string>> =>
      mapResult(
        await authed(connection, {
          method: "POST",
          path: "/vault/generate",
          body: { length, uppercase: true, lowercase: true, digits: true, symbols: true, avoidAmbiguous: true },
        }),
        (payload) => stringField(payload, "password"),
      ),
  };
};

export type Api = ReturnType<typeof createApi>;
