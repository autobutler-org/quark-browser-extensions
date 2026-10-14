# Quark Vault for Chrome

A Manifest V3 extension that fills logins from the password vault on your [Quark](https://github.com/autobutler-org/quark).
It talks to the Quark's existing API. Nothing extra runs on the Quark.

## What it does

- **Connect**: sign in once with a Quark admin account. The extension gets an ordinary session token, so it shows up
  in the Quark under Settings › Sessions and can be revoked there.
- **Unlock**: type the vault password in the popup. Unlocking is server-side and household-wide, the same as unlocking
  in the Quark app, and it auto-locks on the Quark's schedule.
- **Fill**: on a page with a password field, a Quark button appears in the field when the vault has a login for that
  site. The toolbar icon shows how many. Pick one, or press **Fill** in the popup.
- **Shortcut and right-click**: `Ctrl+Shift+L` (`⌘⇧L` on macOS) fills the only match or opens the picker; right-click a field
  for **Quark Vault › Fill …**. Rebind it at `chrome://extensions/shortcuts`.
- **One-time codes**: fields like "Enter verification code" (or a row of six digit boxes) get the same button when
  the entry has a TOTP secret. The secret stays in the service worker; only the code reaches the page.
- **Sign-up forms**: new-password fields get **Suggest strong password**, which fills the field and its
  confirmation, sized to the field's `maxlength`. Right-click › **Generate password** does the same anywhere.
- **Save and update**: after you sign in somewhere, a bar offers to save the login, or to update the password when
  it changed. The captured password is held in memory for two minutes at most and never written anywhere else.
  **Never for this site** can be undone on the options page.
- **Copy and generate**: copy any entry's password from the popup, or generate a new one.
- **Other password managers**: offers to turn off Chrome's own password saving and extensions like Proton Pass or
  Bitwarden, so only one manager tries to fill each form.

## Security model

| Concern                  | How it is handled                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Account password         | Never sent: sign-in sends an auth key derived from it (Argon2id + HKDF, as the Quark app does) with the salt from `GET /api/v0/auth/salt`. An account the Quark marks `legacy` gets the password beside the key once, to move it to keys. Needs Quark v0.47.0+ |
| Vault password           | Sent once to `POST /api/v0/vault/unlock`, never stored                                          |
| Session token            | `chrome.storage.session` (memory, gone when Chrome quits); `local` only if "stay signed in"    |
| Decrypted entries        | Fetched one at a time on a click, passed straight to the page, never stored or cached          |
| Captured sign-ins        | Held in service-worker memory per tab for at most two minutes, then dropped                    |
| Which site gets a login  | Page host must equal the entry's host or be a subdomain of it, checked in the worker and again in the page. A login inside an iframe fills only when the top page is that site too |
| Plain `http://` pages    | Refused, unless the entry itself was saved with an `http://` URL (a router admin page, say)    |
| Page scripts             | Can't message the extension; the picker lives in a closed shadow root                          |
| Permissions              | `storage`, `activeTab`, `idle`, `contextMenus`; `privacy` and `management` are optional and requested only when used |

Listing entries (`GET /api/v0/vault/entries`) returns names and hosts only, so the match count works while the vault
is locked.

## Install (sideload)

1. Download the `quark-vault-extension` artifact from the latest CI run, or run `npm ci && npm run package`, which
   writes the zips to `.output/`.
2. Unzip `quark-vault-chrome.zip`.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
4. Click the Quark Vault toolbar button and connect to your Quark (for example `https://quark.local`).

If your Quark uses a self-signed certificate, open its address in Chrome once and accept the certificate. The
extension can't reach a server Chrome doesn't trust.

## Firefox

`npm run package` also builds `quark-vault-firefox.zip` (Firefox 128+) and `quark-vault-sources.zip`, the source
archive AMO asks for. To try it, run `npm run build:firefox`, open `about:debugging` › This Firefox › **Load Temporary
Add-on** and pick `.output/firefox-mv3/manifest.json`. Differences from Chrome:

- If Firefox hasn't granted access to websites, the popup shows **Allow** so the extension can fill logins there.
- The other-password-managers check can turn off Firefox's own password saving, but not other add-ons: Firefox
  doesn't allow that, so it points you to `about:addons`.
- Firefox lacks `location.ancestorOrigins`, so for a login inside a same-site iframe the frame checks the top page
  against the URL the service worker got from the top frame itself, instead of asking the browser. Chrome keeps
  using `ancestorOrigins`.

CI lints the Firefox build with `web-ext lint`; the end-to-end tests run in Chromium only. Before a Firefox release,
check by hand: connect, unlock, fill from the popup and the in-field button, a one-time code, save a new login, and
the shortcut.

## Develop

```sh
npm ci
npm run dev            # WXT dev mode: builds .output/chrome-mv3-dev, opens Chrome with it loaded, reloads on change
npm run dev:firefox    # the same in Firefox
npm run build          # production builds in .output/chrome-mv3 and .output/firefox-mv3
npm run check          # typecheck + unit tests
QUARK_SRC=~/src/quark npm run test:e2e:quark   # builds that Quark checkout, then runs the e2e tests against it
```

The build is [WXT](https://wxt.dev) (`wxt.config.ts`); `wxt build -b edge` also works.

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

CI builds Quark from autobutler-org/quark at the commit `QUARK_REF` names in `.github/workflows/check.yml`; set the
repository variable `QUARK_REF` to test another commit, branch or tag.

```text
src/background/   service worker: holds the token, calls the Quark, answers the popup and pages
src/content/      finds login forms, draws the inline picker, fills fields
src/popup/        toolbar popup: connect, unlock, entries
src/options/      settings and the other-password-managers check
src/shared/       API client, host matching, message types, error copy
entrypoints/      WXT entrypoints: background, content script, popup and options pages
static/           CSS and icons, copied as-is (the manifest is in wxt.config.ts)
e2e/              Playwright tests; support/ starts the Quark (real or mock), the proxy and the test site
scripts/          build-quark.sh, which builds the Quark server the e2e tests run against
```

## Not yet

- Safari
- Importing from other managers happens on the Quark: autobutler-org/quark#2543
