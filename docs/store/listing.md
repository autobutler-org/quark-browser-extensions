# Store listing

Text for the Chrome Web Store and Firefox Add-ons (AMO) listing pages. The
name, short description and icon come from the build. Everything else is pasted
into the store dashboards by hand on the first submission (see
[.github/RELEASING.md](../../.github/RELEASING.md)).

| Field | Value |
| --- | --- |
| Name | Quark Vault (`extName` in `static/_locales/en/messages.json`) |
| Version | From `package.json` (currently 0.1.0) |
| Icon | `static/icons/icon-128.png` (128×128) |
| Licence | MIT-0 (`LICENSE`) |
| Homepage | https://github.com/autobutler-org/quark-browser-extensions |
| Support | https://github.com/autobutler-org/quark-browser-extensions/issues |
| Privacy policy | [privacy-policy.md](privacy-policy.md), at a public URL (see below) |
| Firefox add-on id | `vault@autobutler.org` |
| Minimum versions | Chrome 116, Firefox 128 |

`package.json` has no `homepage`, `bugs` or `repository` field. The URLs above
are the repository's GitHub remote, the same one `.github/amo-metadata.json`
names. If those fields get added to `package.json`, keep them in step with this
table.

Both stores want the privacy policy as a URL, not text. Once this file is on
`main`, use
`https://github.com/autobutler-org/quark-browser-extensions/blob/main/docs/store/privacy-policy.md`.

## Short description

Chrome takes it from the manifest's `description` (132 characters at most) and
doesn't let you edit it in the dashboard. AMO's summary (250 at most) starts out
as the same text and can be edited.

> Fill logins from the password vault on your Quark.

## Long description

> Quark Vault fills website logins from the password vault on your own Quark server. It is a companion to Quark, not a cloud service: the extension talks only to the Quark address you enter, and nothing goes to us or anyone else.
>
> **What it does**
>
> • Fill: on a sign-in page, a Quark button appears in the password field when your vault has a login for that site, and the toolbar icon shows how many. Pick one, press Fill in the popup, or use Ctrl+Shift+L (⌘⇧L on macOS).
> • One-time codes: verification-code fields get the same button when the login has a TOTP secret. Only the code reaches the page.
> • Save and update: after you sign in somewhere new, a bar offers to save the login, or to update the password when it changed.
> • Strong passwords: sign-up forms get "Suggest strong password", sized to the field, and the right-click menu can generate one for the field you're on.
> • Search and copy: the popup lists every entry, with search, and copies usernames, passwords and one-time codes.
> • One manager at a time: the options page can turn off the browser's own password saving, and in Chrome other password-manager extensions, so they don't fight over the same form.
>
> **How it keeps your logins safe**
>
> • Your account password never leaves the browser: sign-in sends a key derived from it with Argon2id, as the Quark app does.
> • Unlocking is done by your Quark. The vault password is sent once to unlock and never stored.
> • Decrypted logins are fetched one at a time when you fill, and never stored or cached.
> • A login fills only on its own site (or a subdomain of it), checked twice. Filling it on another site takes an explicit confirmation that names both sites.
> • The session token is kept in memory. "Stay signed in" stores it encrypted, never in plain text. The session shows up in your Quark under Settings › Sessions, and you can revoke it there.
> • The vault locks when your screen locks, and optionally when the computer is idle.
> • No analytics, no telemetry, no remote code.
>
> **You need** a Quark (v0.47.0 or later) with its password vault set up, and a Quark admin account.
>
> Open source under MIT-0: https://github.com/autobutler-org/quark-browser-extensions

"In Chrome" is there on purpose: Firefox doesn't let one add-on turn off
another, so on Firefox the options page lists them and points to `about:addons`.

## Category

| Store | Category |
| --- | --- |
| Chrome Web Store | Make Chrome Yours › Privacy & security. If that doesn't fit what the dashboard offers, Productivity › Tools. |
| AMO | Privacy & Security (the one category it needs). Add "Other" only if AMO insists on a second. |

## Single purpose (Chrome)

> Quark Vault fills, saves and updates website logins using the password vault on the user's own Quark server.

Every feature serves that one purpose: the in-field button, popup, shortcut and
right-click menu fill logins; the save bar stores new or changed ones; the
password generator fills sign-up forms; the options page configures filling and
locking and can switch off competing password managers so only one fills each
form.

## Keywords and tags

Chrome has no keyword field: the long description is what search reads, so the
words below are already in it. AMO takes up to 20 tags; use these:

`password manager`, `passwords`, `autofill`, `login`, `self-hosted`, `vault`,
`totp`, `2fa`, `password generator`, `privacy`, `security`, `quark`

## Screenshots

`scripts/screenshots.spec.js` makes the four 1280×800 PNGs both stores accept,
from the real extension against the e2e mock Quark:

```sh
npx playwright install chromium   # once
npm run build:chrome && npx playwright test -c scripts/screenshots.config.js
```

They land in `.output/store-screenshots/`, which is gitignored and left out of
the AMO sources zip (WXT zips untracked files too, so a folder in `docs/` would
end up in it):

| File | Caption |
| --- | --- |
| `1-popup.png` | Your vault in the toolbar: the site's login first, then every entry. |
| `2-fill-picker.png` | Pick a login straight from the password field. |
| `3-save-offer.png` | Save a new login, or update a changed password, after you sign in. |
| `4-options.png` | Choose how filling and locking work. |

`E2E_TARGET=quark` runs it against a real Quark instead, as for the e2e tests.
Chrome Web Store also asks for a 440×280 small promo tile, which isn't made
here.
