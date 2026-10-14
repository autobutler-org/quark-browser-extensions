import type { Page } from "@playwright/test";
import { clickInlineButton, expect, openLoginPage, signInAndUnlock, test } from "../fixtures.ts";
import { html, inlineButton, loginForm, loot, lootScript, seededLogin, serve, settle } from "./pages.ts";

test.beforeEach(async ({ popup, quark }) => {
  await signInAndUnlock(popup, quark);
});

// Page script: the inline buttons' hosts, the <div>s the content script appends to <body>.
const hostsScript = `<script>
window.hosts = () => [...document.body.children].filter((node) => node.localName === "div" && node.id === "");
</script>`;

// Opens the picker the way the keyboard shortcut does when it has more than one login to offer.
const openPicker = async (worker: import("@playwright/test").Worker, tabId: number) => {
  expect(await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: "openPicker" }, { frameId: 0 }), tabId)).toMatchObject({ ok: true });
};

// Everything in the page, closed shadow roots included, as DevTools sees it. The page can't do this.
const pierced = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  await cdp.detach();
  return JSON.stringify(root);
};

const values = (page: Page) => page.evaluate(() => ({ user: (document.getElementById("user") as HTMLInputElement).value, pw: (document.getElementById("pw") as HTMLInputElement).value }));

// Untrusted events at everything the page can reach of the inline button and its picker: the host,
// whatever is under the button's spot, and the focused element.
const syntheticPage = html(
  `<h1>Sign in</h1>${loginForm()}
<script>
const mouse = (target) => {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, view: window }));
  }
  target.click?.();
};
const keys = (target) => {
  for (const key of ["ArrowDown", "Enter", " "]) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key, code: key === " " ? "Space" : key, bubbles: true, composed: true, cancelable: true }));
    }
  }
};
window.attacks = 0;
setInterval(() => {
  const pw = document.getElementById("pw").getBoundingClientRect();
  const targets = [...hosts(), document.elementFromPoint(pw.right - 17, pw.top + pw.height / 2), document.activeElement].filter(Boolean);
  for (const target of targets) {
    mouse(target);
    keys(target);
  }
  window.attacks++;
}, 100);
</script>`,
  hostsScript,
);

test("synthetic clicks and keys on the inline button and the open picker fill nothing", async ({ context, quark, site, worker }) => {
  const login = await seededLogin(quark);
  const url = `${site}/hostile/synthetic`;
  await serve(context, url, syntheticPage);
  const { page, tabId } = await openLoginPage(context, worker, url);
  await inlineButton(page);
  await settle(page);
  expect(await values(page), "the closed picker").toEqual({ user: "", pw: "" });

  await openPicker(worker, tabId);
  await settle(page);
  expect(await page.evaluate(() => (window as unknown as { attacks: number }).attacks)).toBeGreaterThan(10);
  expect(await values(page), "the open picker").toEqual({ user: "", pw: "" });
  expect(await pierced(page), "the picker is still open").toContain(login.name);

  // The user's own Enter, a trusted key press, picks the login.
  await page.keyboard.press("Enter");
  await expect(page.locator("#pw")).toHaveValue(login.password);
  await expect(page.locator("#user")).toHaveValue(login.username);
});

// Page script that tries every way it has into the picker's shadow root. The patched attachShadow
// runs before the content script; it only replaces the page's own copy of the function.
const probePage = html(
  `<h1>Sign in</h1>${loginForm()}`,
  `${lootScript}${hostsScript}<script>
window.roots = [];
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (init) {
  const root = attach.call(this, { ...init, mode: "open" });
  window.roots.push(root);
  return root;
};
window.probe = () => {
  for (const root of window.roots) steal(root.innerHTML);
  for (const host of hosts()) {
    steal(host.shadowRoot?.innerHTML);
    steal(host.innerHTML);
    steal(host.outerHTML);
    steal(host.textContent);
    steal(host.innerText);
    steal(host.getHTML?.({ serializableShadowRoots: true }));
    steal(globalThis.chrome?.dom?.openOrClosedShadowRoot?.(host)?.innerHTML);
    const box = host.getBoundingClientRect();
    for (const element of document.elementsFromPoint(box.left + 5, box.top + 40)) steal(element.textContent);
  }
  steal(document.activeElement?.shadowRoot?.innerHTML);
  steal(document.body.innerText);
  steal(document.documentElement.outerHTML);
  steal(document.documentElement.getHTML?.({ serializableShadowRoots: true }));
  const selection = getSelection();
  selection.selectAllChildren(document.body);
  steal(selection.toString());
  selection.removeAllRanges();
  return window.roots.length;
};
</script>`,
);

test("page script can't read the open picker through its shadow root host", async ({ context, quark, site, worker }) => {
  const login = await seededLogin(quark);
  const url = `${site}/hostile/probe`;
  await serve(context, url, probePage);
  const { page, tabId } = await openLoginPage(context, worker, url);
  await inlineButton(page);
  await openPicker(worker, tabId);
  expect(await pierced(page), "what there is to find").toContain(login.name);

  expect(await page.evaluate(() => (window as unknown as { probe: () => number }).probe()), "shadow roots the patched attachShadow saw").toBe(0);
  const stolen = await loot(page);
  expect(stolen).not.toContain(login.name);
  expect(stolen).not.toContain(login.username);
  expect(stolen).not.toContain(login.password);
});

// Page script that moves the password field as soon as the picker takes focus, so the user's pick
// lands in a field they can no longer see.
const movePage = (style: string) =>
  html(
    `<h1>Sign in</h1>${loginForm()}`,
    `${lootScript}${hostsScript}<script>
document.addEventListener("focusin", (event) => {
  if (!hosts().includes(event.target)) return;
  const pw = document.getElementById("pw");
  pw.setAttribute("style", ${JSON.stringify(style)});
  pw.addEventListener("input", () => steal(pw.value));
});
</script>`,
  );

const moves = {
  "off-screen": "position:absolute;left:-10000px;top:0",
  "under an opacity:0 style": "opacity:0;width:100%;height:32px",
} as const;

for (const [where, style] of Object.entries(moves)) {
  // Fails until #129 is fixed: the picker fills the field it opened on without checking it again.
  test.fail(`a password field moved ${where} after the picker opens isn't filled`, { annotation: { type: "issue", description: "https://github.com/autobutler-org/quark-browser-extensions/issues/129" } }, async ({ context, quark, site, worker }) => {
    const login = await seededLogin(quark);
    const url = `${site}/hostile/move`;
    await serve(context, url, movePage(style));
    const { page } = await openLoginPage(context, worker, url);
    await inlineButton(page);
    await clickInlineButton(page, await page.locator("#pw").boundingBox());
    await expect.poll(() => page.locator("#pw").getAttribute("style"), { message: "the page moved the field" }).toBe(style);
    await page.keyboard.press("Enter");
    await settle(page);
    expect(await loot(page)).not.toContain(login.password);
    await expect(page.locator("#pw")).toHaveValue("");
  });
}
