// The 1280x800 screenshots the Chrome Web Store and AMO listings use. Run it
// through scripts/screenshots.config.js, which explains the setup. Each shot is
// the real extension against the e2e Quark; only the test site's sign-in page
// is restyled, and the popup, which tests open as a tab, is told which tab it
// is over and drawn onto that page the way the toolbar would show it.
/* global chrome, document, window, URL */
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { clickInlineButton, expect, openLoginPage, signInAndUnlock, test } from "../e2e/fixtures.ts";

// Under .output/, which git ignores and the AMO sources zip leaves out.
const out = fileURLToPath(new URL("../.output/store-screenshots/", import.meta.url));
const size = { width: 1280, height: 800 };

// More logins than the seed's two, so the popup's list looks lived in.
const extraEntries = [
  { name: "Webmail", url: "https://mail.example.com", username: "alice@example.com", password: "Correct-Horse-7" },
  { name: "Router", url: "http://192.168.1.1", username: "admin", password: "router-pass-1" },
  { name: "Bank", url: "https://bank.example", username: "alice.smith", password: "Battery-Staple-9" },
];

// The test site's sign-in form, with the same field ids and submit handling,
// dressed up for a store listing.
const signInPage = `<!doctype html>
<html><head><title>Sign in · Northwind</title><style>
  body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: linear-gradient(135deg, #e0f2fe, #f8fafc 60%); color: #0f172a; }
  main { min-height: 100vh; display: grid; place-items: center; }
  .card { width: 360px; padding: 32px; background: #fff; border-radius: 14px; box-shadow: 0 10px 40px rgb(15 23 42 / 0.12); }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p { margin: 0 0 20px; color: #475569; }
  form { display: flex; flex-direction: column; gap: 14px; }
  label { display: flex; flex-direction: column; gap: 6px; font-weight: 600; font-size: 13px; }
  input { height: 40px; padding: 0 12px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; }
  button { height: 42px; border: 0; border-radius: 8px; background: #0f172a; color: #fff; font: inherit; font-weight: 600; }
</style></head><body>
<main><div class="card">
  <h1>Northwind</h1>
  <p>Sign in to your account</p>
  <form id="f">
    <label>Username <input id="user" type="text" autocomplete="username"></label>
    <label>Password <input id="pw" type="password" autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
  </form>
</div></main>
<script>document.getElementById("f").addEventListener("submit", (e) => e.preventDefault());</script>
</body></html>`;

// Draws a popup screenshot over a page screenshot, hanging from the toolbar's
// top right corner.
const overlay = async (context, background, popupImage) => {
  const canvas = await context.newPage();
  await canvas.setViewportSize(size);
  const src = (png) => `data:image/png;base64,${png.toString("base64")}`;
  await canvas.setContent(`<!doctype html><body style="margin:0;position:relative;width:1280px;height:800px;overflow:hidden">
<img src="${src(background)}" style="position:absolute;inset:0">
<img src="${src(popupImage)}" style="position:absolute;top:8px;right:16px;border-radius:8px;box-shadow:0 12px 40px rgb(0 0 0 / 0.28)">
</body>`);
  await canvas.waitForFunction(() => [...document.images].every((img) => img.complete));
  await canvas.screenshot({ path: `${out}1-popup.png` });
  await canvas.close();
};

test("store screenshots", async ({ context, extensionId, popup, quark, site, worker }) => {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await context.route(`${site}/`, (route) => route.fulfill({ contentType: "text/html", body: signInPage }));
  // Add the extra logins before the popup lists, and caches, the vault.
  const token = await quark.api.login(quark.seed.owner.username, quark.seed.owner.password);
  await quark.api.call("POST", "/vault/unlock", { masterPassword: quark.seed.masterPassword }, token);
  const added = [];
  // The seed's login for the test site, named after the restyled page for now.
  const entry = `/vault/entries/${quark.seed.local}`;
  const local = await quark.api.expectOk(quark.api.call("GET", entry, undefined, token), "GET entry");
  try {
    await quark.api.expectOk(quark.api.call("PUT", entry, { ...local, name: "Northwind" }, token), "PUT entry");
    for (const entry of extraEntries) {
      const { id } = await quark.api.expectOk(quark.api.call("POST", "/vault/entries", entry, token), "POST /vault/entries");
      added.push(id);
    }
    await signInAndUnlock(popup, quark);
    // Skip the first-run notices, which would cover the entry list.
    const settings = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "settings" }));
    await popup.evaluate(
      (current) => chrome.runtime.sendMessage({ type: "saveSettings", settings: { ...current, othersReviewed: true, welcomeSeen: true } }),
      settings,
    );
    const { page, tabId } = await openLoginPage(context, worker, site);
    await page.setViewportSize(size);

    // 1. The popup over the sign-in page: the site's match first, then every entry.
    // Without the tabs permission the browser hides the URL, which activeTab
    // would reveal when the toolbar button is clicked; say it here instead.
    await popup.addInitScript(([id, url]) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => (info.active && info.currentWindow ? [{ id, url }] : query(info));
    }, [tabId, page.url()]);
    await popup.reload();
    await expect(popup.getByText(/^All entries · \d+$/)).toBeVisible();
    await expect(popup.locator("button.fill.primary")).toBeVisible();
    const popupHeight = await popup.evaluate(() => document.documentElement.scrollHeight);
    const popupImage = await popup.screenshot({ clip: { x: 0, y: 0, width: 360, height: Math.min(popupHeight, 580) } });
    await page.bringToFront();
    await overlay(context, await page.screenshot(), popupImage);

    // 2. The inline picker, from the Quark button in the password field.
    await clickInlineButton(page, await page.locator("#pw").boundingBox());
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}2-fill-picker.png` });
    await page.keyboard.press("Escape");

    // 3. The save bar after signing in with a login the vault doesn't have.
    await page.fill("#user", "alice@northwind.example");
    await page.fill("#pw", "a-new-password");
    await page.click("button[type=submit]");
    await expect
      .poll(() => popup.evaluate((id) => chrome.runtime.sendMessage({ type: "pendingOffer", tabId: id }), tabId))
      .toMatchObject({ kind: "save" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}3-save-offer.png` });
    await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "resolveSave", action: "dismiss", tabId: id }), tabId);

    // 4. The options page.
    const options = await context.newPage();
    await options.setViewportSize(size);
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(options.getByRole("heading", { name: "Other password managers" })).toBeVisible();
    await options.evaluate(() => window.scrollTo(0, 0));
    await options.screenshot({ path: `${out}4-options.png` });
  } finally {
    for (const id of added) await quark.api.call("DELETE", `/vault/entries/${id}`, undefined, token);
    await quark.api.call("PUT", entry, local, token);
  }
});
