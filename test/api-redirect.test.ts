// @vitest-environment node
// Real fetch against two loopback listeners on different ports, so a redirect crosses origins the way it would in
// the worker (#144).
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApi } from "../src/shared/api";
import { createUpgradeLedger } from "../src/shared/authKey";
import { fakeChrome } from "./fakeChrome";

type Listener = Readonly<{ origin: string; bodies: string[]; close: () => Promise<void> }>;

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => resolve(body));
  });

const listen = async (
  answer: (path: string, origin: string) => readonly [number, Record<string, string>, string],
): Promise<Listener> => {
  const bodies: string[] = [];
  let origin = "";
  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      if (body !== "") {
        bodies.push(body);
      }
      const [status, headers, text] = answer(request.url ?? "", origin);
      response.writeHead(status, { "Content-Type": "application/json", ...headers }).end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, bodies, close: () => new Promise((resolve) => server.close(() => resolve())) };
};

const salt = btoa(String.fromCharCode(...Uint8Array.from({ length: 16 }, (_, i) => i)));
const fakeDerive = () => Promise.resolve({ authKey: "key", vaultWrapKey: new Uint8Array(32) });

const listeners: Listener[] = [];
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

const thief = async () => {
  const listener = await listen(() => [200, {}, JSON.stringify({ token: "stolen" })]);
  listeners.push(listener);
  return listener;
};

// A Quark whose salt answer is real and legacy, and whose every other answer is a 307 elsewhere.
const redirectingQuark = async (to: (origin: string) => string) => {
  const listener = await listen((path, origin) =>
    path.startsWith("/api/v0/auth/salt")
      ? [200, {}, JSON.stringify({ salt, legacy: true })]
      : [307, { Location: `${to(origin)}/steal` }, ""],
  );
  listeners.push(listener);
  return listener;
};

const memoryLedger = () => {
  const { storage } = fakeChrome().chrome;
  let ids: readonly string[] = [];
  const keyed = { load: () => Promise.resolve(ids), save: (next: readonly string[]) => Promise.resolve(void (ids = next)) };
  return createUpgradeLedger(keyed, () => storage.session);
};

describe("a redirect from the Quark (#144)", () => {
  it("never carries a legacy password to another origin", async () => {
    const elsewhere = await thief();
    const quark = await redirectingQuark(() => elsewhere.origin);
    const ledger = memoryLedger();
    const api = createApi((input, init) => fetch(input, init), ledger, fakeDerive);
    await ledger.giveConsent(quark.origin, "brandon");
    const result = await api.login(quark.origin, "brandon", "s3cret-password");
    expect(result.ok).toBe(false);
    expect(elsewhere.bodies).toEqual([]);
    expect(await ledger.hasKey(quark.origin, "brandon")).toBe(false);
  });

  it("never carries a sealed item to another origin", async () => {
    const elsewhere = await thief();
    const quark = await redirectingQuark(() => elsewhere.origin);
    const api = createApi((input, init) => fetch(input, init), memoryLedger(), fakeDerive);
    const result = await api.createItem({ server: quark.origin, token: "t0k3n" }, { ciphertext: "c2VhbGVk", nonce: "bm9uY2U=", formatVersion: 1 });
    expect(result.ok).toBe(false);
    expect(elsewhere.bodies).toEqual([]);
  });

  it("doesn't follow a redirect even to its own origin", async () => {
    const quark = await redirectingQuark((origin) => origin);
    const api = createApi((input, init) => fetch(input, init), memoryLedger(), fakeDerive);
    const sealed = { ciphertext: "c2VhbGVk", nonce: "bm9uY2U=", formatVersion: 1 };
    expect((await api.createItem({ server: quark.origin, token: "t0k3n" }, sealed)).ok).toBe(false);
    expect(quark.bodies).toEqual([JSON.stringify(sealed)]);
  });
});
