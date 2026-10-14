import type { Page } from "@playwright/test";
import { expect, openLoginPage, signInAndUnlock, test } from "../fixtures.ts";
import { html, loginForm, lootScript, seededLogin, serve, settle } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// Markup on the login's page embeds a frame the user can't see, holding an ordinary password form (#141). The
// login matches the frame too: `evil.localhost` is a subdomain of the entry's `localhost`, another origin on the
// same site. The frame's own script would read whatever is filled there.
const hiddenFrames = {
  "opacity:0 and off-screen": "opacity:0;position:absolute;left:-10000px;width:800px;height:600px",
  "0×0": "width:0;height:0;border:0",
  "1×1": "width:1px;height:1px;border:0",
  "clip-path:inset(100%)": "width:400px;height:200px;clip-path:inset(100%)",
} as const;

// Another origin on the login's site, which Playwright's routes answer without any DNS.
const sameSite = (site: string) => site.replace("localhost", "evil.localhost");

const trapPage = html(
  `<form id="trap"><input id="trap-user" autocomplete="username"><input id="trap-pw" type="password"></form>
<script>for (const id of ["trap-user", "trap-pw"]) document.getElementById(id).addEventListener("input", (e) => steal(e.target.value));</script>`,
  lootScript,
);

const framePage = (frameUrl: string, style: string, form = true) =>
  html(`${form ? `<h1>Sign in</h1>${loginForm()}` : "<h1>Welcome</h1>"}<iframe id="trap-frame" src="${frameUrl}" style="${style}"></iframe>`);

const trapValues = async (page: Page) => {
  const frame = page.frameLocator("#trap-frame");
  return [await frame.locator("#trap-user").inputValue(), await frame.locator("#trap-pw").inputValue()];
};

const fillInTab = (popup: Page, tabId: number, entryId: number) =>
  popup.evaluate(([id, entry]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId: entry }), [tabId, entryId]);

// A page whose top frame has no login form shows no badge, so it is opened without waiting for one. No tabs
// permission, so no query by URL: the page is the newest tab.
const openFramePage = async (context: import("@playwright/test").BrowserContext, popup: Page, url: string) => {
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await popup.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((tab) => tab.id!)));
  return { page, tabId };
};

// The frame's content script has to be running before the fill, or the test proves nothing.
const frameReady = (page: Page) =>
  expect.poll(() => page.frameLocator("#trap-frame").locator("#trap-pw").count(), { message: "the trap frame's form" }).toBe(1);

for (const [kind, style] of Object.entries(hiddenFrames)) {
  test(`a hidden same-site frame (${kind}) doesn't catch the popup's Fill`, async ({ context, popup, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const frameUrl = `${sameSite(site)}/hostile/trap`;
    const url = `${site}/hostile/frames`;
    await serve(context, frameUrl, trapPage);
    await serve(context, url, framePage(frameUrl, style));
    const { page, tabId } = await openLoginPage(context, worker, url);
    await frameReady(page);
    expect(await fillInTab(popup, tabId, quark.seed.local)).toMatchObject({ ok: true });
    await expect(page.locator("#pw")).toHaveValue(login.password);
    await settle(page);
    expect(await trapValues(page)).toEqual(["", ""]);
  });
}

test("a hidden same-site frame on a page with no form of its own is refused", async ({ context, popup, quark, site }) => {
  const frameUrl = `${sameSite(site)}/hostile/trap`;
  const url = `${site}/hostile/frames`;
  await serve(context, frameUrl, trapPage);
  await serve(context, url, framePage(frameUrl, hiddenFrames["opacity:0 and off-screen"], false));
  const { page, tabId } = await openFramePage(context, popup, url);
  await frameReady(page);
  expect(await fillInTab(popup, tabId, quark.seed.local)).toMatchObject({
    ok: false,
    error: { kind: "refused", reason: expect.stringContaining("frame you can't see") as unknown },
  });
  await settle(page);
  expect(await trapValues(page)).toEqual(["", ""]);
});

test("a hidden same-origin frame doesn't catch the popup's Fill", async ({ context, popup, quark, site, worker }) => {
  const login = await seededLogin(quark);
  const frameUrl = `${site}/hostile/trap`;
  const url = `${site}/hostile/frames`;
  await serve(context, frameUrl, trapPage);
  await serve(context, url, framePage(frameUrl, hiddenFrames["0×0"]));
  const { page, tabId } = await openLoginPage(context, worker, url);
  await frameReady(page);
  expect(await fillInTab(popup, tabId, quark.seed.local)).toMatchObject({ ok: true });
  await expect(page.locator("#pw")).toHaveValue(login.password);
  await settle(page);
  expect(await trapValues(page)).toEqual(["", ""]);
});

test("a visible same-site frame still fills from the popup", async ({ context, popup, quark, site }) => {
  const login = await seededLogin(quark);
  const frameUrl = `${sameSite(site)}/hostile/trap`;
  const url = `${site}/hostile/frames`;
  await serve(context, frameUrl, trapPage);
  await serve(context, url, framePage(frameUrl, "width:520px;height:240px;border:1px solid #ccc", false));
  const { page, tabId } = await openFramePage(context, popup, url);
  await frameReady(page);
  expect(await fillInTab(popup, tabId, quark.seed.local)).toMatchObject({ ok: true });
  await expect.poll(() => trapValues(page)).toEqual([login.username, login.password]);
});
