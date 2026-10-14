import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startMockQuark } from "./support/mock-quark.ts";
import { startProxy } from "./support/proxy.ts";
import { startQuark } from "./support/quark.ts";
import { seed } from "./support/seed.ts";
import { startSite } from "./support/site.ts";

// Each server takes any free port unless its variable names one.
const port = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);

// Starts the Quark the tests run against, seeds it, and puts the recording
// proxy in front of it. E2E_TARGET picks the Quark:
//   quark (default)  `quark serve --insecure` from QUARK_BIN, which defaults to
//                    the e2e/.quark/quark that scripts/build-quark.sh writes
//   mock             the in-process mock in support/mock-quark.ts, offline
// The tests find everything through the E2E_* variables set here.
export default async function globalSetup() {
  const target = process.env.E2E_TARGET ?? "quark";
  if (target !== "quark" && target !== "mock") throw new Error(`E2E_TARGET must be quark or mock, not ${target}`);
  // Kept out of test-results/, which Playwright empties when the tests start.
  const logs = fileURLToPath(new URL("./.quark/", import.meta.url));
  await mkdir(logs, { recursive: true });

  const site = await startSite(port("E2E_SITE_PORT"));
  const quark =
    target === "mock"
      ? await startMockQuark(port("E2E_QUARK_PORT"))
      : await startQuark(
          process.env.QUARK_BIN ?? fileURLToPath(new URL("./.quark/quark", import.meta.url)),
          `${logs}serve.log`,
          port("E2E_QUARK_PORT"),
        );
  try {
    const seeded = await seed(quark.server, site.url, quark.addLegacy);
    const proxy = await startProxy(quark.server, port("E2E_API_PORT"));
    process.env.E2E_TARGET = target;
    process.env.E2E_QUARK = proxy.url;
    process.env.E2E_QUARK_DIRECT = quark.server;
    process.env.E2E_SITE = site.url;
    process.env.E2E_SEED = JSON.stringify(seeded);
    return async () => {
      await proxy.stop();
      await quark.stop();
      await site.stop();
    };
  } catch (error) {
    await quark.stop();
    await site.stop();
    throw error;
  }
}
