import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect, signInAndUnlock, test } from "./fixtures.ts";
import { startSite } from "./support/site.ts";

const tabIds = (worker: Worker) => worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id!));

// Opens `url` and, beside it, the popup as it would be opened over that tab. A test can't click the toolbar
// button, which grants activeTab, so the popup and the worker are told the tab's URL the click would let them read.
const popupOver = async (context: BrowserContext, worker: Worker, extensionId: string, url: string) => {
  const before = await tabIds(worker);
  const page = await context.newPage();
  await page.goto(url);
  const tabId = (await tabIds(worker)).find((id) => !before.includes(id))!;
  await worker.evaluate(
    ([id, tabUrl]) => {
      const get = chrome.tabs.get.bind(chrome.tabs);
      chrome.tabs.get = async (wanted: number) => (wanted === id ? { ...(await get(wanted)), url: tabUrl } : get(wanted));
    },
    [tabId, url] as const,
  );
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 580 });
  await popup.addInitScript(
    ([id, tabUrl]) => {
      chrome.tabs.query = (() => Promise.resolve([{ id, url: tabUrl, active: true }])) as unknown as typeof chrome.tabs.query;
      window.close = () => void ((window as { closedByPopup?: boolean }).closedByPopup = true);
    },
    [tabId, url] as const,
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return { page, popup };
};

const closed = (popup: Page) => popup.evaluate(() => !!(window as { closedByPopup?: boolean }).closedByPopup);

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// "Local Test" is saved for the test site's port. On the same form at another port, the popup lists it under
// OTHER PORT OR SCHEME. Its Fill asks first, naming both origins, then fills; it never closes with nothing filled (#120).
test("fills a Different port entry from the popup after a warning (#120)", async ({ context, extensionId, site, worker }) => {
  const other = await startSite();
  try {
    const { page, popup } = await popupOver(context, worker, extensionId, `${other.url}/`);
    const pageHost = new URL(other.url).host;
    await expect(popup.getByText("Different port")).toBeVisible();
    await popup.locator(".match").getByRole("button", { name: "Fill anyway Local Test" }).click();
    const warning = popup.getByRole("alert");
    await expect(warning).toContainText(`Local Test is saved for ${new URL(site).host}`);
    await expect(warning).toContainText(`not ${pageHost}`);
    expect(await page.locator("#user").inputValue(), "nothing fills before the warning is confirmed").toBe("");

    await popup.getByRole("button", { name: `Fill on ${pageHost}` }).click();
    await expect(page.locator("#user")).toHaveValue("alice");
    await expect(page.locator("#pw")).toHaveValue("s3cret");
    expect(await closed(popup), "the popup closes once it has filled").toBe(true);
    expect(await page.evaluate(() => !!(window as { submitted?: boolean }).submitted), "a login saved for another port is never submitted").toBe(false);
  } finally {
    await other.stop();
  }
});

// With no login form on the page, the popup stays open and says so.
test("says why a Different port entry filled nothing (#120)", async ({ context, extensionId, worker }) => {
  const other = await startSite();
  try {
    const { popup } = await popupOver(context, worker, extensionId, `${other.url}/2fa`);
    await popup.locator(".match").getByRole("button", { name: "Fill anyway Local Test" }).click();
    await popup.getByRole("button", { name: `Fill on ${new URL(other.url).host}` }).click();
    await expect(popup.locator(".error-box")).toBeVisible();
    expect(await closed(popup)).toBe(false);
  } finally {
    await other.stop();
  }
});
