# Notes for AMO reviewers

Paste the block below into "Notes to Reviewer" on the first submission. Later
versions go through `.github/workflows/release.yml`, which sends
`.github/amo-metadata.json` as the approval notes and uploads
`quark-vault-sources.zip` each time; keep that file's build steps in step with
these.

---

**What it is.** Quark Vault fills website logins from the password vault on the
user's own self-hosted Quark server (https://github.com/autobutler-org/quark).
It talks only to the Quark address the user types into the popup. It has no
analytics or telemetry and loads no remote code.

**Source.** The sources zip is the repository
(https://github.com/autobutler-org/quark-browser-extensions) at the release tag.
The add-on is TypeScript, bundled and minified by WXT 0.21 (Vite). Every
JavaScript file in the package comes out of that build; none is written or
minified by hand.

**Build from source.** Linux, macOS or Windows, with Node.js 22 and its npm.

```sh
unzip quark-vault-sources.zip -d quark-vault && cd quark-vault
npm ci                      # exact versions from package-lock.json
npx wxt zip -b firefox      # or: npm run build:firefox for the unpacked build only
```

That writes the add-on to `.output/quark-vault-firefox.zip` and the unpacked
build to `.output/firefox-mv3/`. Its files should match the submitted package.
The build settings, including the manifest, are in `wxt.config.ts`; the
entrypoints are in `entrypoints/` and the code in `src/`.

**Why WXT.** WXT builds the MV3 manifest for each browser from one config
(`wxt.config.ts`) and bundles each entrypoint (background script, content script,
popup, options) with Vite. Firefox gets `background.scripts` instead of a service
worker, `options_ui`, the gecko id and `host_permissions`; the JavaScript is the
same as Chrome's. The content script is one IIFE file. The package has no
sourcemaps.

**Why a pure-JavaScript Argon2.** Quark v0.47.0+ normally receives an auth key,
not the account password: Argon2id(password, salt, t=3, m=64 MiB, p=1) then
HKDF-SHA256 with info "auth", exactly as the Quark app derives it
(`src/shared/deriveAuthKey.ts`). An account the Quark marks legacy needs the
password beside the key for an upgrade attempt. The add-on asks for an explicit,
single-use consent that expires after five minutes, refuses the password over
non-loopback plain HTTP, and refuses it after that account has signed in with a
key. The add-on computes the key with `@noble/hashes`, a dependency-free,
audited, pure-JavaScript library, rather than a WebAssembly build of Argon2.
WebAssembly would need `'wasm-unsafe-eval'` in the extension pages' content
security policy and ship a binary reviewers can't read. With pure JS the policy
stays `script-src 'self'; object-src 'none'; base-uri 'none'` and every line that
touches the password is readable in the sources. It runs in the background
script only, on sign-in.

**Permissions.**
- `storage`: settings, the never-save site list, and the session token (in
  `storage.session`; with "Stay signed in", an AES-GCM ciphertext in
  `storage.local` whose non-extractable key is in the add-on's IndexedDB). A
  single-use legacy-upgrade consent is also kept in `storage.session`; hashes
  of accounts already using auth keys are kept in IndexedDB.
- `activeTab`: the popup, shortcut and context menu act on the current tab.
- `idle`: on Firefox, lock after the selected 5, 15 or 30 minutes idle because
  Firefox cannot report a screen lock. (Chrome locks on screen lock and has
  optional idle locking.)
- `contextMenus`: "Quark Vault › Fill …" and "Generate password" on editable
  fields; generation targets only the password field and frame the user chose.
- `privacy` (optional, asked on a click in the options page): read and turn off
  Firefox's own password saving.
- `management` (optional, asked on a click in the options page): list other
  password-manager add-ons. Firefox doesn't let it turn them off, so the page
  points to about:addons.
- `host_permissions` `http://*/*`, `https://*/*`, and the content script on the
  same pages: a password manager must find login fields on any site. The
  content script receives a password only after the background has checked the
  frame's browser-reported URL, scheme and port against the saved login. An
  optional submit runs only to the page's own site and never downgrades HTTPS
  to HTTP. If the user withholds website access, the popup offers an "Allow"
  button that requests it.

**Data collection.** The manifest declares `data_collection_permissions:
{ required: ["none"] }`. The add-on does send usernames, passwords, the vault
password and a session token, but only to the Quark server the user runs and
enters themselves, which is the add-on's entire purpose. Nothing reaches the
developer or any third party. If you consider the user's own server to be
collection, tell us and we'll declare `authenticationInfo` instead. The
minimum version is Firefox 140 on desktop and Firefox for Android 142, the first
releases that read this key.

**Testing it.** It needs a Quark server. The repository has an offline mock
of the Quark API that the end-to-end tests use. WXT leaves `*.spec.ts` files out
of the sources zip, so run these from a clone of the repository at the release
tag, after `npm ci`. `npm run firefox:install`
downloads Firefox stable into `e2e/.firefox`, then
`npm run test:e2e:firefox:mock` builds the add-on, seeds the mock with an
account, a vault and two logins, and drives Firefox through sign-in, unlock and
filling. To run against a real Quark instead, build one with
`QUARK_SRC=<checkout of autobutler-org/quark> scripts/build-quark.sh` (needs Go)
and run `npm run test:e2e:firefox`.

---

Before pasting, settle the data-collection question in
[permissions.md](permissions.md#firefox-data-collection), and drop the last two
sentences of "Data collection" if you switch to `authenticationInfo`.
