import type { Page } from "@playwright/test";
import { clickInlineButton, expect, openLoginPage, signInAndUnlock, test } from "../fixtures.ts";
import { html, inlineButton, loginForm, otherOrigin, seededLogin, serve, settle } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

type Heard = { type: string; target: string; value: string; trusted: boolean };

// A sign-in form beside another field, with page script listening on window, in the capture phase, to
// every event a fill could fire, and noting what each one's target held.
const listenerPage = html(
  `<h1>Sign in</h1>${loginForm()}
<p><label>Comment <input id="spy" name="spy" type="text" style="width:320px;height:32px"></label></p>`,
  `<script>
window.heard = [];
for (const type of ["beforeinput", "input", "change", "keydown", "keypress", "keyup", "focus", "blur", "focusin", "focusout", "paste", "select", "invalid", "message"]) {
  addEventListener(type, (event) => {
    const target = event.target;
    window.heard.push({
      type,
      target: target?.id ?? String(target),
      value: typeof target?.value === "string" ? target.value : typeof event.data === "string" ? event.data : "",
      trusted: event.isTrusted,
    });
  }, true);
}
</script>`,
);

const heard = (page: Page) => page.evaluate(() => (window as unknown as { heard: Heard[] }).heard);

test("listeners on the login's own site hear only its two fields being filled, and only after the user picks", async ({ context, quark, site, worker }) => {
  const login = await seededLogin(quark);
  const url = `${site}/hostile/listen`;
  await serve(context, url, listenerPage);
  const { page } = await openLoginPage(context, worker, url);
  await inlineButton(page);
  await settle(page);
  expect((await heard(page)).filter((event) => event.value !== ""), "events with a value before the user picks").toEqual([]);

  await clickInlineButton(page, await page.locator("#pw").boundingBox());
  await page.keyboard.press("Enter");
  await expect(page.locator("#pw")).toHaveValue(login.password);

  const withValues = (await heard(page)).filter((event) => event.value !== "");
  expect(new Set(withValues.map((event) => `${event.target}=${event.value}`))).toEqual(
    new Set([`user=${login.username}`, `pw=${login.password}`]),
  );
  expect(withValues.filter((event) => event.target === "spy"), "the field the fill doesn't touch").toEqual([]);
  // The fill's input and change events are the extension's, not a key press the page could mistake.
  expect(withValues.filter((event) => ["input", "change"].includes(event.type)).every((event) => !event.trusted)).toBe(true);
  expect(withValues.some((event) => event.type.startsWith("key")), "keystrokes carrying the password").toBe(false);
});

test("listeners on another origin hear nothing of a fill", async ({ context, popup, quark, worker, site }) => {
  const login = await seededLogin(quark);
  const url = `${otherOrigin(site)}/hostile/listen`;
  await serve(context, url, listenerPage);
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await popup.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((tab) => tab.id!)));
  await expect.poll(() => worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "whereAmI" }, { frameId: 0 }).catch(() => null), tabId), {
    message: "the content script is running in the page",
  }).toBe(url);

  const fill: unknown = await popup.evaluate(
    ([id, entryId]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId }),
    [tabId, quark.seed.local],
  );
  expect(fill).toMatchObject({ ok: false, error: { kind: "refused" } });
  await settle(page);
  const everything = JSON.stringify(await heard(page));
  expect(everything).not.toContain(login.password);
  expect(everything).not.toContain(login.username);
  await expect(page.locator("#pw")).toHaveValue("");
});
