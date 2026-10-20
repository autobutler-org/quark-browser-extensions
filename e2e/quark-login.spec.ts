import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect, signInAndUnlock, test, type Quark } from "./fixtures.ts";
import { env, ownerVault } from "./support/env.ts";

// Quark's own web login, /login, as its Flutter web app draws it (#159). Flutter paints the fields into a canvas
// and takes the typing in transparent <input>s laid over them; the extension has to see those as the fields they
// are. This needs a Quark with the web app embedded: QUARK_WEB=1 scripts/build-quark.sh. On the mock, or on a
// backend-only build, there is no /login to fill, and the tests skip.

// The Quark's /login on localhost: the seeded "Local Test" is saved for localhost at the test site's port, so
// here it is a Different port match, as in the issue.
const loginUrl = () => `http://localhost:${new URL(env("E2E_QUARK_DIRECT")).port}/login`;

test.beforeEach(async ({ popup, quark }) => {
  test.skip(quark.target === "mock", "the mock Quark has no web app");
  const page = await fetch(loginUrl()).then((response) => response.text());
  test.skip(!page.includes("flutter_bootstrap.js"), "this Quark has no web app embedded: build it with QUARK_WEB=1 scripts/build-quark.sh");
  await signInAndUnlock(popup, quark);
});

// The worker caches the entry list, so the vault is locked and unlocked again to see an entry a test adds.
const relock = async (popup: Page, quark: Quark) => {
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
  expect(await popup.evaluate((password) => chrome.runtime.sendMessage({ type: "unlock", password }), quark.seed.owner.password)).toMatchObject({
    ok: true,
  });
};

const tabIds = (worker: Worker) => worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id!));

// Opens Quark's /login, past the terms screen a fresh browser gets first, until Flutter has drawn both fields.
const openLogin = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(loginUrl());
  const agree = page.getByRole("button", { name: "I Agree" });
  const username = page.getByRole("textbox", { name: "Username" });
  await expect(agree.or(username)).toBeVisible({ timeout: 30_000 });
  if (await agree.isVisible()) {
    await agree.click();
    await page.waitForURL(/\/login$/);
  }
  await expect(username).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  return page;
};

// The popup as it would open over `page`. A test can't click the toolbar button, which grants activeTab, so the
// popup and the worker are told the tab's URL the click would let them read.
const popupOver = async (context: BrowserContext, worker: Worker, extensionId: string, open: () => Promise<Page>) => {
  const before = await tabIds(worker);
  const page = await open();
  const tabId = (await tabIds(worker)).find((id) => !before.includes(id))!;
  const url = page.url();
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

// The issue's own steps: Local Test, saved for another port, offered on Quark's login; the user confirms, and
// both fields fill. Before the fix nothing filled, and the popup said it couldn't find login fields.
test("fills Quark's Flutter login after the Fill anyway confirmation (#159, #157)", async ({ context, extensionId, worker }) => {
  const { page, popup } = await popupOver(context, worker, extensionId, () => openLogin(context));
  const pageHost = new URL(page.url()).host;
  await expect(popup.getByText("Different port")).toBeVisible();
  await popup.locator(".match").getByRole("button", { name: "Fill anyway Local Test" }).click();
  await popup.getByRole("button", { name: `Fill on ${pageHost}` }).click();

  await expect(page.getByRole("textbox", { name: "Username" })).toHaveValue("alice");
  await expect(page.getByLabel("Password")).toHaveValue("s3cret");
  // Flutter writes its own text back into a field it focuses: still there, the fill reached Flutter, not just the DOM.
  await page.getByRole("textbox", { name: "Username" }).click();
  await page.waitForTimeout(500);
  await expect(page.getByRole("textbox", { name: "Username" })).toHaveValue("alice");
  expect(await popup.evaluate(() => !!(window as { closedByPopup?: boolean }).closedByPopup), "the popup closes once it has filled").toBe(true);
});

// A login saved for the Quark itself: the inline button is on its fields, and what it fills reaches Flutter, so
// Sign in signs the user in.
test("signs in to Quark from the inline picker on its own login (#159)", async ({ context, popup, quark, worker }) => {
  const vault = await ownerVault(quark);
  const created = await vault.add({ kind: "entry", name: "This Quark", url: loginUrl(), username: quark.seed.owner.username, password: quark.seed.owner.password });
  try {
    await relock(popup, quark);
    const page = await openLogin(context);
    const password = page.getByLabel("Password");
    await expect
      .poll(async () => {
        const badges = await worker.evaluate(async () =>
          Promise.all((await chrome.tabs.query({})).map(async (tab) => chrome.action.getBadgeText({ tabId: tab.id! }))),
        );
        return badges.includes("1");
      }, { message: "the login tab's badge never showed the match" })
      .toBe(true);

    // The button makes way for Flutter's own Show password toggle at the field's end, so find it on the field.
    const box = (await password.boundingBox())!;
    const button = await page.evaluate(({ x, y, width, height }) => {
      for (let at = x + width; at > x; at -= 2) {
        if (document.elementFromPoint(at, y + height / 2)?.parentElement === document.body) return at;
      }
      return null;
    }, box);
    expect(button, "the inline button on the password field").not.toBeNull();
    await page.mouse.click(button! - 8, box.y + box.height / 2);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "Username" })).toHaveValue(quark.seed.owner.username);
    await expect(password).toHaveValue(quark.seed.owner.password);

    await page.getByRole("button", { name: "Sign in" }).click();
    // Signed in: the form gives way to the app, or first to the one-time recovery phrase screen, still at /login.
    await expect(page.getByRole("textbox", { name: "Username" })).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Sign in" })).toBeHidden();
  } finally {
    await relock(popup, quark);
    await vault.remove(created);
  }
});
