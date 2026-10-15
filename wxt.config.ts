import { defineConfig } from "wxt";

const icons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

export default defineConfig({
  publicDir: "static",
  manifestVersion: 3,
  // Keep the code in this repo explicit: no auto-imported WXT globals.
  imports: false,
  vite: ({ browser }) => ({
    build: { target: browser === "firefox" ? "firefox140" : "chrome116" },
  }),
  // The entrypoints add background, content_scripts, action.default_popup and options_ui.
  manifest: ({ browser }) => ({
    // __MSG_<key>__ reads static/_locales/<locale>/messages.json, like chrome.i18n.getMessage in the code.
    // No version here: WXT takes it from package.json.
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    default_locale: "en",
    ...(browser === "firefox" ? {} : { minimum_chrome_version: "116" }),
    icons,
    permissions: ["storage", "activeTab", "idle", "contextMenus"],
    optional_permissions: ["privacy", "management"],
    ...(browser === "firefox" ? { host_permissions: ["https://*/*", "http://*/*"] } : {}),
    action: {
      default_title: "__MSG_extName__",
      default_icon: { "16": icons["16"], "32": icons["32"] },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
    },
    commands: {
      "fill-login": {
        suggested_key: { default: "Ctrl+Shift+L", mac: "Command+Shift+L" },
        description: "__MSG_commandFillLogin__",
      },
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "vault@autobutler.org",
              strict_min_version: "140.0",
              data_collection_permissions: { required: ["none"] },
            },
            gecko_android: {
              strict_min_version: "142.0",
            },
          },
        }
      : {}),
  }),
  hooks: {
    "build:manifestGenerated": (wxt, manifest) => {
      // WXT copies the popup's <title> into default_title; the toolbar tooltip reads messages.json instead.
      if (manifest.manifest_version === 3 && manifest.action !== undefined) {
        manifest.action.default_title = "__MSG_extName__";
      }
      // Chrome opens the options page from options_page; WXT only writes options_ui.
      if (wxt.config.browser !== "firefox" && manifest.options_ui) {
        manifest.options_page = manifest.options_ui.page;
        delete manifest.options_ui;
      }
    },
  },
  zip: {
    artifactTemplate: "quark-vault-{{browser}}.zip",
    sourcesTemplate: "quark-vault-sources.zip",
  },
});
