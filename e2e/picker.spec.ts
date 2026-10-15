import { expect, openLoginPage, signInAndUnlock, test } from "./fixtures.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// The inline buttons live in hosts at the end of <body>; whether one of them has focus.
const onButton = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active?.localName === "div" && active.id === "" && active.parentElement === document.body;
  });

// Tab skipped the button and no key in the field opened the picker (#116).
test("reaches the inline button with Tab and opens the picker from the keyboard", async ({ context, site, worker }) => {
  const { page } = await openLoginPage(context, worker, site);
  await expect.poll(() => page.locator("body > div").count(), { message: "the inline button" }).toBeGreaterThan(0);

  await page.locator("#user").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#pw")).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await onButton(page), "Tab from the password goes to its button").toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#pw")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();

  // Enter on the button opens the picker, Escape closes it and goes back to the field.
  await page.locator("#pw").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator("#pw")).toBeFocused();
  await expect(page.locator("#pw")).toHaveValue("");

  // Alt+ArrowDown in the field opens it on the first login, and Enter fills it.
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#user")).toHaveValue("alice");
  await expect(page.locator("#pw")).toHaveValue("s3cret");
});

// The button was also a stop in the page's own Tab order at the end of <body>: on a page whose form is last, Tab
// went password, button, link, button, link... and never left the page (#171).
test("lets Tab leave a page whose form is last, past the inline button", async ({ context, site, worker }) => {
  const url = `${site}/last`;
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body style="font-family:sans-serif;padding:40px"><form style="width:320px;display:flex;flex-direction:column;gap:8px">
<input id="user" autocomplete="username" style="height:32px"><input id="pw" type="password" style="height:32px"></form>
<a id="next" href="#forgot">Forgot password?</a></body>`,
    }),
  );
  const { page } = await openLoginPage(context, worker, url);
  await expect.poll(() => page.locator("body > div").count(), { message: "the inline button" }).toBeGreaterThan(0);

  await page.locator("#pw").focus();
  await page.keyboard.press("Tab");
  expect(await onButton(page), "Tab from the password goes to its button").toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.locator("#next")).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await onButton(page), "Tab from the last link doesn't come back to the button").toBe(false);
  await expect(page.locator("#next")).not.toBeFocused();
  await expect(page.locator("#pw")).not.toBeFocused();
});

// Quark's own login page draws a show-password toggle over the right end of the field, and the button sat on it
// (#119).
test("keeps the inline button off the field's own show-password toggle", async ({ context, site, worker }) => {
  const url = `${site}/eye`;
  await context.route(url, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body style="font-family:sans-serif;padding:40px"><form style="width:320px;display:flex;flex-direction:column;gap:8px">
<input id="user" autocomplete="username" style="height:32px">
<div style="position:relative"><input id="pw" type="password" style="width:100%;height:32px;box-sizing:border-box;padding-right:36px">
<button id="eye" type="button" aria-label="Show password" style="position:absolute;right:6px;top:4px;width:24px;height:24px">👁</button></div>
<button type="submit">Sign in</button></form></body>`,
    }),
  );
  const { page } = await openLoginPage(context, worker, url);
  await expect.poll(() => page.locator("body > div").count(), { message: "the inline button" }).toBeGreaterThan(0);
  const eye = (await page.locator("#eye").boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.id, [eye.x + eye.width / 2, eye.y + eye.height / 2]);
  expect(hit, "the toggle is still the thing under its own centre").toBe("eye");
  // The Quark button sits left of the toggle, still inside the field.
  const pw = (await page.locator("#pw").boundingBox())!;
  const left = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.localName, [eye.x - 6 - 11, pw.y + pw.height / 2]);
  expect(left, "the Quark button's host").toBe("div");
});
