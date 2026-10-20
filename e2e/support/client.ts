import { authKey } from "./authKey.ts";

export type Reply = Readonly<{ status: number; body: unknown }>;

// A bare client for Quark's /api/v0, used to seed the server and to check what
// the extension did to it. It goes straight to the server, never through the
// recording proxy, so it never shows up in the extension's request log.
export const client = (server: string) => {
  const call = async (method: string, path: string, body?: unknown, token?: string): Promise<Reply> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
    const response = await fetch(`${server}/api/v0${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: keep the text as the body.
    }
    return { status: response.status, body: parsed };
  };

  // Resolves to a 2xx reply's body, which the caller says the shape of.
  const expectOk = async <T = unknown>(reply: Promise<Reply>, what: string): Promise<T> => {
    const { status, body } = await reply;
    if (status < 200 || status > 299) throw new Error(`${what}: HTTP ${status} ${JSON.stringify(body)}`);
    return body as T;
  };

  const salt = async (username: string) =>
    expectOk<{ salt: string; legacy: boolean }>(call("GET", `/auth/salt?${new URLSearchParams({ username })}`), "GET /auth/salt");

  return {
    call,
    expectOk,
    salt,
    // Signs in the way a current Quark app does: salt, then the auth key.
    login: async (username: string, password: string): Promise<string> => {
      const { salt: s } = await salt(username);
      const body = await expectOk<{ token: string }>(call("POST", "/auth/login", { username, authKey: authKey(password, s) }), "login");
      return body.token;
    },
  };
};

export type Client = ReturnType<typeof client>;
