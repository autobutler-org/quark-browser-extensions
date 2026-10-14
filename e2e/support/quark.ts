import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./listen.ts";
import bcrypt from "bcryptjs";
import { legacy } from "./seed.ts";

export type Target = Readonly<{
  server: string;
  // Puts the legacy account straight into the server's store.
  addLegacy: () => Promise<void>;
  stop: () => Promise<void>;
}>;

const waitForUp = async (server: string, exited: () => string | null): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit !== null) throw new Error(`quark serve exited before it answered: ${exit}`);
    try {
      const response = await fetch(`${server}/api/v0/auth/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`quark serve did not answer at ${server} within 60s`);
};

// Starts `quark serve --insecure` from a binary scripts/build-quark.sh built,
// with HOME pointed at a fresh directory: Quark keeps its data, SQLite database
// included, in $HOME/quark/data, so every run starts from first boot.
export const startQuark = async (binary: string, logFile: string, port?: number): Promise<Target> => {
  if (!existsSync(binary)) {
    throw new Error(`No Quark binary at ${binary}. Build one with QUARK_SRC=/path/to/quark scripts/build-quark.sh.`);
  }
  port ??= await freePort();
  const home = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "quark-e2e-"));
  const log = createWriteStream(logFile);
  // Without QUARK_DATABASE_URL the server uses SQLite, which addLegacy writes to.
  const { QUARK_DATABASE_URL: _, ...env } = process.env;
  const child = spawn(binary, ["serve", "--insecure"], {
    env: { ...env, HOME: home, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exit: string | null = null;
  child.on("exit", (code, signal) => (exit = `code ${code} signal ${signal} (log: ${logFile})`));
  const server = `http://127.0.0.1:${port}`;
  await waitForUp(server, () => exit);

  return {
    server,
    addLegacy: async () => {
      // An account a Quark from before auth keys made: a bcrypt password hash
      // (Quark still verifies bcrypt) and no auth key. node:sqlite needs Node
      // 22.13+ (22.5+ with a flag).
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(home, "quark", "data", "quark.db"));
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.prepare("INSERT INTO users (username, password_hash, recovery_phrase_hash, is_admin) VALUES (?, ?, '', 1)").run(
          legacy.username,
          bcrypt.hashSync(legacy.password, 4),
        );
      } finally {
        db.close();
      }
    },
    stop: async () => {
      if (exit === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
        if (exit === null) child.kill("SIGKILL");
      }
      log.end();
      await rm(home, { recursive: true, force: true });
    },
  };
};
