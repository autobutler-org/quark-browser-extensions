import { clickInlineButton, expect, openLoginPage, signInAndUnlock, test } from "../fixtures.ts";
import { html, inlineButton, loginForm, lootScript, seededLogin, serve, settle } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// A login form buried under an empty opaque box (#147). checkVisibility() is true and the border box is full
// size, so only a hit test at the fields' own points shows the user can't see or click them.
const steal = `<script>
for (const id of ["user", "pw"]) document.getElementById(id).addEventListener("input", (e) => steal(e.target.value));
</script>`;

const coveredPage = html(
  `<h1>Sign in</h1>${loginForm()}
<div id="cover" style="position:absolute;inset:0;background:#fff"></div>${steal}`,
  lootScript,
);

// A sticky header over the top of the username and a cookie banner over the bottom of the password: real
// pages cover parts of a login all the time, and the user can still click every field.
const partlyCoveredPage = html(
`<h1>Sign in</h1>${loginForm()}
<script>
const user = document.getElementById("user").getBoundingClientRect();
const pw = document.getElementById("pw").getBoundingClientRect();
const bar = (top, height) => {
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;left:0;right:0;background:#123;z-index:10;top:" + top + "px;height:" + height + "px";
  document.body.append(div);
};
bar(0, user.top + user.height / 3);
bar(pw.top + (pw.height * 2) / 3, 400);
</script>`,
);

const values = (page: import("@playwright/test").Page) =>
  page.evaluate(() => ({
    user: (document.getElementById("user") as HTMLInputElement).value,
    pw: (document.getElementById("pw") as HTMLInputElement).value,
  }));

// Opens the page and finds its tab. The covered page shows no badge: the content script finds no field to count.
const openPage = async (context: import("@playwright/test").BrowserContext, worker: import("@playwright/test").Worker, url: string) => {
  const page = await context.newPage();
  await page.goto(url);
  // The newest tab: the worker can't read tab URLs without the tabs permission.
  const tabId = await worker.evaluate(async () => Math.max(...(await chrome.tabs.query({})).map((tab) => tab.id ?? -1)));
  return { page, tabId };
};

const fillFromPopup = (popup: import("@playwright/test").Page, tabId: number, entryId: number): Promise<unknown> =>
  popup.evaluate(([id, entry]) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId: entry }), [tabId, entryId]);

test.describe("a login form under an opaque overlay", () => {
  test("refuses the popup's Fill and draws no inline button", async ({ context, popup, quark, site, worker }) => {
    const url = `${site}/hostile/overlay`;
    await serve(context, url, coveredPage);
    const { page, tabId } = await openPage(context, worker, url);
    await settle(page);
    expect(await fillFromPopup(popup, tabId, quark.seed.local)).toMatchObject({ ok: false });
    await settle(page);
    expect(await values(page)).toEqual({ user: "", pw: "" });
    expect(await page.evaluate(() => (window as unknown as { loot: string[] }).loot)).toEqual([]);
    expect(await page.evaluate(() => [...document.body.children].some((child) => child.localName === "div" && child.id === ""))).toBe(false);
  });

  test("fills once the overlay is gone", async ({ context, popup, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const url = `${site}/hostile/overlay`;
    await serve(context, url, coveredPage);
    const { page, tabId } = await openPage(context, worker, url);
    await settle(page);
    await page.evaluate(() => document.getElementById("cover")?.remove());
    expect(await fillFromPopup(popup, tabId, quark.seed.local)).toMatchObject({ ok: true });
    expect(await values(page)).toEqual({ user: login.username, pw: login.password });
  });
});

test.describe("a login form a sticky header and a cookie banner partly cover", () => {
  test("still fills from the popup and from the inline picker", async ({ context, popup, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const url = `${site}/hostile/partly-covered`;
    await serve(context, url, partlyCoveredPage);
    const { page, tabId } = await openLoginPage(context, worker, url);
    expect(await fillFromPopup(popup, tabId, quark.seed.local)).toMatchObject({ ok: true });
    expect(await values(page)).toEqual({ user: login.username, pw: login.password });

    await page.evaluate(() => {
      for (const id of ["user", "pw"]) (document.getElementById(id) as HTMLInputElement).value = "";
    });
    await inlineButton(page);
    const pw = await page.locator("#pw").boundingBox();
    await clickInlineButton(page, pw && { ...pw, height: (pw.height * 2) / 3 });
    await page.keyboard.press("Enter");
    await expect(page.locator("#pw")).toHaveValue(login.password);
  });
});
