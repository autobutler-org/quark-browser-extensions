import type { Logged } from "../support/proxy.ts";
import { badges, clickInlineButton, expect, frameOf, openLoginPage, send, signInAndUnlock, test, value, waitForText } from "./fixtures.ts";

const logins = (wire: Logged[]) =>
  wire
    .filter((request) => request.method === "POST" && request.path === "/api/v0/auth/login")
    .map((request) => request.body as Record<string, unknown>);

test("signs in with the auth key, unlocks the vault and lists the site's match", async ({ popup, quark, site }) => {
  await quark.clearWire();
  await signInAndUnlock(popup, quark);
  await waitForText(popup, "Local Test");

  const sent = logins(await quark.wire());
  expect(sent.length).toBeGreaterThan(0);
  for (const body of sent) {
    expect(Object.keys(body).sort(), "the password never goes over the wire").toEqual(["authKey", "username"]);
  }
  const matches = (await send(popup, { type: "matches", pageUrl: `${site}/` })) as { ok: boolean; value: { id: number; name: string }[] };
  expect(matches.ok).toBe(true);
  expect(matches.value.map((match) => match.id)).toEqual([quark.seed.local]);
});

test("fills the matching login from the popup and the inline picker, and only that site's", async ({ firefox, popup, quark, site }) => {
  await signInAndUnlock(popup, quark);
  const { page, tabId } = await openLoginPage(firefox, popup, site);
  expect((await badges(popup)).filter((tab) => tab.badge !== "").map((tab) => tab.badge), "only the login tab has a badge").toEqual(["1"]);

  expect(await send(popup, { type: "fillInTab", tabId, entryId: quark.seed.local })).toMatchObject({ ok: true });
  const filled = await page.evaluate(() => ({
    user: (document.getElementById("user") as HTMLInputElement).value,
    pw: (document.getElementById("pw") as HTMLInputElement).value,
    events: (window as unknown as { events: string[] }).events,
    submitted: !!(window as unknown as { submitted?: boolean }).submitted,
  }));
  expect(filled).toMatchObject({ user: "alice", pw: "s3cret", submitted: false });
  expect(filled.events).toEqual(expect.arrayContaining(["user=alice", "pw=s3cret"]));
  expect(await send(popup, { type: "fillInTab", tabId, entryId: quark.seed.github })).toMatchObject({ ok: false, error: { kind: "refused" } });

  await page.reload();
  await page.bringToFront();
  await page.waitForFunction(() => document.body.lastElementChild?.tagName === "DIV", { timeout: 15_000 });
  await clickInlineButton(page, page, "#pw");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (document.getElementById("pw") as HTMLInputElement).value === "s3cret", { timeout: 10_000 });
  expect(await value(page, "#user")).toBe("alice");
});

// Firefox has no location.ancestorOrigins, so a frame learns the top page's URL
// from the background, which reads it from the tab (#19).
test("fills a login in a same-site frame and refuses a cross-site one", async ({ firefox, popup, quark, site }) => {
  await signInAndUnlock(popup, quark);
  const pick = async (url: string) => {
    const page = await firefox.newPage();
    await page.goto(url);
    await page.bringToFront();
    const frame = await frameOf(page, "#login");
    if (frame === null) throw new Error("no login frame");
    await frame.waitForFunction(() => document.querySelector("body > div") !== null, { timeout: 15_000 });
    await clickInlineButton(page, frame, "#pw");
    await page.keyboard.press("Enter");
    return { page, frame };
  };

  const same = await pick(`${site}/framed`);
  await same.frame.waitForFunction(() => (document.getElementById("pw") as HTMLInputElement).value === "s3cret", { timeout: 10_000 });
  expect(await value(same.frame, "#user")).toBe("alice");

  const cross = await pick(`${site.replace("localhost", "127.0.0.1")}/cross`);
  // Give a fill that shouldn't happen the time one would take.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(await value(cross.frame, "#user")).toBe("");
  expect(await value(cross.frame, "#pw")).toBe("");
});
