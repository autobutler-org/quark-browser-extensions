// @vitest-environment node
import config from "../wxt.config";

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

  it("adds the Firefox-only keys to Firefox alone", async () => {
    const firefox = await manifestFor("firefox");
    expect(firefox.host_permissions).toEqual(["https://*/*", "http://*/*"]);
    expect(firefox.browser_specific_settings?.gecko).toEqual({
      id: "vault@autobutler.org",
      strict_min_version: "128.0",
      data_collection_permissions: { required: ["none"] },
    });
    expect(firefox.minimum_chrome_version).toBeUndefined();

    const chrome = await manifestFor("chrome");
    expect(chrome.host_permissions).toBeUndefined();
    expect(chrome.browser_specific_settings).toBeUndefined();
    expect(chrome.minimum_chrome_version).toBe("116");
  });
});
