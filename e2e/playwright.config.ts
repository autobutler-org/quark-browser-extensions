import { defineConfig } from "@playwright/test";

// The tests share one Quark, whose vault lock is server-wide, so they run one
// at a time. Each test gets its own Chromium profile (see fixtures.ts).
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["github"], ["html", { outputFolder: "./playwright-report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "./playwright-report", open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
