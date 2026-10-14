import { randomBytes } from "node:crypto";
import http from "node:http";
import { listen } from "./listen.ts";
import { legacy } from "./seed.ts";
import type { Target } from "./quark.ts";

// An offline stand-in for `quark serve --insecure`, covering only the routes
// the extension and the seed call. It follows the real server where the
// extension's behaviour depends on it, and the e2e contract test runs against
// both: a raw password with no auth key is refused with 426 at setup and login,
// a legacy account upgrades once with the password beside the key, the entry
// list works while the vault is locked and an entry doesn't.

type Account = { salt: string; authKey: string | null; password: string | null };
type Entry = Record<string, unknown> & { id: number };

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<any> =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
  });

const tooOld = { error: "This version of the app is too old for this Quark. Update the app to continue." };
const hostOf = (url: unknown) => {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
};

export const startMockQuark = async (port?: number): Promise<Target> => {
  const unknownSalt = randomBytes(16).toString("base64");
  const accounts = new Map<string, Account>();
  const tokens = new Map<string, string>();
  const entries = new Map<number, Entry>();
  let nextId = 1;
  let master: string | null = null;
  let locked = true;

  const issue = (username: string) => {
    const token = randomBytes(32).toString("hex");
    tokens.set(token, username);
    return token;
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname.replace(/^\/api\/v0/, "");
    const method = req.method ?? "GET";
    const body = method === "GET" ? {} : await readBody(req);
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
    if (path === "/vault/status") {
      return json(res, 200, { initialized: master !== null, locked, autoLockSeconds: 300, storageDevice: "internal", deviceConnected: true });
    }
    if (path === "/vault/setup" && method === "POST") {
      if (master !== null) return json(res, 400, { error: "vault already initialized" });
      if (typeof body.masterPassword !== "string" || body.masterPassword.length < 8) {
        return json(res, 400, { error: "master password must be at least 8 characters" });
      }
      master = body.masterPassword;
      locked = false;
      return json(res, 200, { initialized: true, locked: false });
    }
    if (path === "/vault/unlock" && method === "POST") {
      if (master === null) return json(res, 400, { error: "vault has not been initialized" });
      if (body.masterPassword !== master) return json(res, 401, { error: "incorrect master password" });
      locked = false;
      return json(res, 200, { locked: false });
    }
    if (path === "/vault/lock" && method === "POST") {
      locked = true;
      return json(res, 200, { locked: true });
    }
    if (path === "/vault/generate" && method === "POST") {
      const length = Number(body.length ?? 20);
      return json(res, 200, { password: randomBytes(length).toString("base64url").slice(0, length) });
    }
    if (path === "/vault/folders" && method === "POST") {
      return json(res, 200, { id: 1, name: body.name, parentId: null, sortOrder: 0 });
    }
    if (path === "/vault/entries" && method === "GET") {
      return json(res, 200, {
        entries: [...entries.values()].map(({ id, name, urlHost, folderId, createdAt, updatedAt }) => ({
          id, name, urlHost, folderId, createdAt, updatedAt,
        })),
      });
    }
    if (locked) return json(res, 423, { error: "vault is locked" });
    const now = new Date().toISOString();
    const stored = (id: number, fields: Record<string, unknown>, createdAt = now): Entry => ({
      id,
      name: fields.name ?? "",
      url: fields.url ?? "",
      urlHost: hostOf(fields.url),
      username: fields.username ?? "",
      password: fields.password ?? "",
      totpSecret: fields.totpSecret ?? "",
      notes: fields.notes ?? "",
      customFields: fields.customFields ?? [],
      folderId: fields.folderId ?? null,
      createdAt,
      updatedAt: now,
    });
    if (path === "/vault/entries" && method === "POST") {
      const entry = stored(nextId++, body);
      entries.set(entry.id, entry);
      return json(res, 200, entry);
    }
    const match = path.match(/^\/vault\/entries\/(\d+)$/);
    const current = match ? entries.get(Number(match[1])) : undefined;
    if (match && current === undefined) return json(res, 404, { error: "entry not found" });
    if (current && method === "GET") return json(res, 200, current);
    if (current && method === "PUT") {
      const entry = stored(current.id, body, current.createdAt as string);
      entries.set(entry.id, entry);
      return json(res, 200, entry);
    }
    if (current && method === "DELETE") {
      entries.delete(current.id);
      return json(res, 200, { message: "Entry deleted" });
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
    addLegacy: async () => {
      accounts.set(legacy.username, { salt: randomBytes(16).toString("base64"), authKey: null, password: legacy.password });
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

