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
- **Copy and generate**: copy any entry's password from the popup, or generate a new one.
- **Other password managers**: offers to turn off Chrome's own password saving and extensions like Proton Pass or
  Bitwarden, so only one manager tries to fill each form.

## Security model

| Concern                  | How it is handled                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| Vault password           | Sent once to `POST /api/v0/vault/unlock`, never stored                                          |
| Session token            | `chrome.storage.session` (memory, gone when Chrome quits); `local` only if "stay signed in"    |
| Decrypted entries        | Fetched one at a time on a click, passed straight to the page, never stored or cached          |
| Which site gets a login  | Top frame only, host must equal the entry's host or be a subdomain of it, checked twice (worker and page) |
| Plain `http://` pages    | Refused, unless the entry itself was saved with an `http://` URL (a router admin page, say)    |
| Page scripts             | Can't message the extension; the picker lives in a closed shadow root                          |
| Permissions              | `storage`, `activeTab`, `idle`, `contextMenus`; `privacy` and `management` are optional and requested only when used |

Listing entries (`GET /api/v0/vault/entries`) returns names and hosts only, so the match count works while the vault
is locked.

## Install (sideload)

1. Download the `quark-vault-extension` artifact from the latest CI run, or run `npm ci && npm run package`.
2. Unzip it.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
4. Click the Quark Vault toolbar button and connect to your Quark (for example `https://quark.local`).

If your Quark uses a self-signed certificate, open its address in Chrome once and accept the certificate. The
extension can't reach a server Chrome doesn't trust.

## Develop

```sh
npm ci
npm run watch          # rebuild dist/ on change; load dist/ unpacked, then hit reload in chrome://extensions
npm run check          # typecheck + unit tests
CHROME_PATH=/path/to/chromium npm run test:e2e   # loads dist/ into Chromium against a mock Quark
```

`test:e2e` needs Chromium or Chrome for Testing: branded Chrome ignores `--load-extension`. Set `E2E_SCREENSHOTS` to
a folder to save screenshots of each screen.

```text
src/background/   service worker: holds the token, calls the Quark, answers the popup and pages
src/content/      finds login forms, draws the inline picker, fills fields
src/popup/        toolbar popup: connect, unlock, entries
src/options/      settings and the other-password-managers check
src/shared/       API client, host matching, message types, error copy
static/           manifest, HTML, CSS, icons
```

## Not yet

- Saving new logins from the page (the Quark API supports `POST /vault/entries`; the extension doesn't offer it yet)
- Firefox and Safari
- Importing from other managers happens on the Quark: autobutler-org/quark#2543
