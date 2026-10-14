import http from "node:http";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { freePort, listen } from "./support/listen.ts";

// A Quark that answers the connect form's two requests, the salt and then the login, as each case needs.
type Answer = Readonly<{ status: number; body: unknown }>;
type Stub = Readonly<{ salt: Answer; login?: Answer }>;

const salt = Buffer.alloc(16, 7).toString("base64");

const startStub = async (stub: Stub): Promise<{ server: string; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    const answer = req.url?.startsWith("/api/v0/auth/salt") ? stub.salt : req.url === "/api/v0/auth/login" ? stub.login : undefined;
    const { status, body } = answer ?? { status: 404, body: { error: "not found" } };
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
    res.end(JSON.stringify(body));
  });
  const port = await listen(server);
  return { server: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
};

// Where the Connect button sits against the popup's 580px and the form that scrolls inside it.
type Placement = Readonly<{ top: number; bottom: number; viewport: number; clipTop: number; clipBottom: number }>;
const placement = (popup: Page) =>
  popup.locator("button[type=submit]").evaluate((button): Placement => {
    const rect = button.getBoundingClientRect();
    let clipTop = 0;
    let clipBottom = window.innerHeight;
    for (let box = button.parentElement; box !== null; box = box.parentElement) {
      if (/(auto|scroll|hidden)/.test(getComputedStyle(box).overflowY)) {
        const clip = box.getBoundingClientRect();
        clipTop = Math.max(clipTop, clip.top);
        clipBottom = Math.min(clipBottom, clip.bottom);
      }
    }
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight, clipTop, clipBottom };
  });

const expectConnectInView = async (popup: Page, error: string) => {
  const { top, bottom, viewport, clipTop, clipBottom } = await placement(popup);
  expect(viewport, "the popup's height").toBe(580);
  expect(bottom, `the Connect button's bottom after "${error}"`).toBeLessThanOrEqual(Math.min(viewport, clipBottom) + 0.5);
  expect(top, `the Connect button's top after "${error}"`).toBeGreaterThanOrEqual(Math.max(0, clipTop) - 0.5);
  // The message saying what went wrong is in view too, not scrolled away by focusing the field to fix.
  await expect(popup.locator("form [role=alert]:not([hidden])").last(), error).toBeInViewport({ ratio: 1 });
};

const submit = async (popup: Page, server: string) => {
  await expect(popup.getByRole("heading", { name: "Connect to your Quark" })).toBeVisible();
  await popup.fill("#server", server);
  await popup.fill("#username", "someone");
  await popup.fill("#password", "a password");
  await popup.click("button[type=submit]");
};

const cases: readonly (Readonly<{ name: string; stub: Stub; shows: RegExp }>)[] = [
  {
    name: "wrong password",
    stub: { salt: { status: 200, body: { salt } }, login: { status: 401, body: { error: "invalid credentials" } } },
    shows: /Invalid username or password/,
  },
  { name: "426", stub: { salt: { status: 426, body: { error: "too old" } } }, shows: /This extension is too old/ },
  { name: "too-old Quark", stub: { salt: { status: 200, body: {} } }, shows: /Your Quark is too old/ },
  { name: "429", stub: { salt: { status: 429, body: { error: "slow down" } } }, shows: /Too many attempts/ },
  { name: "500", stub: { salt: { status: 500, body: { error: "boom" } } }, shows: /couldn't finish that/ },
  { name: "legacy-upgrade prompt", stub: { salt: { status: 200, body: { salt, legacy: true } } }, shows: /made before auth keys/ },
];

// A Connect error, worst of all with the first-run banner above the form, used to push the button below the
// popup's 580px, so retrying took a scroll or Enter (#160).
test.describe("the Connect button stays in view at 360x580 after each Connect error (#160)", () => {
  for (const { name, stub, shows } of cases) {
    test(name, async ({ popup }) => {
      const quark = await startStub(stub);
      try {
        await submit(popup, quark.server);
        await expect(popup.getByText(shows)).toBeVisible({ timeout: 30_000 });
        await expectConnectInView(popup, name);
      } finally {
        await quark.close();
      }
    });
  }

  test("unreachable, with the address hint", async ({ popup }) => {
    // https on a closed port: the longest hint, which offers the plain-http address too.
    await submit(popup, `https://127.0.0.1:${await freePort()}`);
    await expect(popup.getByText("Can't reach your Quark")).toBeVisible({ timeout: 30_000 });
    await expect(popup.getByText(/If your Quark serves plain http/)).toBeVisible();
    await expectConnectInView(popup, "unreachable");
  });
});
