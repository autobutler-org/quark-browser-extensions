# Permissions and data use

Answers for the Chrome Web Store's Privacy tab and AMO's review questions. They
match the built manifests (`npm run build`, then `.output/chrome-mv3/manifest.json`
and `.output/firefox-mv3/manifest.json`), which come from `wxt.config.ts` and
`entrypoints/`. If a permission changes there, change it here too.

## What the manifests ask for

| | Chrome | Firefox |
| --- | --- | --- |
| `permissions` | `storage`, `activeTab`, `idle`, `contextMenus` | the same |
| `optional_permissions` | `privacy`, `management` | the same |
| `host_permissions` | none | `https://*/*`, `http://*/*` |
| Content script | `http://*/*`, `https://*/*`, all frames, at `document_idle` | the same |
| `commands` | `fill-login` (Ctrl+Shift+L, ⌘⇧L on macOS) | the same |
| Remote code | none: `script-src 'self'; object-src 'none'; base-uri 'none'` | the same |

There is no `tabs`, `scripting`, `cookies`, `webRequest`, `history`,
`clipboardRead` or `clipboardWrite` permission.

## Justifications

Paste each into the matching box. Chrome asks for one per permission plus one
for host access; AMO asks in the reviewer notes ([amo-notes.md](amo-notes.md)
repeats these).

**storage**
> Stores the user's settings (inline button, badge, auto-submit, idle locking), the list of sites the user chose never to save logins for, and the signed-in session. The session token lives in storage.session, which is memory only and closed to content scripts. If the user ticks "Stay signed in", an AES-GCM encrypted copy of the token is kept in storage.local; its key is non-extractable and lives in the extension's IndexedDB. No password or decrypted vault entry is ever stored.

**activeTab**
> Lets the popup, the keyboard shortcut and the right-click menu work on the page the user is on: they read that tab's address to find its logins and send the fill to it. The extension has no tabs permission and cannot see other tabs' addresses.

**idle**
> Locks the vault when the computer's screen locks, and, if the user turns it on in the options, after 5, 15 or 30 minutes idle.

**contextMenus**
> Adds a "Quark Vault" item to the right-click menu on editable fields, with "Fill <login>" for the site's logins and "Generate password" for the field the user clicked.

**privacy (optional)**
> Requested only when the user clicks "Check" for the browser's built-in password manager in the options page. It reads and, if the user clicks "Turn off", disables the browser's own password saving, so two password managers don't offer to save the same login.

**management (optional)**
> Requested only when the user clicks "Check" for other password-manager extensions in the options page. It lists installed extensions whose names match known password managers, and in Chrome turns one off when the user clicks "Turn off" next to it. Firefox doesn't allow that, so there the page only lists them and points to about:addons.

**Host access: content script on all http and https pages** (Chrome's "host permission" box; Firefox's `host_permissions`)
> A password manager has to work on whatever site the user signs in to, so the content script runs on every http and https page and frame. It looks for login, sign-up and one-time-code fields, draws the Quark button in them when the vault has a login for that site, fills a login the user picks, and notices a submitted sign-in so it can offer to save it. It never receives a password until the background has checked the frame's browser-reported address against the login's site. It reads nothing else from the page and sends nothing from the page anywhere except a submitted username and password, to the background, so it can offer to save them.
>
> Firefox only: Firefox 128+ lets the user withhold access to websites. When it is withheld, the popup offers an "Allow" button that asks for these host permissions. Chrome grants the content script's access at install and needs no host_permissions.

**Remote code (Chrome: "Are you using remote code?")**
> No. All JavaScript is in the package. The extension pages' content security policy is script-src 'self'; object-src 'none'; base-uri 'none'. The only network requests go to the Quark server address the user typed in, and they carry JSON, never code.

## Data use

### What is stored, and where

All of it stays in the browser profile. Nothing is stored on any server we run.

| Data | Where | How long |
| --- | --- | --- |
| Session token for the user's Quark | `storage.session` (memory) | Until the browser quits, sign-out or a 401 |
| Same token, encrypted (only with "Stay signed in") | `storage.local` as AES-GCM ciphertext; the non-extractable key in the extension's IndexedDB | Until sign-out, a 401 or tampering |
| Last Quark address signed in to | Extension IndexedDB | Until replaced |
| Settings | `storage.local` | Until changed |
| Sites the user chose "Never for this site" on | `storage.local` (hosts only) | Until removed in the options |
| Which accounts already sign in with an auth key | `storage.local`, as SHA-256 hashes of server and username | Kept |
| A sign-in captured on submit (username and password) | Background memory, per tab | Two minutes at most, or until the user answers the save bar, the tab navigates on, or closes |
| A generated password shown in the popup | Popup memory | Until dismissed, the vault locks, or the popup closes |

Never stored: the account password, the vault password, decrypted entries, one-time
code secrets.

### What leaves the device

Only requests to the Quark address the user enters, at `<address>/api/v0/…`,
with `credentials: "omit"` (no cookies):

| Request | Sends |
| --- | --- |
| `GET /auth/salt`, `POST /auth/login` | Username and an Argon2id + HKDF auth key derived from the account password. The password itself only once, for an account the Quark marks legacy, after the user confirms, and never over non-loopback plain http |
| `POST /auth/logout` | The session token |
| `GET /vault/status`, `POST /vault/lock` | The session token |
| `POST /vault/unlock` | The vault password, once |
| `GET /vault/entries`, `GET /vault/entries/{id}` | The session token. Returns names and hosts; one entry's secrets only when the user fills or copies it |
| `POST /vault/entries`, `PUT /vault/entries/{id}` | When the user clicks Save or Update: the site's origin, username and password |
| `POST /vault/generate` | Requested length and character classes |

There is no analytics, telemetry, crash reporting, advertising or update check of
our own, and no request to any other host. The page addresses the extension sees
are used in the browser to match logins and are not sent anywhere, except the
origin of a login the user chooses to save.

### Chrome Web Store data usage form

The form asks what the item "collects or uses". The extension handles
credentials, so tick:

- **Authentication information**: usernames, passwords, one-time codes, the
  Quark session token.

Leave the rest unticked: it doesn't collect personally identifiable information
beyond the usernames above, health, financial, communications, location, web
history, user activity or website content. Page addresses are matched locally
and not kept or sent (see above). If a reviewer counts a username that is an email
address as PII, tick **Personally identifiable information** too; nothing else
changes.

Then certify all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

All three are true: the only recipient is the user's own Quark.

### Firefox data collection

The Firefox manifest declares
`browser_specific_settings.gecko.data_collection_permissions: { required: ["none"] }`,
so the install prompt says the developer says it doesn't require data collection.

**Owner decision before the first AMO submission.** Mozilla's
[definition](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
counts data "handled outside the add-on or the local browser", and doesn't say
whether a server the user runs and enters themselves is outside that. The
extension sends passwords and usernames to that server. Two honest options:

1. Keep `"none"`, and explain in the reviewer notes that the only recipient is
   the user's own self-hosted Quark, which the user enters and which is the
   add-on's whole purpose; no data reaches the developer or any third party.
   [amo-notes.md](amo-notes.md) has that paragraph.
2. Declare `required: ["authenticationInfo"]` in `wxt.config.ts`. Firefox
   then names authentication info on the install prompt.

If a reviewer asks for option 2, it is a one-line change in `wxt.config.ts`.
