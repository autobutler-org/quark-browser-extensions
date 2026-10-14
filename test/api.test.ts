import { createApi, toApiError, type FetchFn } from "../src/shared/api";
import { errorText, extensionTooOld, quarkTooOld } from "../src/shared/errors";

type Call = Readonly<{ url: string; init: RequestInit | undefined }>;

const respond = (status: number, body: unknown) => {
  const calls: Call[] = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body === undefined ? "" : JSON.stringify(body), { status }));
  };
  return { calls, api: createApi(fetchFn) };
};

const connection = { server: "https://quark.local", token: "t0k3n" };

const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
const saltBase64 = btoa(String.fromCharCode(...salt));

// Stands in for the Argon2id derivation, which takes seconds; deriveAuthKey
// itself is pinned by the vector in authKey.test.ts.
const fakeDerive = (password: string, from: Uint8Array) => Promise.resolve(`key(${password},${from.join(".")})`);

// A Quark v0.47.0+ sign-in: GET /auth/salt, then POST /auth/login, which
// refuses a password sent without an auth key with 426 (quark#2430).
const quark = (
  login: (body: Record<string, unknown>) => readonly [number, unknown],
  saltReply: readonly [number, unknown] = [200, { salt: saltBase64, legacy: false, legacyRecovery: false }],
) => {
  const calls: Call[] = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    const [status, body] = url.includes("/auth/salt")
      ? saltReply
      : (() => {
          const sent = JSON.parse(init?.body as string) as Record<string, unknown>;
          return "password" in sent && !("authKey" in sent)
            ? ([426, { error: "update the app to sign in" }] as const)
            : login(sent);
        })();
    return Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  };
  return { calls, api: createApi(fetchFn, fakeDerive) };
};

const bodyOf = (call: Call | undefined) => JSON.parse(call?.init?.body as string) as unknown;

describe("login", () => {
  it("signs in with the auth key alone and sends no credentials cookie", async () => {
    const { api, calls } = quark(() => [200, { token: "abc" }]);
    expect(await api.login("https://quark.local", "Brandon Apol", "pw")).toEqual({ ok: true, value: "abc" });
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ["GET", "https://quark.local/api/v0/auth/salt?username=Brandon+Apol"],
      ["POST", "https://quark.local/api/v0/auth/login"],
    ]);
    expect(calls.every((c) => c.init?.credentials === "omit")).toBe(true);
    expect(bodyOf(calls[1])).toEqual({ username: "Brandon Apol", authKey: `key(pw,${salt.join(".")})` });
  });

  it("sends the password beside the auth key once for a legacy account", async () => {
    const { api, calls } = quark(() => [200, { token: "abc" }], [200, { salt: saltBase64, legacy: true }]);
    expect(await api.login("https://quark.local", "brandon", "pw")).toEqual({ ok: true, value: "abc" });
    expect(bodyOf(calls[1])).toEqual({ username: "brandon", password: "pw", authKey: `key(pw,${salt.join(".")})` });
  });

  it.each([
    ["404", [404, { error: "not found" }]],
    ["401 for an unknown path", [401, { error: "authentication required" }]],
    ["web app page", [200, "<!doctype html><html></html>"]],
  ] as const)("refuses a Quark from before auth keys (%s) without sending the password", async (_, saltReply) => {
    const { api, calls } = quark(() => [200, { token: "abc" }], saltReply);
    expect(await api.login("https://quark.local", "b", "pw")).toEqual({
      ok: false,
      error: { kind: "refused", reason: quarkTooOld() },
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a failed salt lookup", async () => {
    const { api } = quark(() => [200, { token: "abc" }], [429, { error: "slow down" }]);
    expect(await api.login("https://quark.local", "b", "pw")).toEqual({ ok: false, error: { kind: "rateLimited" } });
  });

  it("tells the user to update the extension on 426", async () => {
    const { api } = quark(() => [426, { error: "update the app to sign in" }]);
    expect(await api.login("https://quark.local", "b", "pw")).toEqual({
      ok: false,
      error: { kind: "refused", reason: extensionTooOld() },
    });
  });

  it("maps 401 to bad credentials", async () => {
    const { api } = quark(() => [401, { error: "invalid credentials" }]);
    expect(await api.login("https://quark.local", "b", "x")).toEqual({ ok: false, error: { kind: "badCredentials" } });
  });

  it.each([
    ["pending", "your account request is waiting for approval"],
    ["disabled", "this account has been disabled"],
  ])("maps a 403 for a %s account from the refusal's status field", async (status, message) => {
    const { api } = quark(() => [403, { error: message, status }]);
    expect(await api.login("https://quark.local", "b", "x")).toEqual({
      ok: false,
      error: { kind: "accountRefused", status },
    });
  });
});

describe("unlock", () => {
  it("tells a wrong master password from an expired session", async () => {
    expect(await respond(401, { error: "incorrect master password" }).api.unlock(connection, "x")).toEqual({
      ok: false,
      error: { kind: "badMasterPassword" },
    });
    expect(await respond(401, { error: "authentication required" }).api.unlock(connection, "x")).toEqual({
      ok: false,
      error: { kind: "signedOut" },
    });
  });

  it("recognizes an uninitialized vault", async () => {
    const { api } = respond(400, { error: "vault is not initialized — call POST /vault/setup first" });
    expect(await api.unlock(connection, "x")).toEqual({ ok: false, error: { kind: "notInitialized" } });
  });
});

describe("authenticated requests", () => {
  it("sends the bearer token", async () => {
    const { api, calls } = respond(200, { entries: [] });
    await api.listEntries(connection);
    expect((calls[0]?.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer t0k3n");
  });

  it.each([
    [403, { kind: "notAdmin" }],
    [404, { kind: "notFound" }],
    [423, { kind: "locked", reason: "idle timeout" }],
    [429, { kind: "rateLimited" }],
    [503, { kind: "driveDisconnected" }],
    [500, { kind: "server", status: 500, message: "boom" }],
  ])("maps %i", async (status, expected) => {
    const message = status === 423 ? "vault is locked: idle timeout" : "boom";
    const { api } = respond(status, { error: message });
    expect(await api.getEntry(connection, 7)).toEqual({ ok: false, error: expected });
  });

  it("maps 426 to a clear 'extension too old' message", () => {
    const error = toApiError({ status: 426, message: "upgrade required", state: "" });
    expect(errorText(error)).toBe("This extension is too old for your Quark. Update the extension, then sign in again.");
  });

  it("reports a network failure", async () => {
    const api = createApi(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await api.status(connection)).toEqual({ ok: false, error: { kind: "network", message: "Failed to fetch" } });
  });
});

describe("decoding", () => {
  it("reads entries and tolerates missing fields", async () => {
    const { api } = respond(200, { entries: [{ id: 3, name: "GitHub", urlHost: "github.com", folderId: 2 }, { id: 4 }] });
    const result = await api.listEntries(connection);
    expect(result.ok && result.value).toEqual([
      { id: 3, name: "GitHub", urlHost: "github.com", folderId: 2, createdAt: "", updatedAt: "" },
      { id: 4, name: "", urlHost: "", folderId: null, createdAt: "", updatedAt: "" },
    ]);
  });

  it("reads the vault status", async () => {
    const { api } = respond(200, { initialized: true, locked: false, autoLockSeconds: 900, deviceConnected: true });
    const result = await api.status(connection);
    expect(result.ok && result.value).toEqual({
      initialized: true,
      locked: false,
      autoLockSeconds: 900,
      deviceConnected: true,
      lockReason: "",
    });
  });
});
