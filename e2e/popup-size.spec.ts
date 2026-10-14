import { expect, signInAndUnlock, test } from "./fixtures.ts";
import { openActionPopup } from "./popupWindow.ts";

type Size = Readonly<{ body: number; scrollWidth: number; clientWidth: number }>;
const measure = "({ body: document.body.getBoundingClientRect().width, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })";

// Chrome sizes the action popup from its content. A width tied to the viewport is tiny while it measures, so the
// popup opened about 74px wide (#135); popup.html opened as a tab never showed it.
test("opens the toolbar popup at its full width (#135)", async ({ context, worker }) => {
  const page = await context.newPage();
  await page.goto("about:blank");
  const popup = await openActionPopup(context, worker, page);
  await expect.poll(() => popup.evaluate<boolean>("document.querySelector('h1') !== null")).toBe(true);
  const size = await popup.evaluate<Size>(measure);
  expect(size.body, "the popup's width").toBeGreaterThanOrEqual(340);
  expect(size.scrollWidth, "no sideways scrolling").toBeLessThanOrEqual(size.clientWidth);
});

// The popup opened as a tab (Firefox for Android, or a narrow window) fits the viewport instead (#108).
for (const width of [320, 300]) {
  test(`fits a ${width}px tab without scrolling sideways (#108)`, async ({ popup, quark }) => {
    await popup.setViewportSize({ width, height: 580 });
    const fits = async (screen: string) => {
      const size = await popup.evaluate<Size>(measure);
      expect(size.scrollWidth, screen).toBeLessThanOrEqual(size.clientWidth);
    };
    await expect(popup.getByRole("heading", { name: "Connect to your Quark" })).toBeVisible();
    await fits("connect");
    await signInAndUnlock(popup, quark);
    await fits("entries");
  });
}
