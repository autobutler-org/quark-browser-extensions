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
    build: { target: browser === "firefox" ? "firefox128" : "chrome116" },
  }),
  // The entrypoints add background, content_scripts, action.default_popup and options_ui.
  manifest: ({ browser }) => ({
    name: "Quark Vault",
    version: "0.1.0",
    description: "Fill logins from the password vault on your Quark.",
    ...(browser === "firefox" ? {} : { minimum_chrome_version: "116" }),
    icons,
    permissions: ["storage", "activeTab", "idle", "contextMenus"],
    optional_permissions: ["privacy", "management"],
    ...(browser === "firefox" ? { host_permissions: ["https://*/*", "http://*/*"] } : {}),
    action: {
      default_title: "Quark Vault",
      default_icon: { "16": icons["16"], "32": icons["32"] },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
    },
    commands: {
      "fill-login": {
        suggested_key: { default: "Ctrl+Shift+L", mac: "Command+Shift+L" },
        description: "Fill a login from Quark Vault",
      },
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "vault@autobutler.org",
              strict_min_version: "128.0",
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : {}),
  }),
  hooks: {
    // Chrome opens the options page from options_page; WXT only writes options_ui.
    "build:manifestGenerated": (wxt, manifest) => {
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
