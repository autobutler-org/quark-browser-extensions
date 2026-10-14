import { clickInlineButton, expect, openLoginPage, signInAndUnlock, test } from "../fixtures.ts";
import { html, inlineButton, loginForm, lootScript, seededLogin, serve, settle } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// Password fields a page hides without display or visibility, ahead of the real form, to bait a
// fill the user can't see. Each sits in its own form with a username field beside it.
const decoys = {
  "off-screen": "position:absolute;left:-10000px;top:0",
  "opacity:0": "opacity:0",
  "1px": "width:1px;height:1px;padding:0;border:0",
} as const;

const decoyPage = (style: string) =>
  html(
    `<form id="bait" action="/bait"><input id="bait-user" type="text" autocomplete="username" style="${style}"><input id="bait-pw" type="password" style="${style}"></form>
<h1>Sign in</h1>
${loginForm()}
<script>
for (const id of ["bait-user", "bait-pw"]) document.getElementById(id).addEventListener("input", (e) => steal(e.target.value));
</script>`,
    lootScript,
  );

const values = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    Object.fromEntries(["bait-user", "bait-pw", "user", "pw"].map((id) => [id, (document.getElementById(id) as HTMLInputElement).value])),
  );

for (const [kind, style] of Object.entries(decoys)) {
  test.describe(`a decoy password field, ${kind}`, () => {
    test("isn't filled on load", async ({ context, site, worker }) => {
      const url = `${site}/hostile/decoy`;
      await serve(context, url, decoyPage(style));
      const { page } = await openLoginPage(context, worker, url);
      await settle(page);
      expect(await values(page)).toEqual({ "bait-user": "", "bait-pw": "", user: "", pw: "" });
      expect(await page.evaluate(() => (window as unknown as { loot: string[] }).loot)).toEqual([]);
    });

    test("doesn't catch a fill from the inline picker on the real field", async ({ context, quark, site, worker }) => {
      const login = await seededLogin(quark);
      const url = `${site}/hostile/decoy`;
      await serve(context, url, decoyPage(style));
      const { page } = await openLoginPage(context, worker, url);
      await inlineButton(page);
      await clickInlineButton(page, await page.locator("#pw").boundingBox());
      await page.keyboard.press("Enter");
      await expect(page.locator("#pw")).toHaveValue(login.password);
      expect(await values(page)).toEqual({ "bait-user": "", "bait-pw": "", user: login.username, pw: login.password });
    });

    // The popup's Fill and the keyboard shortcut have no target field: they fill the page's first
    // password field, and the decoy comes first. Fails until #129 is fixed.
    test.fail("doesn't catch a fill from the popup or the shortcut", { annotation: { type: "issue", description: "https://github.com/autobutler-org/quark-browser-extensions/issues/129" } }, async ({ context, popup, quark, site, worker }) => {
      const login = await seededLogin(quark);
      const url = `${site}/hostile/decoy`;
      await serve(context, url, decoyPage(style));
      const { page, tabId } = await openLoginPage(context, worker, url);
      const fill: unknown = await popup.evaluate(
        ([id, entryId]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId }),
        [tabId, quark.seed.local],
      );
      expect(fill).toMatchObject({ ok: true });
      expect(await values(page)).toEqual({ "bait-user": "", "bait-pw": "", user: login.username, pw: login.password });
    });
  });
}
