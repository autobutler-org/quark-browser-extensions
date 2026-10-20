import { randomBytes } from "node:crypto";
import http from "node:http";
import { listen } from "./listen.ts";
import { legacy } from "./seed.ts";
import type { Target } from "./quark.ts";

// An offline stand-in for `quark serve --insecure`, covering only the routes
// the extension and the seed call. It follows the real server where the
// extension's behaviour depends on it, and the e2e contract test runs against
// both: a raw password with no auth key is refused with 426 at setup and login,
// a legacy account upgrades once with the password beside the key, and each
// account has its own vault of ciphertext the mock never opens (quark#3459).

type Account = { salt: string; authKey: string | null; password: string | null };
type Item = { id: number; owner: string; ciphertext: unknown; nonce: unknown; formatVersion: unknown; createdAt: string; updatedAt: string };

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

// A request body as the mock reads it. The extension and the seed always send a
// username; the rest is checked where it matters, as the real server does.
type Body = Record<string, unknown> &
  Readonly<{ username: string; authKey?: unknown; password?: unknown }>;

const readBody = (req: http.IncomingMessage): Promise<Body | null> =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Body) : ({} as Body));
      } catch {
        resolve(null);
      }
    });
  });

const tooOld = { error: "This version of the app is too old for this Quark. Update the app to continue." };

export const startMockQuark = async (port?: number): Promise<Target> => {
  const unknownSalt = randomBytes(16).toString("base64");
  const accounts = new Map<string, Account>();
  const tokens = new Map<string, string>();
  const keys = new Map<string, Record<string, unknown>>();
  const items = new Map<number, Item>();
  let nextId = 1;

  const issue = (username: string) => {
    const token = randomBytes(32).toString("hex");
    tokens.set(token, username);
    return token;
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname.replace(/^\/api\/v0/, "");
    const method = req.method ?? "GET";
    const body = method === "GET" ? ({} as Body) : await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid request body" });

    if (path === "/auth/status") return json(res, 200, { setup: accounts.size > 0 });
    if (path === "/auth/salt" && method === "GET") {
      const account = accounts.get(url.searchParams.get("username") ?? "");
      return json(res, 200, {
        salt: account?.salt ?? unknownSalt,
        legacy: account !== undefined && account.authKey === null,
        legacyRecovery: account !== undefined,
      });
    }
    if (path === "/auth/setup" && method === "POST") {
      if (typeof body.authKey !== "string") return json(res, 426, tooOld);
      if (accounts.size > 0) return json(res, 400, { error: "setup already completed" });
      accounts.set(body.username, { salt: unknownSalt, authKey: body.authKey, password: null });
      return json(res, 200, { message: "Setup complete.", token: issue(body.username) });
    }
    if (path === "/auth/login" && method === "POST") {
      if (typeof body.authKey !== "string") return json(res, 426, tooOld);
      const account = accounts.get(body.username);
      if (account === undefined) return json(res, 401, { error: "invalid credentials" });
      if (account.authKey === null) {
        if (body.password !== account.password) return json(res, 401, { error: "invalid credentials" });
        account.authKey = body.authKey;
        account.password = null;
      } else if (body.authKey !== account.authKey) {
        return json(res, 401, { error: "invalid credentials" });
      }
      return json(res, 200, { token: issue(body.username), legacyRecovery: true });
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokens.has(token)) return json(res, 401, { error: "authentication required" });

    if (path === "/auth/logout" && method === "POST") {
      tokens.delete(token);
      return json(res, 200, { message: "Logged out" });
    }
    const username = tokens.get(token)!;
    const now = new Date().toISOString();
    if (path === "/vault/key" && method === "GET") {
      const key = keys.get(username);
      return key === undefined ? json(res, 404, { error: "no vault" }) : json(res, 200, key);
    }
    if (path === "/vault/key" && method === "PUT") {
      if (body.password !== accounts.get(username)?.authKey) return json(res, 403, { error: "not the login password" });
      if (keys.has(username)) return json(res, 409, { error: "vault exists" });
      const { password: _, ...key } = body;
      keys.set(username, { ...key, createdAt: now, updatedAt: now });
      return json(res, 201, keys.get(username));
    }
    const sealed = (fields: Body) => ({ ciphertext: fields.ciphertext, nonce: fields.nonce, formatVersion: fields.formatVersion });
    const shown = ({ owner: _, ...item }: Item) => item;
    if (path === "/vault/items" && method === "GET") {
      return json(res, 200, [...items.values()].filter((item) => item.owner === username).map(shown));
    }
    if (path === "/vault/items" && method === "POST") {
      if (!keys.has(username)) return json(res, 409, { error: "no vault" });
      const item: Item = { id: nextId++, owner: username, ...sealed(body), createdAt: now, updatedAt: now };
      items.set(item.id, item);
      return json(res, 201, shown(item));
    }
    const match = path.match(/^\/vault\/items\/(\d+)$/);
    const current = match ? items.get(Number(match[1])) : undefined;
    // Another account's item is as missing as one that never was.
    if (match && current?.owner !== username) return json(res, 404, { error: "item not found" });
    if (current && method === "GET") return json(res, 200, shown(current));
    if (current && method === "PUT") {
      const item: Item = { ...current, ...sealed(body), updatedAt: now };
      items.set(item.id, item);
      return json(res, 200, shown(item));
    }
    if (current && method === "DELETE") {
      items.delete(current.id);
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      return res.end();
    }
    json(res, 404, { error: "not found" });
  };

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Origin, Accept, X-Requested-With",
        "Access-Control-Allow-Methods": "POST, GET, PUT, PATCH, DELETE, OPTIONS",
      });
      res.end();
      return;
    }
    route(req, res).catch((error) => json(res, 500, { error: String(error) }));
  });
  const bound = await listen(server, port);

  return {
    server: `http://127.0.0.1:${bound}`,
    addLegacy: () => {
      accounts.set(legacy.username, { salt: randomBytes(16).toString("base64"), authKey: null, password: legacy.password });
      return Promise.resolve();
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

