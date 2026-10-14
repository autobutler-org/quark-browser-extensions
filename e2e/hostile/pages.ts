import type { BrowserContext, Page, Request } from "@playwright/test";
import type { Quark } from "../fixtures.ts";

// Hostile pages, served by Playwright routes rather than the test site, so they can sit on the
// site's own origin (where the seeded "Local Test" login matches), on another origin, or post to one.

// Another origin: the test site's port on 127.0.0.1 instead of localhost.
export const otherOrigin = (site: string) => site.replace("localhost", "127.0.0.1");

// Where hostile forms post. Never resolved: the route below answers for it.
export const sink = "http://evil.test";

// The page skeleton. `head` runs before the content script, which loads at document_idle.
export const html = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body style="font-family:sans-serif;padding:40px">${body}</body></html>`;

// The sign-in form the seeded login fills, as on the test site.
export const loginForm = (attributes = "") => `<form id="f"${attributes} style="width:320px;display:flex;flex-direction:column;gap:8px">
<label>Username <input id="user" name="user" type="text" autocomplete="username" style="width:100%;height:32px"></label>
<label>Password <input id="pw" name="pw" type="password" style="width:100%;height:32px"></label>
<button type="submit">Sign in</button>
</form>`;

// Page script that keeps everything it manages to read in window.loot, for the test to search.
export const lootScript = `<script>window.loot = []; window.steal = (what) => { if (what) window.loot.push(String(what)); };</script>`;

export const serve = async (context: BrowserContext, url: string, body: string) => {
  await context.route(url, (route) => route.fulfill({ status: 200, contentType: "text/html", body }));
};

// Records every request that reaches the sink, and answers it.
export const watchSink = async (context: BrowserContext) => {
  const requests: Request[] = [];
  await context.route(`${sink}/**`, (route) => {
    requests.push(route.request());
    return route.fulfill({ status: 200, contentType: "text/html", body: html("<p>thanks</p>") });
  });
  return requests;
};

export const loot = (page: Page) => page.evaluate(() => (window as unknown as { loot: string[] }).loot.join("\n"));

// The seeded login, read from the Quark at run time so no credential is written into a test.
export const seededLogin = async (quark: Quark) => {
  const token = await quark.api.login(quark.seed.owner.username, quark.seed.owner.password);
  return quark.api.expectOk<{ name: string; username: string; password: string }>(
    quark.api.call("GET", `/vault/entries/${quark.seed.local}`, undefined, token),
    "GET the seeded login",
  );
};

// Waits for the content script to draw its inline button, a <div> host appended to <body>.
export const inlineButton = (page: Page) =>
  page.waitForFunction(() => [...document.body.children].some((child) => child.localName === "div" && child.id === ""));

// Time for a fill that shouldn't happen to happen.
export const settle = (page: Page) => page.waitForTimeout(1000);
