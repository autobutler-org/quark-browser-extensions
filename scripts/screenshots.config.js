// Playwright config for the store screenshots (scripts/screenshots.spec.js).
//
//   npm run build:chrome && npx playwright test -c scripts/screenshots.config.js
//
// It reuses the e2e setup: e2e/global-setup.ts starts the Quark, seeds it and
// serves the test site, and e2e/fixtures.ts loads .output/chrome-mv3 into a
// fresh Chromium. The mock Quark is the default, so it runs offline;
// E2E_TARGET=quark uses a real one, as for the e2e tests. The PNGs land in
// .output/store-screenshots/, which git and the AMO sources zip both leave out.
/* global process */
import { defineConfig } from "@playwright/test";

process.env.E2E_TARGET ??= "mock";

export default defineConfig({
  testDir: ".",
  testMatch: "screenshots.spec.js",
  globalSetup: "../e2e/global-setup.ts",
  outputDir: "../e2e/test-results/screenshots",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "list",
});
