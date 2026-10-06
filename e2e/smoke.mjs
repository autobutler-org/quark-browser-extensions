import { chromium } from "playwright-core";
import http from "node:http";

import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
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
      "Access-Control-Allow-Methods": "GET, POST",
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
  if (url === "/vault/entries") {
    return json(res, 200, { entries: [
      { id: 1, name: "Local Test", urlHost: "localhost", folderId: null },
      { id: 2, name: "GitHub", urlHost: "github.com", folderId: null },
    ] });
  }
  const m = url.match(/^\/vault\/entries\/(\d+)$/);
  if (m) {
    if (locked) return json(res, 423, { error: "vault is locked" });
    return m[1] === "1"
      ? json(res, 200, { id: 1, name: "Local Test", url: `http://localhost:${SITE}`, urlHost: "localhost", username: "alice", password: "s3cret" })
      : json(res, 200, { id: 2, name: "GitHub", url: "https://github.com", urlHost: "github.com", username: "gh", password: "ghpw" });
  }
  if (url === "/vault/generate") return json(res, 200, { password: "Gen3rated!Pass" });
  json(res, 404, { error: "not found" });
});

const site = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px">
<h1>Sign in</h1>
<form id="f" style="width:320px;display:flex;flex-direction:column;gap:8px">
<label>Email <input id="user" type="email" autocomplete="username" style="width:100%;height:32px"></label>
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
