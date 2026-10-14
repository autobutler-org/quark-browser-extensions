import type { Page } from "@playwright/test";
import { expect, openLoginPage, signInAndUnlock, test } from "./fixtures.ts";

const submitLogin = async (page: Page, popup: Page, tabId: number, username: string, password: string): Promise<unknown> => {
  await page.evaluate(
    ([u, p]) => {
      (document.getElementById("user") as HTMLInputElement).value = u!;
      (document.getElementById("pw") as HTMLInputElement).value = p!;
    },
    [username, password],
  );
  await page.click("button[type=submit]");
  // The worker hears about the submit from the content script asynchronously.
  await page.waitForTimeout(800);
  return popup.evaluate((id) => chrome.runtime.sendMessage({ type: "pendingOffer", tabId: id }), tabId);
};

test("offers to save a new login and to update a changed password", async ({ context, popup, quark, site, worker }) => {
  await signInAndUnlock(popup, quark);
  const token = await quark.api.login(quark.seed.owner.username, quark.seed.owner.password);
  const entry = (id: number) => quark.api.expectOk<Record<string, unknown>>(quark.api.call("GET", `/vault/entries/${id}`, undefined, token), "GET entry");
  const before = await entry(quark.seed.local);
  const { page, tabId } = await openLoginPage(context, worker, site);
  let savedId: number | undefined;

  try {
    expect(await submitLogin(page, popup, tabId, "alice", "s3cret"), "the saved password").toBeNull();
    expect(await submitLogin(page, popup, tabId, "bo!b", "hunter2"), "a submit the browser blocks").toBeNull();

    expect(await submitLogin(page, popup, tabId, "bob@example.com", "hunter2")).toMatchObject({ kind: "save", username: "bob@example.com" });
    expect(await page.locator("body > div").count(), "the save bar beside the inline button").toBeGreaterThanOrEqual(2);
    expect(await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "resolveSave", action: "save", tabId: id }), tabId)).toMatchObject({ ok: true });
    const list = await quark.api.expectOk<{ entries: { id: number }[] }>(
      quark.api.call("GET", "/vault/entries", undefined, token),
      "GET entries",
    );
    const added = list.entries.filter((e) => e.id !== quark.seed.local && e.id !== quark.seed.github);
    expect(added).toHaveLength(1);
    savedId = added[0]!.id;
    expect(await entry(savedId)).toMatchObject({ urlHost: "localhost", url: site, username: "bob@example.com", password: "hunter2" });

    expect(await submitLogin(page, popup, tabId, "alice", "n3w-pass")).toMatchObject({ kind: "update", entryId: quark.seed.local });
    expect(await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "resolveSave", action: "update", tabId: id }), tabId)).toMatchObject({ ok: true });
    const after = await entry(quark.seed.local);
    // Only the password changed: notes, the TOTP secret, the folder and the
    // custom fields all survived the PUT.
    const { password, updatedAt: _updatedAt, ...rest } = after;
    const { password: oldPassword, updatedAt: _oldUpdatedAt, ...restBefore } = before;
    expect(password).toBe("n3w-pass");
    expect(oldPassword).toBe("s3cret");
    expect(rest).toEqual(restBefore);
    expect(rest).toMatchObject({ notes: "keep me", folderId: quark.seed.folderId, customFields: [{ name: "pin", value: "1234", hidden: true }] });
  } finally {
    // Put the vault back as the seed left it for the tests that follow.
    if (savedId !== undefined) await quark.api.call("DELETE", `/vault/entries/${savedId}`, undefined, token);
    await quark.api.call("PUT", `/vault/entries/${quark.seed.local}`, before, token);
  }
});
