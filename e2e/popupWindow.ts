import type { BrowserContext, Page, Worker } from "@playwright/test";
import { expect } from "./fixtures.ts";

// The real toolbar popup, which Chrome sizes from its content (#135), unlike popup.html opened as a tab at a size
// the test picks. Playwright doesn't list action popups as pages, so this reaches it over CDP through `via`.
export type PopupWindow = Readonly<{
  // Runs an expression in the popup and returns its value; undefined once the popup has closed.
  evaluate: <T>(expression: string) => Promise<T>;
  isOpen: () => Promise<boolean>;
}>;

export const openActionPopup = async (context: BrowserContext, worker: Worker, via: Page): Promise<PopupWindow> => {
  await via.bringToFront();
  const cdp = await context.newCDPSession(via);
  const popupTarget = async () => (await cdp.send("Target.getTargets")).targetInfos.find((target) => target.url.endsWith("/popup.html"));
  await worker.evaluate(() => chrome.action.openPopup());
  let targetId = "";
  await expect.poll(async () => (targetId = (await popupTarget())?.targetId ?? ""), { message: "the action popup never opened" }).not.toBe("");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: false });
  let next = 0;
  const evaluate = <T>(expression: string) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      const onMessage = ({ message }: { message: string }) => {
        const reply = JSON.parse(message) as { id?: number; result?: { result?: { value?: T }; exceptionDetails?: unknown }; error?: unknown };
        if (reply.id !== id) return;
        cdp.off("Target.receivedMessageFromTarget", onMessage);
        if (reply.error !== undefined || reply.result?.exceptionDetails !== undefined) {
          reject(new Error(`popup: ${JSON.stringify(reply.error ?? reply.result?.exceptionDetails)}`));
        } else {
          resolve(reply.result?.result?.value as T);
        }
      };
      cdp.on("Target.receivedMessageFromTarget", onMessage);
      const params = { expression, returnByValue: true, awaitPromise: true };
      cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method: "Runtime.evaluate", params }) }).catch(reject);
    });
  await expect.poll(() => evaluate<string>("document.readyState")).toBe("complete");
  return { evaluate, isOpen: async () => (await popupTarget()) !== undefined };
};
