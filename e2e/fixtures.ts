import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { env, quarkFromEnv, type Quark } from "./support/env.ts";

const extension = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url));

export type { Quark };

type Fixtures = {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  quark: Quark;
  site: string;
  // The toolbar popup, opened as a tab at the popup's own size.
  popup: Page;
};

export const test = base.extend<Fixtures>({
  // A fresh profile per test with the WXT build loaded. Extensions need a
  // persistent context; the chromium channel runs them headless too.
  context: async ({}, use) => {
    const executablePath = process.env.CHROME_PATH;
    const context = await chromium.launchPersistentContext("", {
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker")));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  quark: async ({}, use) => {
    await use(quarkFromEnv());
  },
  site: async ({}, use) => {
    await use(env("E2E_SITE"));
  },
  popup: async ({ context, extensionId }, use) => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 580 });
    const errors: string[] = [];
    popup.on("pageerror", (error) => errors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await use(popup);
    expect(errors, "uncaught errors in the popup").toEqual([]);
  },
});

export { expect };

// Fills in and submits the popup's connect screen.
export const connect = async (popup: Page, quark: Quark, account: Readonly<{ username: string; password: string }>) => {
  await expect(popup.getByRole("heading", { name: "Connect to your Quark" })).toBeVisible();
  await popup.fill("#server", quark.server);
  await popup.fill("#username", account.username);
  await popup.fill("#password", account.password);
  await popup.click("button[type=submit]");
};

// Signs the popup in as the owner, which opens the vault with the same
// password; unlocks it from the lock screen if it didn't.
export const signInAndUnlock = async (popup: Page, quark: Quark) => {
  await connect(popup, quark, quark.seed.owner);
  const locked = popup.getByRole("heading", { name: "Vault is locked" });
  const entries = popup.getByText(/^All entries · \d+$/);
  await expect(locked.or(entries)).toBeVisible({ timeout: 30_000 });
  if (await locked.isVisible()) {
    await popup.fill("#unlock-password", quark.seed.owner.password);
    await popup.click("button[type=submit]");
  }
  await expect(entries).toBeVisible();
};

// The token the extension holds, from either storage area.
export const storedConnection = (worker: Worker) =>
  worker.evaluate(async () => ({
    session: (await chrome.storage.session.get("connection")).connection as { server: string; token: string } | undefined,
    local: (await chrome.storage.local.get("connection")).connection as { server: string; token: string } | undefined,
  }));

// Opens the test site's sign-in page and waits for the toolbar badge to count
// its one login: the content script has run and the worker has matched it.
export const openLoginPage = async (context: BrowserContext, worker: Worker, url: string) => {
  const page = await context.newPage();
  await page.goto(url);
  let tabId: number | undefined;
  await expect
    .poll(async () => {
      const badges = await worker.evaluate(async () =>
        Promise.all((await chrome.tabs.query({})).map(async (tab) => [tab.id!, await chrome.action.getBadgeText({ tabId: tab.id! })] as const)),
      );
      tabId = badges.find(([, text]) => text === "1")?.[0];
      return tabId;
    }, { message: "the login tab's badge never showed 1 match", timeout: 15_000 })
    .not.toBeUndefined();
  return { page, tabId: tabId! };
};

// Clicks the Quark button the content script draws at the right end of a field.
export const clickInlineButton = async (page: Page, box: { x: number; y: number; width: number; height: number } | null) => {
  if (box === null) throw new Error("field not visible");
  await page.mouse.click(box.x + box.width - 17, box.y + box.height / 2);
};
