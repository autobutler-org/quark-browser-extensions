import { Browser as Installed, detectBrowserPlatform, getInstalledBrowsers } from "@puppeteer/browsers";
import { test as base, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { env, quarkFromEnv, type Quark } from "../support/env.ts";

// Playwright's Firefox can't load add-ons, so these tests drive a stock Firefox
// with Puppeteer over WebDriver BiDi, whose webExtension.install loads the WXT
// build as a temporary add-on. Playwright Test still runs them, against the
// Quark that ../global-setup.ts starts.
const extension = fileURLToPath(new URL("../../.output/firefox-mv3", import.meta.url));
const addonId = "vault@autobutler.org";
// Firefox gives each install a random moz-extension:// host; this pref pins it.
const uuid = "6b0f1e5a-3c7d-4e2b-9a1f-0c8d7e6f5a4b";
export const origin = `moz-extension://${uuid}`;

// FIREFOX_PATH, or the newest Firefox `npm run firefox:install` put in e2e/.firefox.
const firefoxPath = async (): Promise<string> => {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;
  const cacheDir = fileURLToPath(new URL("../.firefox/", import.meta.url));
  const installed = (await getInstalledBrowsers({ cacheDir })).filter(
    (found) => found.browser === Installed.FIREFOX && found.platform === detectBrowserPlatform(),
  );
  const newest = installed.sort((a, b) => a.buildId.localeCompare(b.buildId, undefined, { numeric: true })).at(-1);
  if (newest === undefined) throw new Error("No Firefox: run `npm run firefox:install` or set FIREFOX_PATH");
  return newest.executablePath;
};

type Fixtures = {
  firefox: Browser;
  quark: Quark;
  site: string;
  // The toolbar popup, opened as a tab at the popup's own size.
  popup: Page;
};

export const test = base.extend<Fixtures>({
  // A fresh profile per test with the build installed.
  firefox: async ({}, use) => {
    const firefox = await puppeteer.launch({
      browser: "firefox",
      executablePath: await firefoxPath(),
      headless: process.env.HEADED ? false : true,
      // BiDi refuses to navigate to moz-extension:// pages without it.
      args: ["--remote-allow-system-access"],
      extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({ [addonId]: uuid }) },
    });
    try {
      expect(await firefox.installExtension(extension)).toBe(addonId);
      await use(firefox);
    } finally {
      await firefox.close();
    }
  },
  quark: async ({}, use) => {
    await use(quarkFromEnv());
  },
  site: async ({}, use) => {
    await use(env("E2E_SITE"));
  },
  popup: async ({ firefox }, use) => {
    const popup = await firefox.newPage();
    await popup.setViewport({ width: 360, height: 580 });
    const errors: string[] = [];
    popup.on("pageerror", (error) => errors.push(error instanceof Error ? error.message : String(error)));
    await openExtensionPage(popup, "popup.html");
    await use(popup);
    expect(errors, "uncaught errors in the popup").toEqual([]);
  },
});

export { expect };

// Puppeteer never sees the load of a page in the extension process, so its
// goto times out even though the page loads. Poll outside Puppeteer's
// WaitTask: Firefox can replace the extension realm while it is evaluating a
// waitForFunction, and BiDi reports a transient protocol error instead of
// letting WaitTask retry in the new realm. A realm torn down mid-evaluate can
// also leave the call unanswered, so each attempt gets its own timeout.
export const openExtensionPage = async (page: Page, path: string) => {
  const url = `${origin}/${path}`;
  const navigation = page.goto(url, { timeout: 5_000 }).catch(() => undefined);
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  let loaded = false;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // page.url() stays at about:blank for extension-process navigation.
      const state = await Promise.race([
        page.evaluate(() => `${location.href}\n${document.readyState}`),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("page.evaluate never settled")), Math.min(1_000, deadline - Date.now()));
        }),
      ]);
      if (state === `${url}\ncomplete`) {
        loaded = true;
        break;
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!loaded) {
    const message = `Extension page did not finish loading: ${url}`;
    throw lastError === undefined ? new Error(message) : new Error(message, { cause: lastError });
  }
  await navigation;
};

// Waits for text anywhere on the page or frame (textContent, before CSS
// text-transform, as Playwright matches it); on a timeout the error shows
// what the page said instead.
export const waitForText = async (page: Page | Frame, text: string | RegExp, timeout = 15_000) => {
  const pattern = typeof text === "string" ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : text;
  try {
    await page.waitForFunction((source, flags) => new RegExp(source, flags).test(document.body?.textContent ?? ""), { timeout }, pattern.source, pattern.flags);
  } catch (error) {
    const shown = await page.evaluate(() => document.body?.textContent ?? "").catch(() => "(unreadable)");
    throw new Error(`${pattern} never showed; the page says:\n${shown}`, { cause: error });
  }
};

// Signs the popup in as the owner and unlocks the vault, from whatever state
// the shared Quark's vault is in.
export const signInAndUnlock = async (popup: Page, quark: Quark) => {
  await waitForText(popup, "Connect to your Quark");
  await popup.type("#server", quark.server);
  await popup.type("#username", quark.seed.owner.username);
  await popup.type("#password", quark.seed.owner.password);
  await popup.click("button[type=submit]");
  await waitForText(popup, /Vault is locked|All entries · \d+/, 30_000);
  if ((await popup.$("#master")) !== null) {
    await popup.type("#master", quark.seed.masterPassword);
    await popup.click("button[type=submit]");
  }
  await waitForText(popup, /All entries · \d+/);
};

// Sends the worker a message from an extension page, as the popup does.
export const send = (page: Page, message: unknown): Promise<unknown> =>
  page.evaluate((body) => chrome.runtime.sendMessage(body), message);

// Each tab's id, URL and toolbar badge, read from an extension page.
export const badges = (page: Page) =>
  page.evaluate(async () =>
    Promise.all(
      (await chrome.tabs.query({})).map(async (tab) => ({ id: tab.id!, url: tab.url ?? "", badge: await chrome.action.getBadgeText({ tabId: tab.id! }) })),
    ),
  );

// Opens a page of the test site and waits for the toolbar badge to count its
// one login: the content script has run and the background has matched it.
export const openLoginPage = async (firefox: Browser, popup: Page, url: string) => {
  const page = await firefox.newPage();
  await page.goto(url);
  let tabId: number | undefined;
  await expect
    .poll(async () => (tabId = (await badges(popup)).find((tab) => tab.badge === "1")?.id), {
      message: "the login tab's badge never showed 1 match",
      timeout: 15_000,
    })
    .not.toBeUndefined();
  return { page, tabId: tabId! };
};

// The frame an iframe element on the page holds.
export const frameOf = (page: Page, selector: string) => page.$(selector).then((element) => element?.contentFrame() ?? null);

// Clicks the Quark button the content script draws at the right end of a field.
export const clickInlineButton = async (page: Page, frame: Page | Frame, selector: string) => {
  const box = await (await frame.$(selector))?.boundingBox();
  if (box === undefined || box === null) throw new Error(`${selector} not visible`);
  await page.mouse.click(box.x + box.width - 17, box.y + box.height / 2);
};

export const value = (frame: Page | Frame, selector: string) =>
  frame.$eval(selector, (input) => (input as HTMLInputElement).value);
