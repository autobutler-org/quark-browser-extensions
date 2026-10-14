import { client, type Client } from "./client.ts";
import { logPath, type Logged } from "./proxy.ts";
import type { Seeded } from "./seed.ts";

// What global-setup.ts started, as the tests in every browser see it.
export const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is unset: run the tests through a playwright.config.ts`);
  return value;
};

export type Quark = Readonly<{
  // Where the extension connects: the recording proxy in front of the Quark.
  server: string;
  // The Quark itself, for checking what the extension changed.
  api: Client;
  seed: Seeded;
  // Every API request the extension made since the last clear.
  wire: () => Promise<Logged[]>;
  clearWire: () => Promise<void>;
  target: "quark" | "mock";
}>;

export const quarkFromEnv = (): Quark => {
  const server = env("E2E_QUARK");
  const wire = async (method = "GET") => (await (await fetch(`${server}${logPath}`, { method })).json()) as Logged[];
  return {
    server,
    api: client(env("E2E_QUARK_DIRECT")),
    seed: JSON.parse(env("E2E_SEED")) as Seeded,
    wire: () => wire(),
    clearWire: async () => void (await wire("DELETE")),
    target: env("E2E_TARGET") as "quark" | "mock",
  };
};
