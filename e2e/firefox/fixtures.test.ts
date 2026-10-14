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

  test("abandons an evaluation that never settles and polls again", async () => {
    const url = `${origin}/popup.html`;
    // A realm torn down mid-evaluate can leave the BiDi call unanswered.
    const evaluate = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(`${url}\ncomplete`);
    const page = { goto: vi.fn().mockResolvedValue(undefined), evaluate } as unknown as Page;

    await expect(openExtensionPage(page, "popup.html")).resolves.toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(2);
  }, 5_000);

  test("fails at the deadline when every evaluation hangs", async () => {
    vi.useFakeTimers();
    try {
      const page = { goto: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn(() => new Promise(() => {})) } as unknown as Page;
      const opened = openExtensionPage(page, "popup.html");
      const outcome = expect(opened).rejects.toThrow(/did not finish loading/);
      await vi.advanceTimersByTimeAsync(16_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
