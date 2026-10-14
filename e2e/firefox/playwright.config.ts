import { defineConfig } from "@playwright/test";

// The Firefox smoke tests: the same Quark, seed and test site as the Chromium
// tests (../global-setup.ts), with the Firefox build driven by Puppeteer over
// WebDriver BiDi (see fixtures.ts). One Quark, so one test at a time.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "../global-setup.ts",
  outputDir: "../test-results/firefox",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["github"], ["html", { outputFolder: "../playwright-report/firefox", open: "never" }]]
    : [["list"], ["html", { outputFolder: "../playwright-report/firefox", open: "never" }]],
});
