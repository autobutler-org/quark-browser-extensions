import { clickInlineButton, expect, openLoginPage, signInAndUnlock, test } from "./fixtures.ts";
import { html, inlineButton, seededLogin, serve } from "./hostile/pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// Forms a page shows or changes after load, which the content script must scan again.

// A sign-in modal that fades in (#150): display:none, then an opacity transition from 0 to 1 over 0.4s.
const fadeModalPage = html(`<style>
  .modal { display: none; opacity: 0; transition: opacity 0.4s; }
  .modal.open { display: block; }
  .modal.open.shown { opacity: 1; }
</style>
<button id="open" type="button">Sign in</button>
<div id="modal" class="modal" role="dialog">
  <form style="width:320px;display:flex;flex-direction:column;gap:8px">
    <input id="user" type="text" autocomplete="username" style="height:32px">
    <input id="pw" type="password" autocomplete="current-password" style="height:32px">
    <button type="submit">Sign in</button>
  </form>
</div>
<script>
document.getElementById("open").addEventListener("click", () => {
  const modal = document.getElementById("modal");
  modal.classList.add("open");
  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add("shown")));
});
</script>`);

// Sign in and Sign up tabs toggled with the hidden attribute (#152). The sign-up password is unmarked.
const tabsPage = html(`<button id="signup-tab" type="button">Sign up</button>
<form id="signin" style="width:320px;display:flex;flex-direction:column;gap:8px">
  <input id="user" type="text" autocomplete="username" style="height:32px">
  <input id="pw" type="password" autocomplete="current-password" style="height:32px">
  <button type="submit">Sign in</button>
</form>
<form id="signup" hidden style="width:320px;flex-direction:column;gap:8px">
  <input id="email" type="email" name="email" style="height:32px">
  <input id="new-pw" type="password" name="password" style="height:32px">
  <input id="confirm" type="password" name="password_confirm" style="height:32px">
  <button type="submit">Create account</button>
</form>
<script>
document.getElementById("signup-tab").addEventListener("click", () => {
  document.getElementById("signin").hidden = true;
  document.getElementById("signup").hidden = false;
});
</script>`);

test("a login modal that fades in gets the inline button, and its picker fills both fields", async ({ context, quark, site }) => {
  const login = await seededLogin(quark);
  const url = `${site}/dynamic/fade-modal`;
  await serve(context, url, fadeModalPage);
  const page = await context.newPage();
  await page.goto(url);
  await page.click("#open");
  await page.waitForFunction(() => getComputedStyle(document.getElementById("modal")!).opacity === "1");
  await inlineButton(page);
  await clickInlineButton(page, await page.locator("#pw").boundingBox());
  await page.keyboard.press("Enter");
  await expect(page.locator("#pw")).toHaveValue(login.password);
  await expect(page.locator("#user")).toHaveValue(login.username);
});

test("a sign-up tab revealed after load gets Suggest strong password, not the logins", async ({ context, site, worker }) => {
  const url = `${site}/dynamic/tabs`;
  await serve(context, url, tabsPage);
  const { page } = await openLoginPage(context, worker, url);
  await inlineButton(page);
  await page.click("#signup-tab");
  const box = await page.locator("#new-pw").boundingBox();
  // The sign-up field's own button: wait for a host drawn at its right end.
  await expect
    .poll(() =>
      page.evaluate(
        ([x, y]) => [...document.body.children].some((child) => child.localName === "div" && child.id === "" && child.contains(document.elementFromPoint(x, y))),
        [box!.x + box!.width - 17, box!.y + box!.height / 2] as const,
      ),
    )
    .toBe(true);
  await clickInlineButton(page, box);
  // The first item is Suggest strong password: it fills the new password and its confirmation alike.
  await page.keyboard.press("Enter");
  await expect(page.locator("#new-pw")).not.toHaveValue("");
  expect(await page.locator("#confirm").inputValue()).toBe(await page.locator("#new-pw").inputValue());
  await expect(page.locator("#pw")).toHaveValue("");
});
