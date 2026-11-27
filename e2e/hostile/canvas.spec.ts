import type { Page } from "@playwright/test";
import { expect, openLoginPage, signInAndUnlock, test } from "../fixtures.ts";
import { html, loginForm, lootScript, seededLogin, serve, settle } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// A transparent login pair laid exactly over a <canvas>, the way Flutter web draws its fields (#159), on a page
// that isn't the Quark's own (#226). The canvas exception used to accept any visible canvas, so markup alone
// brought the hidden-field fill of #129 and #142 back. Only the connected Quark's pages get that exception now.
const bait = (canvasStyle: string, paint = "") => `<form id="bait" action="/bait" style="position:relative;width:340px;height:110px">
<canvas id="paint" width="340" height="110" style="position:absolute;left:0;top:0;width:340px;height:110px;${canvasStyle}"></canvas>
<input id="bait-user" type="text" autocomplete="username" style="position:absolute;left:10px;top:10px;width:300px;height:32px;filter:opacity(0)">
<input id="bait-pw" type="password" style="position:absolute;left:10px;top:60px;width:300px;height:32px;filter:opacity(0)">
</form>
<script>
${paint}
for (const id of ["bait-user", "bait-pw"]) document.getElementById(id).addEventListener("input", (e) => steal(e.target.value));
</script>`;

// Paints the canvas as a search box and a button, so what the user sees is not a login form at all.
const searchBox = `const g = document.getElementById("paint").getContext("2d");
g.fillStyle = "#eee"; g.fillRect(10, 10, 300, 32);
g.fillStyle = "#333"; g.font = "16px sans-serif"; g.fillText("Search the docs", 20, 32);
g.fillStyle = "#0a7"; g.fillRect(10, 60, 120, 32);
g.fillStyle = "#fff"; g.fillText("Subscribe", 30, 82);`;

const baitPage = (canvasStyle: string, paint?: string) => html(`${bait(canvasStyle, paint)}<h1>Sign in</h1>${loginForm()}`, lootScript);

const framedPage = (frameUrl: string, frameStyle: string) =>
  html(`<h1>Sign in</h1>${loginForm()}<iframe id="bait-frame" src="${frameUrl}" style="${frameStyle}"></iframe>`);

const fillInTab = (popup: Page, tabId: number, entryId: number) =>
  popup.evaluate(([id, entry]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId: entry }), [tabId, entryId]);

const realValues = (page: Page) =>
  page.evaluate(() => ["user", "pw"].map((id) => (document.getElementById(id) as HTMLInputElement).value));

const onTop = {
  "over a blank canvas": baitPage(""),
  "over a canvas painted as another control": baitPage("", searchBox),
  "over a canvas smaller than the fields": baitPage("width:20px;height:20px"),
  "over a canvas moved out of view": baitPage("left:-10000px"),
} as const;

for (const [kind, page] of Object.entries(onTop)) {
  test(`transparent login fields ${kind} don't catch the popup's Fill`, async ({ context, popup, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const url = `${site}/hostile/canvas`;
    await serve(context, url, page);
    const { page: tab, tabId } = await openLoginPage(context, worker, url);
    await settle(tab);
    expect(await fillInTab(popup, tabId, quark.seed.local)).toMatchObject({ ok: true });
    await expect.poll(() => realValues(tab)).toEqual([login.username, login.password]);
    expect(await tab.evaluate(() => ["bait-user", "bait-pw"].map((id) => (document.getElementById(id) as HTMLInputElement).value))).toEqual(["", ""]);
    expect(await tab.evaluate(() => (window as unknown as { loot: string[] }).loot)).toEqual([]);
  });
}

const framed = {
  "a visible same-origin frame": "width:400px;height:160px;border:0",
  "a tiny same-origin frame": "width:2px;height:2px;border:0",
} as const;

for (const [kind, frameStyle] of Object.entries(framed)) {
  test(`transparent login fields over a blank canvas in ${kind} don't catch the popup's Fill`, async ({ context, popup, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const frameUrl = `${site}/hostile/canvas-frame`;
    const url = `${site}/hostile/canvas-framed`;
    await serve(context, frameUrl, html(bait(""), lootScript));
    await serve(context, url, framedPage(frameUrl, frameStyle));
    const { page: tab, tabId } = await openLoginPage(context, worker, url);
    const frame = tab.frameLocator("#bait-frame");
    await expect(frame.locator("#paint")).toHaveCount(1);
    await settle(tab);
    expect(await fillInTab(popup, tabId, quark.seed.local)).toMatchObject({ ok: true });
    await expect.poll(() => realValues(tab)).toEqual([login.username, login.password]);
    await settle(tab);
    expect([await frame.locator("#bait-user").inputValue(), await frame.locator("#bait-pw").inputValue()]).toEqual(["", ""]);
  });
}
