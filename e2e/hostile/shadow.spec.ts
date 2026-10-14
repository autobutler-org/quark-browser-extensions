import { expect, openLoginPage, signInAndUnlock, test } from "../fixtures.ts";
import { html, loginForm, lootScript, seededLogin, serve } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// A username and password pair in the light DOM, slotted into a shadow tree whose wrapper clips the slot away
// (#139). The fields' own boxes stay full and checkVisibility() passes; only the slot's wrapper hides them.
// Declarative shadow roots, so the page needs no script to build them.
const wrappers = {
  "0×0 overflow:hidden": "overflow:hidden;width:0;height:0",
  "clip-path:polygon(0 0,0 0,0 0)": "clip-path:polygon(0 0,0 0,0 0)",
  "opacity:0": "opacity:0",
} as const;

const slottedPage = (mode: "open" | "closed", style: string) =>
  html(
    `<login-box><template shadowrootmode="${mode}"><div style="${style}"><slot></slot></div></template><input id="bait-user" type="text" autocomplete="username"><input id="bait-pw" type="password"></login-box>
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

for (const mode of ["open", "closed"] as const) {
  for (const [kind, style] of Object.entries(wrappers)) {
    test(`a decoy pair slotted into a ${mode} shadow tree under a ${kind} wrapper doesn't catch the popup's Fill`, async ({ context, popup, quark, site, worker }) => {
      const login = await seededLogin(quark);
      const url = `${site}/hostile/slotted`;
      await serve(context, url, slottedPage(mode, style));
      const { page, tabId } = await openLoginPage(context, worker, url);
      const fill: unknown = await popup.evaluate(
        ([id, entryId]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId }),
        [tabId, quark.seed.local],
      );
      expect(fill).toMatchObject({ ok: true });
      expect(await values(page)).toEqual({ "bait-user": "", "bait-pw": "", user: login.username, pw: login.password });
      expect(await page.evaluate(() => (window as unknown as { loot: string[] }).loot)).toEqual([]);
    });
  }

  // A real sign-in card component: the page's own fields slotted into its body.
  test(`a login slotted into a ${mode} shadow tree still fills from the popup`, async ({ context, popup, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const url = `${site}/hostile/slotted-card`;
    await serve(
      context,
      url,
      html(`<sign-in-card><template shadowrootmode="${mode}"><h1>Sign in</h1><div style="padding:16px;border:1px solid"><slot></slot></div></template>${loginForm()}</sign-in-card>`),
    );
    const { page, tabId } = await openLoginPage(context, worker, url);
    const fill: unknown = await popup.evaluate(
      ([id, entryId]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId }),
      [tabId, quark.seed.local],
    );
    expect(fill).toMatchObject({ ok: true });
    await expect(page.locator("#pw")).toHaveValue(login.password);
    await expect(page.locator("#user")).toHaveValue(login.username);
  });
}
