import type { CDPSession, Frame, Page } from "@playwright/test";
import { clickInlineButton, expect, signInAndUnlock, test, type Quark } from "./fixtures.ts";

// Three more logins for the test site, so the picker has four rows, as in #117 and #118. The worker caches the
// entry list, so it is unlocked again to see them. The vault is put back as the seed left it.
const relock = async (popup: Page, quark: Quark) => {
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
  expect(await popup.evaluate((masterPassword) => chrome.runtime.sendMessage({ type: "unlock", masterPassword }), quark.seed.masterPassword)).toMatchObject({
    ok: true,
  });
};

const withMoreLogins = async (popup: Page, quark: Quark, site: string, run: () => Promise<void>) => {
  const token = await quark.api.login(quark.seed.owner.username, quark.seed.owner.password);
  const added: number[] = [];
  try {
    for (const name of ["Second", "Third", "Fourth"]) {
      const entry = await quark.api.expectOk<{ id: number }>(
        quark.api.call("POST", "/vault/entries", { name, url: site, username: name.toLowerCase(), password: `${name}-pw` }, token),
        "POST /vault/entries",
      );
      added.push(entry.id);
    }
    await relock(popup, quark);
    await run();
  } finally {
    await relock(popup, quark);
    for (const id of added) await quark.api.call("DELETE", `/vault/entries/${id}`, undefined, token);
  }
};

type Node = { nodeId: number; attributes?: string[]; children?: Node[]; shadowRoots?: Node[]; contentDocument?: Node };

// Every node in the frame, closed shadow roots included, as DevTools sees them. The page can't do this.
const nodes = (node: Node): Node[] => [
  node,
  ...[...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])].flatMap(nodes),
];

const attribute = (node: Node, name: string): string | undefined => {
  const at = node.attributes?.indexOf(name) ?? -1;
  return at < 0 ? undefined : node.attributes?.[at + 1];
};

type Geometry = { top: number; bottom: number; scrollHeight: number; clientHeight: number; text: string; viewport: number };

// A cross-site frame runs in its own process with its own CDP session; a same-site one is in the page's.
const session = async (page: Page, frame: Frame): Promise<CDPSession> =>
  page.context().newCDPSession(frame).catch(() => page.context().newCDPSession(page));

// Where an element of the picker inside the frame is, in the frame's viewport.
const geometry = async (cdp: CDPSession, match: (node: Node) => boolean): Promise<Geometry> => {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const found = nodes(root as Node).find(match);
  if (found === undefined) throw new Error("picker element not found");
  const { object } = await cdp.send("DOM.resolveNode", { nodeId: found.nodeId });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId!,
    returnByValue: true,
    functionDeclaration: `function () {
      const box = this.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, scrollHeight: this.scrollHeight, clientHeight: this.clientHeight,
        text: this.textContent, viewport: this.ownerDocument.documentElement.clientHeight };
    }`,
  });
  return result.value as Geometry;
};

const panel = (node: Node) => attribute(node, "class") === "panel";

const openFramedPicker = async (page: Page, url: string) => {
  await page.goto(url);
  const frame = page.frameLocator("#login");
  await expect.poll(() => frame.locator("body > div").count(), { message: "the inline button in the frame" }).toBeGreaterThan(0);
  await clickInlineButton(page, await frame.locator("#pw").boundingBox());
  const inner = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (inner === undefined) throw new Error("no login frame");
  const cdp = await session(page, inner);
  await expect.poll(async () => (await geometry(cdp, panel).catch(() => null)) !== null, { message: "the open picker" }).toBe(true);
  return { frame, cdp };
};

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// A same-site frame showed the picker as a scroll box with two of its four rows (#117).
test("shows every row of the picker in a same-site frame without scrolling", async ({ context, popup, quark, site }) => {
  await withMoreLogins(popup, quark, site, async () => {
    const page = await context.newPage();
    const { cdp } = await openFramedPicker(page, `${site}/framed`);
    const box = await geometry(cdp, panel);
    expect(box.scrollHeight, "the panel doesn't scroll").toBeLessThanOrEqual(box.clientHeight + 1);
    expect(box.text).toContain("Fourth");
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.viewport);
  });
});

// Picking a login in a cross-site frame filled nothing and seemed to do nothing (#118). The refusal stays, and the
// picker says why where the user can see it.
test("says why it won't fill a cross-site frame, where the user can see it", async ({ context, popup, quark, site }) => {
  await withMoreLogins(popup, quark, site, async () => {
    const page = await context.newPage();
    const { frame, cdp } = await openFramedPicker(page, `${site.replace("localhost", "127.0.0.1")}/cross`);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    const alert = (node: Node) => attribute(node, "role") === "alert";
    await expect.poll(async () => (await geometry(cdp, alert).catch(() => null))?.text ?? "", { message: "the refusal" }).toBe(
      "This login form is embedded in 127.0.0.1, so Quark Vault won't fill it.",
    );
    const [message, box] = [await geometry(cdp, alert), await geometry(cdp, panel)];
    expect(message.top, "inside the panel's visible part").toBeGreaterThanOrEqual(box.top);
    expect(message.bottom).toBeLessThanOrEqual(box.top + box.clientHeight + 2);
    expect(message.bottom, "inside the frame").toBeLessThanOrEqual(message.viewport);
    await expect(frame.locator("#user")).toHaveValue("");
    await expect(frame.locator("#pw")).toHaveValue("");
  });
});
