// @vitest-environment node

import type { Page } from "puppeteer-core";
import { describe, expect, test, vi } from "vitest";
import { openExtensionPage, origin } from "./fixtures.ts";

describe("Firefox extension page navigation", () => {
  test("retries a transient BiDi evaluation failure while the extension realm loads", async () => {
    const url = `${origin}/popup.html`;
    const evaluate = vi.fn().mockRejectedValueOnce(new Error("Protocol error (script.evaluate): got null")).mockResolvedValue(`${url}\ncomplete`);
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate,
      waitForFunction: vi.fn().mockRejectedValue(new Error("Protocol error (script.evaluate): got null")),
    } as unknown as Page;

    await expect(openExtensionPage(page, "popup.html")).resolves.toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
