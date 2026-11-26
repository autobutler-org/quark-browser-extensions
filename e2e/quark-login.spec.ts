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

const expectBadge = (worker: Worker) =>
  expect
    .poll(async () => {
      const badges = await worker.evaluate(async () =>
        Promise.all((await chrome.tabs.query({})).map(async (tab) => chrome.action.getBadgeText({ tabId: tab.id! }))),
      );
      return badges.includes("1");
    }, { message: "the login tab's badge never showed the match" })
    .toBe(true);

type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

const middle = (box: Box) => [box.x + box.width / 2, box.y + box.height / 2] as const;

// Opens the inline picker on the field Flutter paints in `box` and picks its first login. The button makes way for
// Flutter's own Show password toggle at the field's end, so it is found on the field: the extension's own host is
// a <div> on <body>, beside Flutter's <flutter-view>.
const pickInline = async (page: Page, box: Box) => {
  const find = () =>
    page.evaluate(({ x, y, width, height }) => {
      for (let at = x + width; at > x; at -= 2) {
        const hit = document.elementFromPoint(at, y + height / 2);
        if (hit?.parentElement === document.body && hit.localName === "div") return at;
      }
      return null;
    }, box);
  await expect.poll(find, { message: "the inline button on the field" }).not.toBeNull();
  await page.mouse.click((await find())! - 8, box.y + box.height / 2);
  await page.keyboard.press("Enter");
};

const tabIds = (worker: Worker) => worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id!));

// Turns on Flutter's semantics tree through its own "Enable accessibility" button, as a screen reader user does.
// Quark no longer turns it on at startup (autobutler-org/quark#3769). Returns false when the tree was on already,
// as on an older Quark, which shows no such button.
const enableSemantics = async (page: Page): Promise<boolean> => {
  const enable = page.getByRole("button", { name: "Enable accessibility" });
  const agree = page.getByRole("button", { name: "I Agree" });
  const username = page.getByRole("textbox", { name: "Username" });
  await expect(enable.or(agree).or(username)).toBeVisible({ timeout: 30_000 });
  if (!(await enable.isVisible())) {
    return false;
  }
  // The button is a 1px element off the page's edge, out of reach of a real click.
  await enable.dispatchEvent("click");
  return true;
};

// Opens Quark's /login, past the terms screen a fresh browser gets first, until Flutter has drawn both fields.
// The fields are <input>s only in the semantics tree, so the page opts in to it.
const openLogin = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(loginUrl());
  await enableSemantics(page);
  const agree = page.getByRole("button", { name: "I Agree" });
  const username = page.getByRole("textbox", { name: "Username" });
  await expect(agree.or(username)).toBeVisible();
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
    await expectBadge(worker);

    await pickInline(page, (await password.boundingBox())!);
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

// Quark's /login as most people get it (#192): no screen reader, so no semantics tree and not one <input> on the
// page until a field is clicked. Flutter's engine then builds its autofill <form> for the sign-in fields: the
// clicked field's <input> over it, the other 0×0 beside it. The terms screen is passed with the tree on, which
// also says where Flutter draws each control; the reload drops the tree and keeps the accepted terms.
const openPlainLogin = async (context: BrowserContext) => {
  const page = await openLogin(context);
  const boxes = {
    username: (await page.getByRole("textbox", { name: "Username" }).boundingBox())!,
    password: (await page.getByLabel("Password").boundingBox())!,
    signIn: (await page.getByRole("button", { name: "Sign in" }).boundingBox())!,
  };
  await page.reload();
  await expect(page.locator("#quark-splash")).toHaveCount(0, { timeout: 30_000 });
  test.skip((await page.locator("flt-semantics-placeholder").count()) === 0, "this Quark turns Flutter's semantics tree on at startup");
  await expect(page.locator("input")).toHaveCount(0);
  return { page, boxes };
};

// What the engine autofill form's fields hold in the page; what Flutter holds is another matter.
const engineValues = (page: Page) => page.evaluate(() => [...document.querySelectorAll("flt-text-editing-host input")].map((input) => (input as HTMLInputElement).value));

// Presses Sign in where Flutter draws it and returns what the app sent: the sign-in carries only what Flutter
// itself holds, the username as typed and an auth key derived from the password.
const signIn = async (page: Page, box: Box) => {
  const sent = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/v0/auth/login"));
  await page.mouse.click(...middle(box));
  const request = await sent;
  return { username: (request.postDataJSON() as { username: string }).username, status: (await request.response())?.status() };
};

for (const field of ["username", "password"] as const) {
  test(`signs in to Quark from the inline picker on its ${field} field without Flutter's semantics tree (#192)`, async ({
    context,
    popup,
    quark,
    worker,
  }) => {
    const vault = await ownerVault(quark);
    const created = await vault.add({ kind: "entry", name: "This Quark", url: loginUrl(), username: quark.seed.owner.username, password: quark.seed.owner.password });
    try {
      await relock(popup, quark);
      const { page, boxes } = await openPlainLogin(context);
      await page.mouse.click(...middle(boxes[field]));
      await expectBadge(worker);
      await pickInline(page, boxes[field]);
      await expect.poll(() => engineValues(page)).toContain(quark.seed.owner.username);

      expect(await signIn(page, boxes.signIn)).toEqual({ username: quark.seed.owner.username, status: 200 });
    } finally {
      await relock(popup, quark);
      await vault.remove(created);
    }
  });
}

// The popup's fill takes the page's focus away from Flutter, which puts its autofill form away until a field has
// focus again.
test("fills Quark's login from the popup without Flutter's semantics tree (#192)", async ({ context, extensionId, worker }) => {
  let signInBox: Box | undefined;
  const { page, popup } = await popupOver(context, worker, extensionId, async () => {
    const { page: login, boxes } = await openPlainLogin(context);
    signInBox = boxes.signIn;
    await login.mouse.click(...middle(boxes.username));
    await expect(login.locator("flt-text-editing-host input")).not.toHaveCount(0);
    return login;
  });
  const pageHost = new URL(page.url()).host;
  await popup.locator(".match").getByRole("button", { name: "Fill anyway Local Test" }).click();
  await popup.getByRole("button", { name: `Fill on ${pageHost}` }).click();
  await expect.poll(() => popup.evaluate(() => !!(window as { closedByPopup?: boolean }).closedByPopup), { message: "the popup closes once it has filled" }).toBe(true);

  // Local Test isn't this Quark's account, so the sign-in is refused, but it carries the username the fill gave.
  expect(await signIn(page, signInBox!)).toEqual({ username: "alice", status: 401 });
});
