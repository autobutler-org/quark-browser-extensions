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
  has never had such a key: after you agree, its password is sent once, beside the
  key, so the Quark can upgrade it. This is never done over an unencrypted
  connection other than to your own computer.
- **Unlocking:** your vault password, once, so your Quark can unlock the vault.
- **Filling and copying:** requests for your vault's list of entries, and for one
  entry's details when you fill or copy it.
- **Saving:** when you click Save or Update on the save bar, the site's address,
  the username and the password.
- **Generating a password:** the length and kinds of characters you want.
- **Locking and signing out:** the request to do so.

Each request carries the session token your Quark issued when you signed in. The
session appears in your Quark under Settings › Sessions, where you can revoke it.

The addresses of the pages you visit are used inside your browser to find
matching logins. They are not recorded or sent anywhere, except the address of a
login you choose to save.

## What the extension keeps on your device

- Your settings, and the sites you chose "Never for this site" on.
- Your session token, in the browser's memory until the browser closes. If you
  tick "Stay signed in", an encrypted copy is kept on disk so you stay signed in
  after a restart.
- The address of the last Quark you signed in to.
- A record of which accounts already sign in with a key, stored as one-way
  hashes, not names.

It does not store your account password, your vault password, your decrypted
logins or one-time-code secrets. When you sign in on a website, the username and
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
