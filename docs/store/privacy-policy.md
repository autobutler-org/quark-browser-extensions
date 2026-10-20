# Quark Vault privacy policy

Effective 14 October 2026. Applies to the Quark Vault browser extension for
Chrome, Edge and Firefox.

## The short version

Quark Vault talks only to the Quark server you connect it to. That is a server
you or your household run. It sends nothing to us, the developers, or to anyone
else. It has no analytics, telemetry, advertising or tracking.

## What the extension sends, and to whom

Every network request goes to the Quark address you type into the extension,
and nowhere else. Those requests are how it does its job:

- **Signing in:** your username and an authentication key derived from your
  account password on your device (Argon2id, as the Quark app does). Your account
  password itself is not sent. The one exception is an older Quark account that
  has never had such a key: after you tick a confirmation naming the Quark, its
  password is sent beside the key for that upgrade attempt. The consent works
  once, expires after five minutes, and must be given again after a failed
  attempt. The extension refuses this over an unencrypted connection other than
  to your own computer, or after it has seen that account sign in with a key.
- **Unlocking:** a request for your vault key, which your Quark keeps encrypted
  under a key only your account password can derive. The extension decrypts it on
  your device; your password is not sent.
- **Filling and copying:** requests for your vault's items, which arrive
  encrypted and are decrypted on your device.
- **Saving:** when you click Save or Update on the save bar, the login encrypted
  on your device. Your Quark never sees the site's address, the username or the
  password in the clear.
- **Signing out:** the request to do so.

Passwords are generated and the vault is locked on your device, with no request.

After sign-in, authenticated requests carry the session token your Quark issued.
The session appears in your Quark under Settings › Sessions, where you can
revoke it.

The addresses of the pages you visit are used inside your browser to find
matching logins. They are not recorded or sent anywhere, except the address of a
login you choose to save.

## What the extension keeps on your device

- Your settings, and the sites you chose "Never for this site" on.
- Your session token, in the browser's memory until the browser closes. If you
  tick "Stay signed in", an encrypted copy is kept on disk so you stay signed in
  after a restart.
- The address of the last Quark you signed in to.
- A record in the extension's IndexedDB of which accounts already sign in with a
  key, stored as one-way hashes, not names.
- While your vault is unlocked, its key, in browser memory only. It is dropped
  when the vault locks, after 15 minutes unused, or when the browser closes.
- A single-use legacy-upgrade consent in browser memory. It contains the same
  kind of hash and a time, is valid for five minutes, and is removed when used
  or when the browser closes.

It does not store your account password, your decrypted logins or
one-time-code secrets. When you sign in on a website, the username and
password you typed are held in memory for at most two minutes so the extension can
offer to save them, then dropped.

## Data shared with third parties

None. We don't receive your data, so we can't sell, share or transfer it. The
only place your data goes is your own Quark, which you control.

## Permissions

The extension asks the browser only for what it needs to fill logins. The full
list, and why each is needed, is in
[permissions.md](https://github.com/autobutler-org/quark-browser-extensions/blob/main/docs/store/permissions.md).

## Removing your data

Signing out in the extension deletes the session token and its encrypted copy.
Uninstalling the extension removes everything it stored in your browser. Your
vault itself lives on your Quark and is managed there.

## Changes and contact

Changes to this policy are made in the open in the extension's repository, with
the date above updated. Questions and reports:
https://github.com/autobutler-org/quark-browser-extensions/issues
