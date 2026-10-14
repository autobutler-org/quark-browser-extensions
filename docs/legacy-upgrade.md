# Legacy account upgrade

Quark v0.47.0 and later sign in with an auth key derived from the password (autobutler-org/quark#2430), so the Quark never learns the password itself. An account made before that has no auth key yet. `GET /auth/salt` reports it as `legacy: true`, and its next sign-in sends the password beside the key once. The Quark checks the password, stores the key, and from then on accepts only the key.

The only evidence that an account is legacy is what the server says. A malicious or compromised Quark, or anyone who can answer `/auth/salt` for it, could say `legacy: true` on every sign-in and collect the password each time (#76). So the extension sends the password only for a real, one-time upgrade.

## The rules

`login` in `src/shared/api.ts` applies these checks to a `legacy: true` answer, in order, before it derives the key or sends anything:

1. **Never over plain http.** If the address is a non-loopback `http://` one (`serverTransport(server) === "insecure"`), it refuses even when the user has accepted the unencrypted connection. A network attacker there could inject `legacy: true`. Loopback `http://` is allowed because it never leaves the machine. To upgrade such an account, sign in once over https or in the Quark app.
2. **Never twice for one account.** The extension records every account that has signed in successfully on a server, by key alone or through the upgrade. If that server later answers `legacy: true` for the same account, it refuses with "*host* asked for your password again…" and sends nothing. A Quark asks only once, because the upgrade clears the account's password hash.
3. **Only after the user confirms.** The first `legacy: true` for an account returns a `refused` error that carries `legacyUpgrade: { server, username }`. The connect form then explains that the password goes out once, and shows a required "Send my Quark password to *host* this one time" checkbox, with the server and username already filled in. Submitting with the box ticked records a consent, then connects again. The consent is used only if the form still names the same server and account.

The password goes beside the key only when all three checks pass. A successful sign-in, upgrade or not, records the account so rule 2 applies from then on.

## Storage

Both records live in `src/shared/authKey.ts` (`createUpgradeLedger`), keyed by `sha256(server + "\n" + lowercased, trimmed username)`, so neither the server nor the username is stored. Usernames match regardless of case or surrounding space, so a server can't get past the record by spelling the name differently.

- **Upgraded accounts** are a list of those hashes in `chrome.storage.local` under `keyedAccounts`. The list survives restarts and sign-outs. Reinstalling the extension clears it.
- **The consent** is a single `{ id, at }` in `chrome.storage.session` under `legacyUpgradeConsent`. Only extension pages and the worker can use that area, not content scripts (`src/background/storage.ts`). `login` removes the consent when it reads it, so it counts once whether or not the upgrade works. It expires after five minutes (`consentTtlMs`). A failed upgrade, such as a wrong password, records nothing, and the user must confirm again.

The connect form writes the consent itself, so the `connect` message between the popup and the worker is unchanged.

## How this differs from the Quark app

The Quark app (`lib/services/auth_secret.dart`) accepts the `legacy` answer every time and documents the same exposure. The extension is stricter: it can't tell a reset Quark from a tampered one either, but it refuses instead of sending. The only legitimate way an account becomes legacy again is restoring a database from before auth keys. In that case, sign in through the Quark app, which moves the account to a key. The extension then signs in with the key alone.
