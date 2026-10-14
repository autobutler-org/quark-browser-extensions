import { clickInlineButton, expect, openLoginPage, signInAndUnlock, test } from "./fixtures.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

test("fills the matching login from the popup, and only that site's", async ({ context, popup, quark, site, worker }) => {
  const { page, tabId } = await openLoginPage(context, worker, site);
  expect(await page.evaluate(() => document.body.lastElementChild?.tagName), "the inline button's host").toBe("DIV");

  const badges = await worker.evaluate(async () =>
    Promise.all((await chrome.tabs.query({})).map(async (tab) => chrome.action.getBadgeText({ tabId: tab.id! }))),
  );
  expect(badges.filter((text) => text !== ""), "only the login tab has a badge").toEqual(["1"]);
  const urls = await worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.url ?? ""));
  expect(
    urls.every((url) => url === "" || url.startsWith("chrome-extension://") || url === "about:blank"),
    "no tabs permission: the worker can't read other tabs' URLs",
  ).toBe(true);

  const fill = await popup.evaluate(([id, entryId]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId }), [tabId, quark.seed.local]);
  expect(fill).toMatchObject({ ok: true });
  const filled = await page.evaluate(() => ({
    user: (document.getElementById("user") as HTMLInputElement).value,
    pw: (document.getElementById("pw") as HTMLInputElement).value,
    events: (window as any).events as string[],
    submitted: !!(window as any).submitted,
  }));
  expect(filled).toMatchObject({ user: "alice", pw: "s3cret", submitted: false });
  expect(filled.events).toEqual(expect.arrayContaining(["user=alice", "pw=s3cret"]));

  const wrongSite = await popup.evaluate(([id, entryId]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId }), [tabId, quark.seed.github]);
  expect(wrongSite).toMatchObject({ ok: false, error: { kind: "refused" } });

  expect(
    await page.evaluate(() => typeof (window as any).chrome === "undefined" || typeof (window as any).chrome.runtime?.sendMessage !== "function"),
    "page scripts can't message the extension",
  ).toBe(true);
});

test("fills from the inline picker and the fill shortcut", async ({ context, site, worker }) => {
  const { page, tabId } = await openLoginPage(context, worker, site);
  await clickInlineButton(page, await page.locator("#pw").boundingBox());
  await page.keyboard.press("Enter");
  await expect(page.locator("#user")).toHaveValue("alice");
  await expect(page.locator("#pw")).toHaveValue("s3cret");

  const opened = await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "openPicker" }, { frameId: 0 }), tabId);
  expect(opened).toMatchObject({ ok: true });
  await page.keyboard.press("Escape");
  const command = await worker.evaluate(async () => (await chrome.commands.getAll()).find((c) => c.name === "fill-login"));
  // The browser binds Ctrl+Shift+L, or leaves it for the user when it's taken.
  expect(["Ctrl+Shift+L", ""]).toContain(command?.shortcut);
});

test("fills a login in a same-site frame and refuses a cross-site one", async ({ context, site }) => {
  const pick = async (url: string) => {
    const page = await context.newPage();
    await page.goto(url);
    const frame = page.frameLocator("#login");
    await expect.poll(() => frame.locator("body > div").count(), { message: "the inline button in the frame" }).toBeGreaterThan(0);
    await clickInlineButton(page, await frame.locator("#pw").boundingBox());
    await page.keyboard.press("Enter");
    return { page, frame };
  };

  const same = await pick(`${site}/framed`);
  await expect(same.frame.locator("#user")).toHaveValue("alice");
  await expect(same.frame.locator("#pw")).toHaveValue("s3cret");

  const cross = await pick(`${site.replace("localhost", "127.0.0.1")}/cross`);
  // Give a fill that shouldn't happen the time one would take.
  await cross.page.waitForTimeout(1000);
  await expect(cross.frame.locator("#user")).toHaveValue("");
  await expect(cross.frame.locator("#pw")).toHaveValue("");
});

test("suggests a strong password for a sign-up form, sized to its maxlength", async ({ context, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/signup`);
  await expect.poll(() => page.locator("body > div").count(), { message: "the inline button" }).toBeGreaterThan(0);
  await clickInlineButton(page, await page.locator("#new1").boundingBox());
  await page.keyboard.press("Enter");
  await expect(page.locator("#new1")).toHaveValue(/^.{16}$/);
  expect(await page.locator("#new2").inputValue()).toBe(await page.locator("#new1").inputValue());
});

test("fills a one-time code, the same one the popup gets", async ({ context, popup, quark, site }) => {
  const page = await context.newPage();
  await page.goto(`${site}/2fa`);
  await expect.poll(() => page.locator("body > div").count(), { message: "the inline button" }).toBeGreaterThan(0);
  await clickInlineButton(page, await page.locator("#otp").boundingBox());
  await page.keyboard.press("Enter");
  await expect(page.locator("#otp")).toHaveValue(/^\d{6}$/);
  const filled = await page.locator("#otp").inputValue();

  const code = await popup.evaluate((entryId) => chrome.runtime.sendMessage({ type: "otp", entryId }), quark.seed.local);
  expect(code.ok).toBe(true);
  expect(code.value.code).toMatch(/^\d{6}$/);
  // The same code, unless the 30-second window rolled over in between.
  expect(code.value.code === filled || code.value.secondsLeft >= 27).toBe(true);

  const noSecret = await popup.evaluate((entryId) => chrome.runtime.sendMessage({ type: "otp", entryId }), quark.seed.github);
  expect(noSecret).toMatchObject({ ok: false, error: { kind: "refused" } });
});

test("a locked vault refuses to fill, and the options page loads", async ({ context, extensionId, popup, quark, site, worker }) => {
  const { tabId } = await openLoginPage(context, worker, site);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
  const status = await quark.api.call(
    "GET",
    "/vault/status",
    undefined,
    await quark.api.login(quark.seed.owner.username, quark.seed.owner.password),
  );
  expect(status.body.locked, "the lock reached the Quark").toBe(true);
  const fill = await popup.evaluate(([id, entryId]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId }), [tabId, quark.seed.local]);
  expect(fill).toMatchObject({ ok: false, error: { kind: "locked" } });

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole("heading", { name: "Other password managers" })).toBeVisible();
});
