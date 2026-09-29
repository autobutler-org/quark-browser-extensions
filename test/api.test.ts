import { createApi, type FetchFn } from "../src/shared/api";

type Call = Readonly<{ url: string; init: RequestInit | undefined }>;

const respond = (status: number, body: unknown) => {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  };
  return { calls, api: createApi(fetchFn) };
};

const connection = { server: "https://quark.local", token: "t0k3n" };

describe("login", () => {
  it("returns the session token and sends no credentials cookie", async () => {
    const { api, calls } = respond(200, { token: "abc" });
    expect(await api.login("https://quark.local", "brandon", "pw")).toEqual({ ok: true, value: "abc" });
    expect(calls[0]?.url).toBe("https://quark.local/api/v0/auth/login");
    expect(calls[0]?.init?.credentials).toBe("omit");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ username: "brandon", password: "pw" });
  });

  it("maps 401 to bad credentials", async () => {
    const { api } = respond(401, { error: "invalid credentials" });
    expect(await api.login("https://quark.local", "b", "x")).toEqual({ ok: false, error: { kind: "badCredentials" } });
  });

  it("maps 403 to a refused account with its status", async () => {
    const { api } = respond(403, { error: "pending" });
    expect(await api.login("https://quark.local", "b", "x")).toEqual({
      ok: false,
      error: { kind: "accountRefused", status: "pending" },
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

  it("reports a network failure", async () => {
    const api = createApi(async () => {
      throw new TypeError("Failed to fetch");
    });
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
