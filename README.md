# Quark Vault

A Manifest V3 extension for Chrome and Firefox (Edge builds too) that fills logins from the password vault on your [Quark](https://github.com/autobutler-org/quark).
It talks to the Quark's existing API. Nothing extra runs on the Quark.

## What it does

- **Connect**: sign in once with a Quark admin account. The extension gets an ordinary session token, so it shows up
  in the Quark under Settings › Sessions and can be revoked there.
- **Unlock**: type the vault password in the popup. Unlocking is server-side and household-wide, the same as unlocking
  in the Quark app, and the Quark locks it on its own schedule. The options page can also lock it when the computer is idle. On Chrome, it locks when the screen locks; on Firefox, after the idle time elapses.
- **Fill**: on a page with a password field, a Quark button appears in the field when the vault has a login for that
  site. The toolbar icon shows how many. Pick one, or press **Fill** in the popup. From the keyboard, Tab from the field
  reaches the button, and **Alt+↓** in the field opens the picker; Enter, Space or ↓ on the button opens it, and Esc
  closes it and returns to the field.
- **Shortcut and right-click**: `Ctrl+Shift+L` (`⌘⇧L` on macOS) fills the only match or opens the picker; right-click a field
  for **Quark Vault › Fill …**. The browser skips the suggested keys when another extension already has them; the
  popup footer and options then say **Not set** and link to `chrome://extensions/shortcuts` (in Firefox:
  `about:addons` › gear › **Manage Extension Shortcuts**).
- **One-time codes**: fields like "Enter verification code" (or a row of six digit boxes) get the same button when
  the entry has a TOTP secret. The secret stays in the service worker; only the code reaches the page.
- **Sign-up forms**: new-password fields get **Suggest strong password**, which fills the field and its
  confirmation, sized to the field's `maxlength`. Right-click › **Generate password** fills only the password
  field you are on, and only in the frame you clicked. A new-password field also gets its confirmation.
- **Save and update**: after you sign in somewhere, a bar offers to save the login, or to update the password when
  it changed. The captured password is held in memory for two minutes at most and never written anywhere else.
  **Never for this site** can be undone on the options page.
- **Copy and generate**: copy any entry's password from the popup, or generate a new one.
- **Other password managers**: offers to turn off Chrome's own password saving and extensions like Proton Pass or
  Bitwarden, so only one manager tries to fill each form.

## Security model

| Concern                  | How it is handled                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Account password         | Never sent: sign-in sends an auth key derived from it (Argon2id + HKDF, as the Quark app does) with the salt from `GET /api/v0/auth/salt`. An account the Quark marks `legacy` gets the password beside the key once, after you confirm, and never over non-loopback http. See [docs/legacy-upgrade.md](docs/legacy-upgrade.md). Needs Quark v0.47.0+ |
| Vault password           | Sent once to `POST /api/v0/vault/unlock`, never stored                                          |
| Session token            | `chrome.storage.session` (memory, gone when the browser quits). With "stay signed in" it is also encrypted at rest under a non-extractable key in IndexedDB, never stored in plaintext. See [docs/security.md](docs/security.md) |
| Decrypted entries        | Fetched one at a time on a click, passed straight to the page, never stored or cached          |
| Captured sign-ins        | Held in service-worker memory per tab for at most two minutes, then dropped                    |
| Which site gets a login  | Page host must equal the entry's host (ignoring `www.`) or be a subdomain of it within the same registrable domain. A public suffix (`co.uk`, `github.io`) is never a parent, and an IP address matches only itself. Checked in the worker and again in the page. A login inside an iframe fills only when the top page is that site too |
| Generated password       | Right-click **Generate password** sends it only to the frame you clicked, into the password field you are on, and its confirmation when that field is a new password. It is never broadcast to the other frames |
| Other sites              | The popup's **Fill anyway** needs a confirmation naming both hosts, then fills the top frame only, once, within ten seconds, and never auto-submits. The shortcut, context menu and inline picker have no such path |
| Plain `http://` pages    | Refused, unless the entry itself was saved with an `http://` URL (a router admin page, say). `localhost`, `127.0.0.1` and `[::1]` count as secure |
| Plain `http://` Quark    | Fine on loopback. Any other `http://` address needs an explicit "I understand" tick when connecting |
| Page scripts             | Can't message the extension; the picker lives in a closed shadow root                          |
| Permissions              | See [Permissions](#permissions) |

Listing entries (`GET /api/v0/vault/entries`) returns names and hosts only, so the match count works while the vault
is locked. More detail in [docs/security.md](docs/security.md).

## Permissions

From the built manifests (`.output/*/manifest.json`):

| Permission | Why |
| --- | --- |
| `storage` | Settings, the session token (`storage.session`) and the encrypted "stay signed in" copy. The Quark address is kept in IndexedDB, not here |
| `activeTab` | Reading the active tab's URL when you fill from the popup, shortcut or menu |
| `idle` | Locking the vault when the computer is idle (if you turn that on) or the screen locks (Chrome only; Firefox locks after idle time) |
| `contextMenus` | The right-click **Quark Vault** menu on editable fields |
| `privacy` (optional) | Asked for only when you turn off the browser's own password saving |
| `management` (optional) | Asked for only to list and turn off other password-manager extensions (Chrome) |
| Content script on `http://*/*` and `https://*/*` | Finds login fields and draws the in-field button. It never receives a password until the worker checks the frame |
| `host_permissions` for `http://*/*` and `https://*/*` (Firefox only) | Firefox doesn't grant them at install, so the popup offers **Allow** when they're off; Chrome doesn't need them |

The extension talks only to the Quark address you enter. The extension pages' content security policy is
`script-src 'self'; object-src 'none'; base-uri 'none'`.

## Install (sideload)

1. Download the `quark-vault-extension` artifact from the latest CI run, or run `npm ci && npm run package`, which
   writes the zips to `.output/`. (Store releases: [.github/RELEASING.md](.github/RELEASING.md).)
2. Unzip `quark-vault-chrome.zip`.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
4. Click the Quark Vault toolbar button and connect to your Quark (for example `https://quark.local`).

If your Quark uses a self-signed certificate, open its address in Chrome once and accept the certificate. The
extension can't reach a server Chrome doesn't trust.

## Firefox

`npm run package` also builds `quark-vault-firefox.zip` (Firefox 140+ desktop, Firefox for Android 142+) and `quark-vault-sources.zip`, the source
archive AMO asks for. To try it, run `npm run build:firefox`, open `about:debugging` › This Firefox › **Load Temporary
Add-on** and pick `.output/firefox-mv3/manifest.json`. Differences from Chrome:

- If Firefox hasn't granted access to websites, the popup shows **Allow** so the extension can fill logins there.
- The other-password-managers check can turn off Firefox's own password saving, but not other add-ons: Firefox
  doesn't allow that, so it points you to `about:addons`.
- Firefox lacks `location.ancestorOrigins`, so for a login inside a same-site iframe the frame checks the top page
  against `topUrl`, which the background got by asking the top frame (frame 0) itself and sent in the fill command,
  instead of asking the browser. Chrome keeps using `ancestorOrigins`. The background checks the frame and the top
  frame's URL before it hands out credentials either way.
- The background is a script, not a service worker. The add-on id is `vault@autobutler.org`, with no data collection.

CI lints the Firefox build with `web-ext lint` and runs a Firefox smoke test against a real Quark (see
[End-to-end tests](#end-to-end-tests)): connect with the auth key, unlock, match the test site, fill from the popup and
the in-field button, and fill a same-site iframe while refusing a cross-site one. Before a Firefox release, check the
rest by hand: a one-time code, saving a new login, and the shortcut.

## Develop

```sh
npm ci
npm run dev            # WXT dev mode: builds .output/chrome-mv3-dev, opens Chrome with it loaded, reloads on change
npm run dev:firefox    # the same in Firefox
npm run build          # production builds in .output/chrome-mv3 and .output/firefox-mv3
npm run check          # typecheck + lint + unit tests
npm run lint           # ESLint alone (type-aware typescript-eslint, eslint.config.js)
QUARK_SRC=~/src/quark npm run test:e2e:quark   # builds that Quark checkout, then runs the e2e tests against it
npm run coverage       # unit tests with coverage floors on src/background and src/shared (vitest.config.ts)
```

The build is [WXT](https://wxt.dev) (`wxt.config.ts`); `npx wxt build -b edge` also works. `npm run check` runs
`typecheck` (`tsc` for `src` and `e2e`), `lint`, the vitest unit tests in `test/` and `test:scripts` (the release
script's tests). `npm run lint:firefox` builds Firefox and runs `web-ext lint` on it.

To lint before each commit, install [pre-commit](https://pre-commit.com) and run `pre-commit install` once: it runs
ESLint on the staged files with the repo's own `node_modules` (`npm ci` first; see `.pre-commit-config.yaml`). There
is no husky.

### End-to-end tests

The e2e tests in `e2e/` use [Playwright](https://playwright.dev/docs/chrome-extensions): each test launches Chromium
with `.output/chrome-mv3` loaded in a fresh profile and drives the popup, the options page and test web pages. They
run against a real Quark: `e2e/global-setup.ts` starts `quark serve --insecure` in a throwaway `HOME`, creates the
owner and the vault through the API the way the Quark app does, and seeds a folder, two entries and a legacy account
(one from before auth keys). The tests cover sign-in with the auth key (salt, then key, never the password), the
legacy account's one-time upgrade, unlocking, the entry list, filling (popup, inline picker, shortcut, frames,
one-time codes, sign-up forms), saving and updating, locking and signing out. A proxy in front of the Quark records
what the extension sent, so a test can check what went over the wire.

```sh
npx playwright install chromium                    # once: the Chromium the tests drive
QUARK_SRC=~/src/quark npm run test:e2e:quark       # build the Go server from a quark checkout, then run the tests
npm run test:e2e                                   # run again with the Quark already built in e2e/.quark/quark
QUARK_BIN=/path/to/quark npm run test:e2e          # or with a quark binary from somewhere else
QUARK_SRC=~/src/quark QUARK_WEB=1 npm run test:e2e:quark  # with Quark's Flutter web app too, so e2e/quark-login.spec.ts fills its /login
npm run test:e2e:mock                              # offline, against the mock Quark in e2e/support/mock-quark.ts
```

`scripts/build-quark.sh` needs Go (the version the checkout's `go.mod` names; `GOTOOLCHAIN=auto` fetches it) and no
Flutter: the server is built without its web app. The mock is a fallback for working offline. It follows the real
server where the extension depends on it, refusing a password-only sign-in with 426 among other things, and CI runs
the same tests against both so it stays honest. `CHROME_PATH` points the tests at another Chromium or Chrome for
Testing (branded Chrome ignores `--load-extension`). Failures leave a trace and screenshots in `e2e/test-results/`,
an HTML report in `e2e/playwright-report/`, and the Quark's log in `e2e/.quark/serve.log`; open a trace with
`npx playwright show-trace`. The servers take free ports; `E2E_QUARK_PORT`, `E2E_API_PORT` (the proxy) and
`E2E_SITE_PORT` pin them.

#### Firefox

Playwright's Firefox can't load add-ons, so `e2e/firefox/` drives a stock Firefox with
[Puppeteer](https://pptr.dev/webdriver-bidi) over WebDriver BiDi instead: each test launches Firefox with a
fresh profile, installs `.output/firefox-mv3` as a temporary add-on (BiDi's `webExtension.install`), and opens the
popup as a tab. Playwright Test still runs the tests, with the same `e2e/global-setup.ts`, so they get the same Quark
(real or mock), proxy, seed and test site. Two Firefox settings make it work: `--remote-allow-system-access` lets BiDi
open `moz-extension://` pages, and the `extensions.webextensions.uuids` pref pins the add-on's random
`moz-extension://` host. The smoke test covers sign-in with the auth key, unlocking, the site's match and badge,
filling from the popup and the inline picker (and refusing another site's login), and a same-site iframe fill, which
in Firefox depends on the top page's URL from the background, since it lacks `location.ancestorOrigins`; a
cross-site frame is refused.

```sh
npm run firefox:install                            # once: Firefox stable into e2e/.firefox
npm run test:e2e:firefox                           # against the Quark in e2e/.quark/quark (QUARK_BIN works too)
npm run test:e2e:firefox:mock                      # offline, against the mock Quark
FIREFOX_PATH=/usr/bin/firefox npm run test:e2e:firefox   # or a Firefox of your own (a recent one; CI uses stable)
```

`HEADED=1` shows the browser. Failures leave the report in `e2e/playwright-report/firefox/`. CI's `firefox-e2e` job
runs it against the real Quark; it isn't a required check yet.

CI builds Quark from autobutler-org/quark at the commit `QUARK_REF` names in `.github/workflows/check.yml` (the
`e2e` and `firefox-e2e` jobs); set the repository variable `QUARK_REF` to test another commit, branch or tag.

```text
src/background/   service worker: holds the token, calls the Quark, answers the popup and pages
src/content/      finds login forms, draws the inline picker, fills fields
src/popup/        toolbar popup: connect, unlock, entries
src/options/      settings and the other-password-managers check
src/shared/       API client, host matching, message types, error copy
entrypoints/      WXT entrypoints: background, content script, popup and options pages
static/           CSS, icons and _locales/en/messages.json, copied as-is (the manifest is in wxt.config.ts)
e2e/              Playwright tests; support/ starts the Quark (real or mock), the proxy and the test site;
                  firefox/ holds the Firefox smoke test
scripts/          build-quark.sh (builds the Quark server the e2e tests run against) and release.js (CI helpers)
test/             vitest unit tests (jsdom)
docs/             security.md, legacy-upgrade.md
.github/          CI (check.yml), the release workflow and RELEASING.md
```

## Contributing

1. Set up: Node 22, `npm ci`, then `npm run dev` (Chrome, reloads on change) or `npm run dev:firefox`. Optionally
   `pre-commit install`.
2. Before a pull request, run `npm run check`. CI runs it plus `npm run lint:firefox`, `npm run package` and the e2e jobs.
3. End-to-end: `npx playwright install chromium`, then `QUARK_SRC=<quark checkout> npm run test:e2e:quark` for a real
   Quark (needs Go), or `npm run test:e2e:mock` offline. Firefox: `npm run firefox:install`, then
   `npm run test:e2e:firefox`.
4. Adding a string: add the key to `static/_locales/en/messages.json` (with `placeholders` if it takes arguments),
   list it and its placeholder names in `messagePlaceholders` in `src/shared/i18n.ts`, and use `t("key", …)`.
   `test/i18n.test.ts` checks that the two lists and the code agree.
5. Releasing: see [.github/RELEASING.md](.github/RELEASING.md). The version comes from `package.json`.

MIT-0 licensed (`LICENSE`).

## Not yet

- Safari
- Importing from other managers happens on the Quark: autobutler-org/quark#2543
