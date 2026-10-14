import { t } from "./i18n";

export type Browser = "chrome" | "firefox";

export const browserFromUrl = (extensionUrl: string): Browser =>
  extensionUrl.startsWith("moz-extension:") ? "firefox" : "chrome";

export const currentBrowser = (): Browser => browserFromUrl(chrome.runtime.getURL(""));

export const siteOrigins = ["https://*/*", "http://*/*"] as const;

export type BrowserCopy = Readonly<{
  builtInManager: string;
  builtInOn: string;
  builtInManaged: string;
  builtInOff: string;
  extensionsPage: string;
  settingsPage: string;
  canDisableOthers: boolean;
}>;

// Only the built-in manager's name and the browser's own pages differ; the rest of the copy names neither browser.
export const browserCopy = (browser: Browser): BrowserCopy => ({
  builtInOn: t("builtInOn"),
  builtInManaged: t("builtInManaged"),
  builtInOff: t("builtInOff"),
  ...(browser === "firefox"
    ? {
        builtInManager: t("builtInManagerFirefox"),
        extensionsPage: "about:addons",
        settingsPage: "about:preferences#privacy",
        canDisableOthers: false,
      }
    : {
        builtInManager: t("builtInManagerChrome"),
        extensionsPage: "chrome://extensions",
        settingsPage: "chrome://settings",
        canDisableOthers: true,
      }),
});
