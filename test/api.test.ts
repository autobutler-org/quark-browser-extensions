import { createApi, toApiError, type FetchFn } from "../src/shared/api";
import { createUpgradeLedger } from "../src/shared/authKey";
import { errorText, extensionTooOld, legacyAgain, legacyInsecure, legacyUpgradeNeeded, quarkTooOld } from "../src/shared/errors";
import { fakeChrome } from "./fakeChrome";

type Call = Readonly<{ url: string; init: RequestInit | undefined }>;

const respond = (status: number, body: unknown) => {
  const calls: Call[] = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body === undefined ? "" : JSON.stringify(body), { status }));
  };
  return { calls, api: createApi(fetchFn, memoryLedger()) };
};

const connection = { server: "https://quark.local", token: "t0k3n" };

const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
const saltBase64 = btoa(String.fromCharCode(...salt));

// Stands in for the Argon2id derivation, which takes seconds; deriveKeys
// itself is pinned by the vectors in vaultCrypto.test.ts.
const wrapKey = Uint8Array.of(9, 9, 9);
const fakeDerive = (password: string, from: Uint8Array) =>
  Promise.resolve({ authKey: `key(${password},${from.join(".")})`, vaultWrapKey: wrapKey });

// A Quark v0.47.0+ sign-in: GET /auth/salt, then POST /auth/login, which
// refuses a password sent without an auth key with 426 (quark#2430).
const quark = (
  login: (body: Record<string, unknown>) => readonly [number, unknown],
  saltReply: readonly [number, unknown] = [200, { salt: saltBase64, legacy: false, legacyRecovery: false }],
  // The extension's record of upgraded accounts and the connect form's consent, in fresh storage per test unless shared.
  ledger = memoryLedger(),
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
  return { calls, ledger, api: createApi(fetchFn, ledger, fakeDerive) };
};

function memoryLedger() {
  const { storage } = fakeChrome().chrome;
  let ids: readonly string[] = [];
  const keyed = { load: () => Promise.resolve(ids), save: (next: readonly string[]) => Promise.resolve(void (ids = next)) };
  return createUpgradeLedger(keyed, () => storage.session);
}

const bodyOf = (call: Call | undefined) => JSON.parse(call?.init?.body as string) as unknown;

describe("login", () => {
  it("signs in with the auth key alone and sends no credentials cookie", async () => {
    const { api, calls } = quark(() => [200, { token: "abc" }]);
    expect(await api.login("https://quark.local", "Brandon Apol", "pw")).toEqual({ ok: true, value: { token: "abc", salt, vaultWrapKey: wrapKey } });
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ["GET", "https://quark.local/api/v0/auth/salt?username=Brandon+Apol"],
      ["POST", "https://quark.local/api/v0/auth/login"],
    ]);
    expect(calls.every((c) => c.init?.credentials === "omit")).toBe(true);
    expect(bodyOf(calls[1])).toEqual({ username: "Brandon Apol", authKey: `key(pw,${salt.join(".")})` });
  });

  it("sends the password beside the auth key once for a legacy account, after the user consents", async () => {
    const { api, calls, ledger } = quark(() => [200, { token: "abc" }], [200, { salt: saltBase64, legacy: true }]);
    await ledger.giveConsent("https://quark.local", "brandon");
    expect((await api.login("https://quark.local", "brandon", "pw")).ok).toBe(true);
    expect(bodyOf(calls[1])).toEqual({ username: "brandon", password: "pw", authKey: `key(pw,${salt.join(".")})` });
  });

  describe("a legacy answer (#76)", () => {
    const legacySalt = [200, { salt: saltBase64, legacy: true }] as const;
    const posts = (calls: readonly Call[]) => calls.filter((call) => call.init?.method === "POST");

    it("sends nothing until the user consents, and says so to the connect form", async () => {
      const { api, calls } = quark(() => [200, { token: "abc" }], legacySalt);
      expect(await api.login("https://quark.local", "brandon", "pw")).toEqual({
        ok: false,
        error: {
          kind: "refused",
          reason: legacyUpgradeNeeded("https://quark.local"),
          legacyUpgrade: { server: "https://quark.local", username: "brandon" },
        },
      });
      expect(posts(calls)).toEqual([]);
    });

    it("refuses a second legacy answer for an account that already upgraded, however often the server asks", async () => {
      const { api, calls, ledger } = quark(() => [200, { token: "abc" }], legacySalt);
      await ledger.giveConsent("https://quark.local", "brandon");
      expect((await api.login("https://quark.local", "brandon", "pw")).ok).toBe(true);
      for (const username of ["brandon", " Brandon "]) {
        // Even a fresh consent doesn't let the password out again.
        await ledger.giveConsent("https://quark.local", username);
        expect(await api.login("https://quark.local", username, "pw")).toEqual({
          ok: false,
          error: { kind: "refused", reason: legacyAgain("https://quark.local") },
        });
      }
      expect(posts(calls).filter((call) => "password" in (bodyOf(call) as object))).toHaveLength(1);
    });

    it("refuses a legacy answer for an account that has signed in with its key alone", async () => {
      const ledger = memoryLedger();
      expect((await quark(() => [200, { token: "abc" }], undefined, ledger).api.login("https://quark.local", "brandon", "pw")).ok).toBe(true);
      const { api, calls } = quark(() => [200, { token: "abc" }], legacySalt, ledger);
      await ledger.giveConsent("https://quark.local", "brandon");
      expect(await api.login("https://quark.local", "brandon", "pw")).toEqual({
        ok: false,
        error: { kind: "refused", reason: legacyAgain("https://quark.local") },
      });
      expect(posts(calls)).toEqual([]);
    });

    it("keys the record by server and account, so another one can still upgrade", async () => {
      const { api, ledger } = quark(() => [200, { token: "abc" }], legacySalt);
      await ledger.markKeyed("https://quark.local", "brandon");
      await ledger.giveConsent("https://other.quark", "brandon");
      expect((await api.login("https://other.quark", "brandon", "pw")).ok).toBe(true);
      await ledger.giveConsent("https://quark.local", "sam");
      expect((await api.login("https://quark.local", "sam", "pw")).ok).toBe(true);
    });

    it("never sends the password over plain http, even with consent", async () => {
      const { api, calls, ledger } = quark(() => [200, { token: "abc" }], legacySalt);
      await ledger.giveConsent("http://quark.lan", "brandon");
      expect(await api.login("http://quark.lan", "brandon", "pw")).toEqual({
        ok: false,
        error: { kind: "refused", reason: legacyInsecure("http://quark.lan") },
      });
      expect(posts(calls)).toEqual([]);
    });

    it("upgrades over loopback http, which never leaves the machine", async () => {
      const { api, ledger } = quark(() => [200, { token: "abc" }], legacySalt);
      await ledger.giveConsent("http://localhost:8080", "brandon");
      expect((await api.login("http://localhost:8080", "brandon", "pw")).ok).toBe(true);
    });

    it("uses the consent up on a failed upgrade and doesn't record a key", async () => {
      const { api, calls, ledger } = quark(() => [401, { error: "invalid credentials" }], legacySalt);
      await ledger.giveConsent("https://quark.local", "brandon");
      expect(await api.login("https://quark.local", "brandon", "typo")).toEqual({ ok: false, error: { kind: "badCredentials" } });
      expect(await ledger.hasKey("https://quark.local", "brandon")).toBe(false);
      expect((await api.login("https://quark.local", "brandon", "pw")).ok).toBe(false);
      expect(posts(calls)).toHaveLength(1);
    });
  });

  describe("overlapping sign-ins (#140)", () => {
    const legacySalt = [200, { salt: saltBase64, legacy: true }] as const;
    const passwordBodies = (calls: readonly Call[]) =>
      calls.filter((call) => call.init?.method === "POST" && "password" in (bodyOf(call) as object));

    it("lets one consent send the password in one body", async () => {
      const { api, calls, ledger } = quark(() => [200, { token: "abc" }], legacySalt);
      await ledger.giveConsent("https://quark.local", "brandon");
      const results = await Promise.all([
        api.login("https://quark.local", "brandon", "pw"),
        api.login("https://quark.local", "brandon", "pw"),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(passwordBodies(calls)).toHaveLength(1);
    });

    it("sends the password once when the connect form is submitted twice", async () => {
      const { api, calls, ledger } = quark(() => [200, { token: "abc" }], legacySalt);
      await ledger.giveConsent("https://quark.local", "brandon");
      const first = api.login("https://quark.local", "brandon", "pw");
      await ledger.giveConsent("https://quark.local", "brandon");
      const second = api.login("https://quark.local", "brandon", "pw");
      expect((await first).ok).toBe(true);
      expect(await second).toEqual({ ok: false, error: { kind: "refused", reason: legacyAgain("https://quark.local") } });
      expect(passwordBodies(calls)).toHaveLength(1);
    });
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

describe("the vault routes", () => {
  const wrapped = {
    wrappedByPassword: btoa("wrapped"),
    saltPw: saltBase64,
    wrappedByPhrase: btoa("phrase"),
    saltRp: saltBase64,
    kdfParams: { alg: "argon2id13+hkdf-sha256", opsLimit: 3, memLimit: 67108864 },
  };

  it("reads the wrapped vault key and the cost it was derived at", async () => {
    const { api, calls } = respond(200, wrapped);
    const result = await api.vaultKey(connection);
    expect(result.ok && { ...result.value, wrapped: new TextDecoder().decode(result.value.wrapped), salt: Array.from(result.value.salt) }).toEqual({
      wrapped: "wrapped",
      salt: Array.from(salt),
      cost: { opsLimit: 3, memLimit: 67108864 },
    });
    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([["GET", "https://quark.local/api/v0/vault/key"]]);
  });

  it("knows an account with no vault from a missing key, and refuses a key it can't read", async () => {
    expect(await respond(404, { error: "no vault" }).api.vaultKey(connection)).toEqual({ ok: false, error: { kind: "notInitialized" } });
    expect(await respond(200, { ...wrapped, kdfParams: null }).api.vaultKey(connection)).toMatchObject({ ok: false, error: { kind: "server" } });
    expect(await respond(401, { error: "authentication required" }).api.vaultKey(connection)).toEqual({ ok: false, error: { kind: "signedOut" } });
  });

  it("sends only the sealed item, and knows a vault deleted since it was opened", async () => {
    const sealed = { ciphertext: "Y2lwaGVy", nonce: "bm9uY2U=", formatVersion: 1 };
    const { api, calls } = respond(201, { id: 12, ...sealed });
    expect(await api.createItem(connection, sealed)).toEqual({ ok: true, value: 12 });
    expect(bodyOf(calls[0])).toEqual(sealed);
    expect(await respond(409, { error: "no vault" }).api.createItem(connection, sealed)).toEqual({ ok: false, error: { kind: "notInitialized" } });
    const update = respond(200, sealed);
    expect(await update.api.updateItem(connection, 12, sealed)).toEqual({ ok: true, value: null });
    expect([update.calls[0]?.init?.method, update.calls[0]?.url, bodyOf(update.calls[0])]).toEqual([
      "PUT",
      "https://quark.local/api/v0/vault/items/12",
      sealed,
    ]);
  });
});

describe("the request path (#144)", () => {
  it("refuses to follow a redirect on any request", async () => {
    const { api, calls } = respond(200, {});
    await api.vaultKey(connection);
    await api.listItems(connection);
    await api.createItem(connection, { ciphertext: "", nonce: "", formatVersion: 1 });
    expect(calls.map((call) => call.init?.redirect)).toEqual(["error", "error", "error"]);
  });

  it("refuses an answer from another origin", async () => {
    const fetchFn: FetchFn = () => {
      const response = new Response(JSON.stringify({ token: "abc" }), { status: 200 });
      Object.defineProperty(response, "url", { value: "https://elsewhere.example/api/v0/vault/key" });
      return Promise.resolve(response);
    };
    const result = await createApi(fetchFn, memoryLedger()).vaultKey(connection);
    expect(result).toEqual({ ok: false, error: { kind: "network", message: expect.stringContaining("elsewhere.example") as unknown } });
  });
});

describe("authenticated requests", () => {
  it("sends the bearer token", async () => {
    const { api, calls } = respond(200, []);
    await api.listItems(connection);
    expect((calls[0]?.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer t0k3n");
  });

  it.each([
    [404, { kind: "notFound" }],
    [429, { kind: "rateLimited" }],
    [500, { kind: "server", status: 500, message: "boom" }],
  ])("maps %i", async (status, expected) => {
    const { api } = respond(status, { error: "boom" });
    expect(await api.getItem(connection, 7)).toEqual({ ok: false, error: expected });
  });

  it("maps 426 to a clear 'extension too old' message", () => {
    const error = toApiError({ status: 426, message: "upgrade required", state: "" });
    expect(errorText(error)).toBe("This extension is too old for your Quark. Update the extension, then sign in again.");
  });

  it("reports a network failure", async () => {
    const api = createApi(() => Promise.reject(new TypeError("Failed to fetch")), memoryLedger());
    expect(await api.vaultKey(connection)).toEqual({ ok: false, error: { kind: "network", message: "Failed to fetch" } });
  });
});

describe("decoding", () => {
  it("reads items and tolerates missing fields", async () => {
    const { api } = respond(200, [{ id: 3, ciphertext: "Yw==", nonce: "bg==", formatVersion: 1, createdAt: "c", updatedAt: "u" }, { id: 4 }]);
    const result = await api.listItems(connection);
    expect(result.ok && result.value).toEqual([
      { id: 3, ciphertext: "Yw==", nonce: "bg==", formatVersion: 1, updatedAt: "u" },
      { id: 4, ciphertext: "", nonce: "", formatVersion: NaN, updatedAt: "" },
    ]);
    expect(await respond(200, { not: "a list" }).api.listItems(connection)).toEqual({ ok: true, value: [] });
  });
});
