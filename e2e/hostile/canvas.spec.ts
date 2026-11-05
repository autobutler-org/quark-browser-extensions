import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect, signInAndUnlock, test } from "../fixtures.ts";
import { html, loginForm, lootScript, serve, settle } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// Transparent login fields laid over a <canvas>, the way Flutter web lays its semantics tree over what it paints
// (#159). Only the connected Quark's own web app gets that exception (#226): on any other page the fields are
// hidden, whatever the canvas draws, so the login never goes into fields the user can't see. Quark's own login
// still fills: e2e/quark-login.spec.ts.
const paint = {
  blank: "",
  "painted as another control": `<script>
const c = document.getElementById("paint").getContext("2d");
c.fillStyle = "#eef"; c.fillRect(0, 0, 900, 700);
c.fillStyle = "#123"; c.font = "24px sans-serif"; c.fillText("Search the catalogue", 60, 140);
</script>`,
} as const;

const canvasPage = (script: string) =>
  html(
    `<canvas id="paint" width="900" height="700" style="position:absolute;left:0;top:0;width:900px;height:700px"></canvas>
<div id="semantics" style="position:absolute;left:40px;top:80px;filter:opacity(0%)">${loginForm()}</div>
${script}
<script>for (const id of ["user", "pw"]) document.getElementById(id).addEventListener("input", (e) => steal(e.target.value));</script>`,
    lootScript,
  );

const values = (page: Page) =>
  page.evaluate(() => ["user", "pw"].map((id) => (document.getElementById(id) as HTMLInputElement).value));

// No login field is found, so no badge: the page is the newest tab, as the worker can't query tabs by URL.
const openPage = async (context: BrowserContext, worker: Worker, url: string) => {
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await worker.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((tab) => tab.id ?? -1)));
  return { page, tabId };
};

const fillInTab = (popup: Page, tabId: number, entryId: number): Promise<unknown> =>
  popup.evaluate(([id, entry]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId: entry }), [tabId, entryId]);

for (const [kind, script] of Object.entries(paint)) {
  test.describe(`transparent login fields over a canvas, ${kind}, on a page that isn't the Quark`, () => {
    test("refuse the popup's Fill and get no inline button", async ({ context, popup, quark, site, worker }) => {
      const url = `${site}/hostile/canvas`;
      await serve(context, url, canvasPage(script));
      const { page, tabId } = await openPage(context, worker, url);
      await settle(page);
      expect(await fillInTab(popup, tabId, quark.seed.local)).toMatchObject({ ok: false });
      await settle(page);
      expect(await values(page)).toEqual(["", ""]);
      expect(await page.evaluate(() => (window as unknown as { loot: string[] }).loot)).toEqual([]);
      expect(await page.evaluate(() => [...document.body.children].some((child) => child.localName === "div" && child.id === ""))).toBe(false);
    });
  });
}

test.describe("transparent login fields over a canvas in a visible same-origin frame", () => {
  test("refuse the popup's Fill", async ({ context, popup, quark, site, worker }) => {
    const frameUrl = `${site}/hostile/canvas-frame`;
    const url = `${site}/hostile/canvas-host`;
    await serve(context, frameUrl, canvasPage(paint["painted as another control"]));
    await serve(context, url, html(`<h1>Welcome</h1><iframe id="f" src="${frameUrl}" style="width:960px;height:760px;border:0"></iframe>`));
    const { page, tabId } = await openPage(context, worker, url);
    await expect.poll(() => page.frameLocator("#f").locator("#pw").count()).toBe(1);
    await settle(page);
    expect(await fillInTab(popup, tabId, quark.seed.local)).toMatchObject({ ok: false });
    await settle(page);
    const frame = page.frameLocator("#f");
    expect([await frame.locator("#user").inputValue(), await frame.locator("#pw").inputValue()]).toEqual(["", ""]);
  });
});
