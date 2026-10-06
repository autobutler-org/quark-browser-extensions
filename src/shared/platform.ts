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
  canDisableOthers: boolean;
}>;

export const browserCopy = (browser: Browser): BrowserCopy =>
  browser === "firefox"
    ? {
        builtInManager: "Firefox Password Manager",
        builtInOn: "Firefox is still offering to save passwords.",
        builtInManaged: "Firefox's password saving is set by your organization or another add-on.",
        builtInOff: "Firefox's password saving is off.",
        extensionsPage: "about:addons",
        canDisableOthers: false,
      }
    : {
        builtInManager: "Google Password Manager",
        builtInOn: "Chrome is still offering to save passwords.",
        builtInManaged: "Chrome's password saving is set by your organization or another extension.",
        builtInOff: "Chrome's password saving is off.",
        extensionsPage: "chrome://extensions",
        canDisableOthers: true,
      };
