import { chromium } from "playwright-core";
import http from "node:http";

import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/chrome", import.meta.url));
const shots = process.env.E2E_SCREENSHOTS ?? "";
const executablePath = process.env.CHROME_PATH;
if (!executablePath) {
  console.error("Set CHROME_PATH to a Chromium or Chrome for Testing binary.");
  process.exit(2);
}
const API = 18080;
const SITE = 18081;
let locked = true;
const log = [];
const writes = [];

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => resolve(data ? JSON.parse(data) : {}));
});

const api = http.createServer(async (req, res) => {
  log.push(`${req.method} ${req.url}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
      "Access-Control-Allow-Methods": "GET, POST, PUT",
    });
    return res.end();
  }
  const body = await readBody(req);
  const url = req.url.replace("/api/v0", "");
  if (url === "/auth/login") {
    return body.username === "admin" && body.password === "pw"
      ? json(res, 200, { token: "tok" })
      : json(res, 401, { error: "invalid credentials" });
  }
  if (req.headers.authorization !== "Bearer tok") return json(res, 401, { error: "authentication required" });
  if (url === "/vault/status") return json(res, 200, { initialized: true, locked, autoLockSeconds: 900, deviceConnected: true });
  if (url === "/vault/unlock") {
    if (body.masterPassword !== "master") return json(res, 401, { error: "incorrect master password" });
    locked = false;
    return json(res, 200, { locked: false });
  }
  if (url === "/vault/lock") { locked = true; return json(res, 200, { locked: true }); }
  if (url === "/vault/entries" && req.method === "GET") {
    return json(res, 200, { entries: [
      { id: 1, name: "Local Test", urlHost: "localhost", folderId: null },
      { id: 2, name: "GitHub", urlHost: "github.com", folderId: null },
    ] });
  }
  if (url === "/vault/entries" && req.method === "POST") {
    writes.push({ method: "POST", body });
    return json(res, 200, { id: 99 });
  }
  const m = url.match(/^\/vault\/entries\/(\d+)$/);
  if (m && req.method === "PUT") {
    writes.push({ method: "PUT", id: Number(m[1]), body });
    return json(res, 200, { id: Number(m[1]) });
  }
  if (m) {
    if (locked) return json(res, 423, { error: "vault is locked" });
    return m[1] === "1"
      ? json(res, 200, { id: 1, name: "Local Test", url: `http://localhost:${SITE}`, urlHost: "localhost", username: "alice", password: "s3cret", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", notes: "keep me", customFields: [{ name: "pin", value: "1234", hidden: true }], folderId: 3 })
      : json(res, 200, { id: 2, name: "GitHub", url: "https://github.com", urlHost: "github.com", username: "gh", password: "ghpw" });
  }
  if (url === "/vault/generate") return json(res, 200, { password: "G".repeat(body.length ?? 20) });
  json(res, 404, { error: "not found" });
});

const site = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  if (req.url === "/framed" || req.url === "/cross") {
    return res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px">
<h1>${req.url === "/framed" ? "Same-site frame" : "Cross-site frame"}</h1>
<iframe id="login" src="http://localhost:${SITE}/" style="width:520px;height:360px;border:1px solid #ccc"></iframe>
</body></html>`);
  }
  if (req.url === "/signup") {
    return res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px">
<h1>Create account</h1>
<form style="width:320px;display:flex;flex-direction:column;gap:8px">
<label>Email <input id="email" type="email"></label>
<label>Password <input id="new1" type="password" autocomplete="new-password" maxlength="16" style="width:100%;height:32px"></label>
<label>Confirm <input id="new2" type="password" autocomplete="new-password" maxlength="16" style="width:100%;height:32px"></label>
</form></body></html>`);
  }
  if (req.url === "/2fa") {
    return res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px">
<h1>Two-step verification</h1>
<form style="width:320px"><label>Code <input id="otp" type="text" autocomplete="one-time-code" style="width:100%;height:32px"></label></form>
</body></html>`);
  }
  res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px">
<h1>Sign in</h1>
<form id="f" style="width:320px;display:flex;flex-direction:column;gap:8px">
<label>Username <input id="user" type="text" autocomplete="username" pattern="[^!]*" style="width:100%;height:32px"></label>
<label>Password <input id="pw" type="password" style="width:100%;height:32px"></label>
<button type="submit">Sign in</button>
</form>
<script>
window.events=[];
for (const id of ["user","pw"]) document.getElementById(id).addEventListener("input", e => window.events.push(id+"="+e.target.value));
document.getElementById("f").addEventListener("submit", e => { e.preventDefault(); window.submitted = true; });
</script></body></html>`);
});

await new Promise((r) => api.listen(API, "127.0.0.1", r));
await new Promise((r) => site.listen(SITE, "127.0.0.1", r));

const results = [];
const check = (name, cond, detail = "") => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const context = await chromium.launchPersistentContext("", {
  executablePath,
  headless: false,
  args: ["--headless=new", `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-sandbox"],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extId = new URL(worker.url()).host;

  const loginPage = await context.newPage();
  await loginPage.goto(`http://localhost:${SITE}/`);

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 580 });
  popup.on("pageerror", (e) => results.push(`FAIL  popup error: ${e.message}`));
  await popup.goto(`chrome-extension://${extId}/popup.html`);

  await popup.getByRole("heading", { name: "Connect to your Quark" }).waitFor();
  check("popup starts on the connect screen", true);

  await popup.fill("#server", `http://127.0.0.1:${API}`);
  await popup.fill("#username", "admin");
  await popup.fill("#password", "wrong");
  await popup.click("button[type=submit]");
  await popup.getByText("Invalid username or password.").waitFor({ timeout: 5000 });
  check("wrong account password shows an error", true);

  await popup.fill("#server", `http://127.0.0.1:${API}`);
  await popup.fill("#username", "admin");
  await popup.fill("#password", "pw");
  await popup.click("button[type=submit]");
  await popup.getByRole("heading", { name: "Vault is locked" }).waitFor({ timeout: 5000 });
  check("sign-in moves to the unlock screen", true);
  if (shots) await popup.screenshot({ path: `${shots}/popup-unlock.png` });

  await popup.fill("#master", "nope");
  await popup.click("button[type=submit]");
  await popup.getByText("That password didn't unlock the vault.").waitFor({ timeout: 5000 });
  check("wrong master password shows an error", true);

  await popup.fill("#master", "master");
  await popup.click("button[type=submit]");
  await popup.getByText("All entries · 2").waitFor({ timeout: 5000 });
  check("unlock shows the entries list", true);
  check("other-password-manager banner shows", await popup.getByText("may also try to fill logins").isVisible());
  if (shots) await popup.screenshot({ path: `${shots}/popup-entries.png` });

  const stored = await worker.evaluate(async () => ({
    session: await chrome.storage.session.get("connection"),
    local: await chrome.storage.local.get(null),
  }));
  check("token kept in session storage, not local", stored.session.connection?.token === "tok" && stored.local.connection === undefined);
  check("master password never stored", !JSON.stringify(stored).includes("master"));

  await loginPage.reload();
  await loginPage.waitForTimeout(1500);
  const extraNodes = await loginPage.evaluate(() => document.body.lastElementChild?.tagName);
  check("content script adds the inline button", extraNodes === "DIV");
  const badges = await worker.evaluate(async () =>
    Promise.all((await chrome.tabs.query({})).map(async (t) => [t.id, await chrome.action.getBadgeText({ tabId: t.id })])));
  const tabId = badges.find(([, text]) => text === "1")?.[0];
  check("toolbar badge shows 1 match on the login tab only", tabId !== undefined && badges.filter(([, t]) => t !== "").length === 1, JSON.stringify(badges));
  const urlHidden = await worker.evaluate(async () => (await chrome.tabs.query({})).every((t) => t.url === undefined || t.url.startsWith("chrome-extension://") || t.url === "about:blank"));
  check("extension can't read other tabs' URLs (no tabs permission)", urlHidden);

  const fill = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId: 1 }), tabId);
  const values = await loginPage.evaluate(() => [document.getElementById("user").value, document.getElementById("pw").value, window.events, !!window.submitted]);
  check("popup Fill fills the page", fill.ok && values[0] === "alice" && values[1] === "s3cret", JSON.stringify(fill));
  check("fill fires input events", values[2].includes("user=alice") && values[2].includes("pw=s3cret"));
  check("no auto-submit by default", values[3] === false);

  const wrongSite = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId: 2 }), tabId);
  check("refuses to fill another site's login", !wrongSite.ok && wrongSite.error.kind === "refused", JSON.stringify(wrongSite));

  await loginPage.evaluate(() => { for (const id of ["user", "pw"]) document.getElementById(id).value = ""; });
  const box = await loginPage.locator("#pw").boundingBox();
  await loginPage.mouse.click(box.x + box.width - 17, box.y + box.height / 2);
  await loginPage.waitForTimeout(300);
  if (shots) await loginPage.screenshot({ path: `${shots}/inline-picker.png` });
  await loginPage.keyboard.press("Enter");
  await loginPage.waitForTimeout(800);
  const inline = await loginPage.evaluate(() => [document.getElementById("user").value, document.getElementById("pw").value]);
  check("inline picker fills the page", inline[0] === "alice" && inline[1] === "s3cret", JSON.stringify(inline));

  const opened = await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "openPicker" }, { frameId: 0 }), tabId);
  check("shortcut can open the inline picker", opened?.ok === true, JSON.stringify(opened));
  await loginPage.keyboard.press("Escape");
  const command = await worker.evaluate(async () => (await chrome.commands.getAll()).find((c) => c.name === "fill-login"));
  check(
    "fill command is registered; the browser binds Ctrl+Shift+L or leaves it for the user to set",
    command !== undefined && (command.shortcut === "Ctrl+Shift+L" || command.shortcut === ""),
    JSON.stringify(command),
  );

  const pageSteal = await loginPage.evaluate(() => typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function");
  check("page scripts can't message the extension", pageSteal);

  const submitLogin = async (username, password) => {
    await loginPage.evaluate(([u, p]) => {
      document.getElementById("user").value = u;
      document.getElementById("pw").value = p;
    }, [username, password]);
    await loginPage.click("button[type=submit]");
    await loginPage.waitForTimeout(800);
    return popup.evaluate((id) => chrome.runtime.sendMessage({ type: "pendingOffer", tabId: id }), tabId);
  };

  const sameOffer = await submitLogin("alice", "s3cret");
  check("submitting the saved password offers nothing", sameOffer === null, JSON.stringify(sameOffer));

  const invalid = await submitLogin("bo!b", "hunter2");
  check("a submit the browser blocks offers nothing", invalid === null, JSON.stringify(invalid));

  const saveOffer = await submitLogin("bob@example.com", "hunter2");
  const barShown = await loginPage.evaluate(() => document.body.querySelectorAll(":scope > div").length);
  check("new login offers to save", saveOffer?.kind === "save" && saveOffer.username === "bob@example.com", JSON.stringify(saveOffer));
  check("save bar appears in the page", barShown >= 2, `host divs=${barShown}`);
  if (shots) await loginPage.screenshot({ path: `${shots}/save-bar.png` });
  const saved = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "resolveSave", action: "save", tabId: id }), tabId);
  const post = writes.find((w) => w.method === "POST");
  check("saving posts the new entry", saved.ok && post?.body.username === "bob@example.com" && post.body.password === "hunter2" && post.body.url === `http://localhost:${SITE}`, JSON.stringify(post));

  const updateOffer = await submitLogin("alice", "n3w-pass");
  check("changed password offers to update", updateOffer?.kind === "update" && updateOffer.entryId === 1, JSON.stringify(updateOffer));
  const updated = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "resolveSave", action: "update", tabId: id }), tabId);
  const put = writes.find((w) => w.method === "PUT");
  check(
    "update replaces only the password",
    updated.ok && put?.id === 1 && put.body.password === "n3w-pass" && put.body.notes === "keep me" && put.body.totpSecret !== "" && put.body.folderId === 3 && put.body.customFields?.[0]?.value === "1234",
    JSON.stringify(put),
  );

  const pickInFrame = async (page) => {
    await page.waitForTimeout(1800);
    const frame = page.frameLocator("#login");
    const box = await frame.locator("#pw").boundingBox();
    await page.mouse.click(box.x + box.width - 17, box.y + box.height / 2);
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    return [await frame.locator("#user").inputValue(), await frame.locator("#pw").inputValue()];
  };

  const framed = await context.newPage();
  await framed.goto(`http://localhost:${SITE}/framed`);
  const framedValues = await pickInFrame(framed);
  check("same-site frame fills", framedValues[0] === "alice" && framedValues[1] === "s3cret", JSON.stringify(framedValues));
  await framed.close();

  const cross = await context.newPage();
  await cross.goto(`http://127.0.0.1:${SITE}/cross`);
  const crossValues = await pickInFrame(cross);
  if (shots) await cross.screenshot({ path: `${shots}/cross-frame.png` });
  check("cross-site frame refuses to fill", crossValues[0] === "" && crossValues[1] === "", JSON.stringify(crossValues));
  await cross.close();

  const signup = await context.newPage();
  await signup.goto(`http://localhost:${SITE}/signup`);
  await signup.waitForTimeout(1500);
  const newBox = await signup.locator("#new1").boundingBox();
  await signup.mouse.click(newBox.x + newBox.width - 17, newBox.y + newBox.height / 2);
  await signup.waitForTimeout(300);
  await signup.keyboard.press("Enter");
  await signup.waitForTimeout(800);
  const generated = [await signup.locator("#new1").inputValue(), await signup.locator("#new2").inputValue()];
  check("sign-up picker suggests a password for both fields, sized to maxlength", generated[0] === "G".repeat(16) && generated[1] === generated[0], JSON.stringify(generated));
  await signup.close();

  const otpPage = await context.newPage();
  await otpPage.goto(`http://localhost:${SITE}/2fa`);
  await otpPage.waitForTimeout(1500);
  const otpBox = await otpPage.locator("#otp").boundingBox();
  await otpPage.mouse.click(otpBox.x + otpBox.width - 17, otpBox.y + otpBox.height / 2);
  await otpPage.waitForTimeout(300);
  await otpPage.keyboard.press("Enter");
  await otpPage.waitForTimeout(800);
  const otpValue = await otpPage.locator("#otp").inputValue();
  check("inline picker fills a one-time code", /^\d{6}$/.test(otpValue), JSON.stringify(otpValue));
  const popupCode = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "otp", entryId: 1 }));
  const sameWindow = popupCode.ok && (popupCode.value.code === otpValue || popupCode.value.secondsLeft >= 27);
  check("popup gets the same code (or a fresh one after rollover)", sameWindow && /^\d{6}$/.test(popupCode.value.code), JSON.stringify(popupCode));
  const noSecret = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "otp", entryId: 2 }));
  check("entry without a secret says so", !noSecret.ok && noSecret.error.kind === "refused", JSON.stringify(noSecret));
  await otpPage.close();

  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
  const whileLocked = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "fillInTab", tabId: id, entryId: 1 }), tabId);
  check("locked vault reports locked", !whileLocked.ok && whileLocked.error.kind === "locked", JSON.stringify(whileLocked));

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.getByRole("heading", { name: "Other password managers" }).waitFor({ timeout: 5000 });
  check("options page shows the other-managers section", true);
  await options.setViewportSize({ width: 800, height: 900 });
  if (shots) await options.screenshot({ path: `${shots}/options.png`, fullPage: true });
} catch (error) {
  results.push(`FAIL  crashed: ${error.message.split("\n")[0]}`);
} finally {
  console.log(results.join("\n"));
  await context.close();
  api.close();
  site.close();
}

process.exit(results.some((line) => line.startsWith("FAIL")) ? 1 : 0);
