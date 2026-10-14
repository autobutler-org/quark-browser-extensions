import { authKey } from "./authKey.ts";

export type Reply = Readonly<{ status: number; body: any }>;

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
    } catch {}
    return { status: response.status, body: parsed };
  };

  const expectOk = async (reply: Promise<Reply>, what: string): Promise<any> => {
    const { status, body } = await reply;
    if (status !== 200) throw new Error(`${what}: HTTP ${status} ${JSON.stringify(body)}`);
    return body;
  };

  const salt = async (username: string) =>
    expectOk(call("GET", `/auth/salt?${new URLSearchParams({ username })}`), "GET /auth/salt") as Promise<{
      salt: string;
      legacy: boolean;
    }>;

  return {
    call,
    expectOk,
    salt,
    // Signs in the way a current Quark app does: salt, then the auth key.
    login: async (username: string, password: string): Promise<string> => {
      const { salt: s } = await salt(username);
      const body = await expectOk(call("POST", "/auth/login", { username, authKey: authKey(password, s) }), "login");
      return body.token as string;
    },
  };
};

export type Client = ReturnType<typeof client>;
