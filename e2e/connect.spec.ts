import { connect, expect, signInAndUnlock, storedConnection, test } from "./fixtures.ts";

const logins = (wire: { method: string; path: string; body: any }[]) =>
  wire.filter((request) => request.method === "POST" && request.path === "/api/v0/auth/login").map((request) => request.body);

test("the Quark refuses a password-only sign-in with 426", async ({ quark }) => {
  // The contract the mock has to keep with the real server (quark#2430).
  const { owner } = quark.seed;
  const login = await quark.api.call("POST", "/auth/login", { username: owner.username, password: owner.password });
  expect(login.status).toBe(426);
  const setup = await quark.api.call("POST", "/auth/setup", { username: "someone", password: "pw" });
  expect(setup.status).toBe(426);
});

test("signs in with the auth key, never the password, and keeps the token in session storage", async ({ popup, quark, worker }) => {
  await quark.clearWire();
  await connect(popup, quark, { username: quark.seed.owner.username, password: "wrong" });
  await expect(popup.getByText("Invalid username or password.")).toBeVisible({ timeout: 30_000 });

  await connect(popup, quark, quark.seed.owner);
  await expect(popup.getByRole("heading", { name: "Vault is locked" })).toBeVisible({ timeout: 30_000 });

  const wire = await quark.wire();
  expect(wire.map((request) => `${request.method} ${request.path}`)).toContain(
    `GET /api/v0/auth/salt?username=${quark.seed.owner.username}`,
  );
  const sent = logins(wire);
  expect(sent).toHaveLength(2);
  for (const body of sent) {
    expect(Object.keys(body).sort()).toEqual(["authKey", "username"]);
  }

  const stored = await storedConnection(worker);
  expect(stored.local).toBeUndefined();
  expect(stored.session?.server).toBe(quark.server);
  const status = await quark.api.call("GET", "/vault/status", undefined, stored.session!.token);
  expect(status.status).toBe(200);
});

test("a legacy account sends its password beside the key once, which moves it to keys", async ({ popup, quark }) => {
  const { legacy } = quark.seed;
  expect((await quark.api.salt(legacy.username)).legacy).toBe(true);
  await quark.clearWire();

  await connect(popup, quark, legacy);
  await expect(popup.getByRole("heading", { name: "Vault is locked" }).or(popup.getByText(/^All entries/))).toBeVisible({
    timeout: 30_000,
  });

  const [upgrade] = logins(await quark.wire());
  expect(Object.keys(upgrade).sort()).toEqual(["authKey", "password", "username"]);
  expect((await quark.api.salt(legacy.username)).legacy).toBe(false);
  // The key alone signs it in from now on, and the password alone is refused.
  await quark.api.login(legacy.username, legacy.password);
  expect((await quark.api.call("POST", "/auth/login", legacy)).status).toBe(426);
});

test("unlocks the vault and lists its entries; the master password is never stored", async ({ popup, quark, worker }) => {
  await quark.api.expectOk(
    quark.api.login(quark.seed.owner.username, quark.seed.owner.password).then((token) => quark.api.call("POST", "/vault/lock", undefined, token)),
    "lock the vault",
  );
  await connect(popup, quark, quark.seed.owner);
  await expect(popup.getByRole("heading", { name: "Vault is locked" })).toBeVisible({ timeout: 30_000 });

  await popup.fill("#master", "not the master password");
  await popup.click("button[type=submit]");
  await expect(popup.getByText("That password didn't unlock the vault.")).toBeVisible();

  await popup.fill("#master", quark.seed.masterPassword);
  await popup.click("button[type=submit]");
  await expect(popup.getByText("All entries · 2")).toBeVisible();
  await expect(popup.getByText("Local Test", { exact: true })).toBeVisible();
  await expect(popup.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(popup.getByText("may also try to fill logins")).toBeVisible();

  const everything = await worker.evaluate(async () => ({
    session: await chrome.storage.session.get(null),
    local: await chrome.storage.local.get(null),
  }));
  expect(JSON.stringify(everything)).not.toContain(quark.seed.masterPassword);
});

test("signing out ends the session on the Quark and forgets the token", async ({ context, extensionId, popup, quark, worker }) => {
  await signInAndUnlock(popup, quark);
  const { token } = (await storedConnection(worker)).session!;
  await quark.clearWire();

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole("button", { name: "Sign out" }).click();

  await expect.poll(async () => (await quark.wire()).map((request) => `${request.method} ${request.path}`)).toContain(
    "POST /api/v0/auth/logout",
  );
  await expect.poll(() => storedConnection(worker)).toEqual({ session: undefined, local: undefined });
  expect((await quark.api.call("GET", "/vault/status", undefined, token)).status).toBe(401);
  await popup.reload();
  await expect(popup.getByRole("heading", { name: "Connect to your Quark" })).toBeVisible();
});
