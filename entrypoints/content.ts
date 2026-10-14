import { defineContentScript } from "wxt/utils/define-content-script";
import { siteOrigins } from "../src/shared/platform";
import { main } from "../src/content/index";

export default defineContentScript({
  matches: [...siteOrigins],
  runAt: "document_idle",
  allFrames: true,
  // WXT otherwise posts a "script started" message, carrying the extension ID, to the page.
  noScriptStartedPostMessage: true,
  main,
});
