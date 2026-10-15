// @vitest-environment node
import config from "../wxt.config";
import { enMessages } from "./fakeChrome";

const manifestFor = async (browser: string) => {
  const { manifest } = config;
  if (typeof manifest !== "function") throw new Error("manifest should depend on the browser");
  return manifest({ browser, manifestVersion: 3, mode: "production", command: "build" });
};

describe("manifest", () => {
  it("keeps the permission set and CSP in every browser", async () => {
    for (const browser of ["chrome", "firefox", "edge"]) {
      const manifest = await manifestFor(browser);
      expect(manifest.permissions).toEqual(["storage", "activeTab", "idle", "contextMenus"]);
      expect(manifest.optional_permissions).toEqual(["privacy", "management"]);
      expect(manifest.content_security_policy).toEqual({
        extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
      });
    }
  });

  it("leaves the version to WXT, which reads it from package.json", async () => {
    for (const browser of ["chrome", "firefox", "edge"]) {
      expect((await manifestFor(browser)).version).toBeUndefined();
    }
  });

  it("adds the Firefox-only keys to Firefox alone", async () => {
    const firefox = await manifestFor("firefox");
    expect(firefox.host_permissions).toEqual(["https://*/*", "http://*/*"]);
    expect(firefox.browser_specific_settings?.gecko).toEqual({
      id: "vault@autobutler.org",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    });
    expect(firefox.browser_specific_settings?.gecko_android).toEqual({
      strict_min_version: "142.0",
    });
    expect(firefox.minimum_chrome_version).toBeUndefined();

    const chrome = await manifestFor("chrome");
    expect(chrome.host_permissions).toBeUndefined();
    expect(chrome.browser_specific_settings).toBeUndefined();
    expect(chrome.minimum_chrome_version).toBe("116");
  });

  it("reads its name, description and command from the English messages in every browser", async () => {
    for (const browser of ["chrome", "firefox", "edge"]) {
      const manifest = await manifestFor(browser);
      expect(manifest.default_locale).toBe("en");
      expect(manifest.name).toBe("__MSG_extName__");
      expect(manifest.description).toBe("__MSG_extDescription__");
      expect(manifest.action?.default_title).toBe("__MSG_extName__");
      expect(manifest.commands?.["fill-login"]?.description).toBe("__MSG_commandFillLogin__");
    }
    expect(enMessages["extName"]?.message).toBe("Quark Vault");
    expect(enMessages["extDescription"]?.message).toBe("Fill logins from the password vault on your Quark.");
    expect(enMessages["commandFillLogin"]?.message).toBe("Fill a login from Quark Vault");
  });

  it("keeps the toolbar tooltip on the localized name after WXT copies in the popup's title", () => {
    type Hook = (wxt: Readonly<{ config: Readonly<{ browser: string }> }>, manifest: chrome.runtime.ManifestV3) => void;
    const hook = (config.hooks as Record<string, Hook | undefined> | undefined)?.["build:manifestGenerated"];
    if (hook === undefined) throw new Error("expected a build:manifestGenerated hook");
    for (const browser of ["chrome", "firefox"]) {
      const manifest = { manifest_version: 3, action: { default_title: "Quark Vault" } } as chrome.runtime.ManifestV3;
      hook({ config: { browser } }, manifest);
      expect(manifest.action?.default_title).toBe("__MSG_extName__");
    }
  });
});

