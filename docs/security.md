# Security notes

What the extension does to keep your Quark session and vault entries away from web pages, and where its protection stops. Issue #24 has the background.

## Plain http Quark addresses

When you sign in, the extension sends your username and auth key to your Quark. After that it sends a bearer token with every request, the vault password when you unlock, and every decrypted entry it fills. Over plain `http://`, anyone on the network path can read all of that.

The policy:

| Address | What happens |
| --- | --- |
| `https://…` | Connects. |
| `http://` to loopback: `localhost` (and `*.localhost`), `127.0.0.0/8`, `[::1]` | Connects. Loopback traffic never leaves the machine. |
| Any other `http://`, such as a LAN IP or `quark.local` | The connect form shows a warning and won't submit until you tick **I understand this connection is unencrypted**. The service worker enforces this as well: a `connect` request for a non-loopback http address without `allowInsecure: true` is refused before any request goes out. |

While connected to a non-loopback http Quark, the popup keeps a warning on the unlock, entries and status screens.

The extension doesn't store the confirmation. You confirm again each time you sign in. An address with no scheme is treated as `https://`. IPv4-mapped loopback (`[::ffff:127.0.0.1]`) isn't treated as loopback, so it asks too.

The code is in `src/shared/host.ts` (`isLoopbackHost`, `serverTransport`, `needsInsecureConfirmation`) and in `connect` in `src/background/index.ts`.

## Where the session token lives

The Quark session token belongs to an admin account, so it can do anything an admin can for the life of the session. Content scripts run inside web pages, and a compromised renderer can drive them. They can read `chrome.storage.local`, and `setAccessLevel` can't restrict that area. So the token never goes into `storage.local` in plaintext.

- **The live token** is kept only in `chrome.storage.session`. That area is held in memory and cleared when the browser exits. In Chrome it is limited to trusted contexts (extension pages and the service worker). The worker also calls `storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` on startup, so the restriction holds even if Chrome's default ever changes. Firefox also keeps `storage.session` from content scripts by default. A browser that lacks `setAccessLevel`, or throws on it, keeps that default, and the worker goes on without the call.
- **"Stay signed in"** encrypts the token at rest:
  - On sign-in, the worker generates a non-extractable AES-GCM-256 key and stores it in the extension origin's IndexedDB (`src/background/sealKey.ts`). Content scripts can't open that database, because a content script's IndexedDB is the page's.
  - The token is encrypted with that key, with the server address bound in as associated data. Only the ciphertext goes into `storage.local`, under `sealedConnection`.
  - After a browser restart, the first request for the connection decrypts the token back into `storage.session`.
  - If the ciphertext has been tampered with, has been moved to another server address, or its key is gone, the extension signs out cleanly instead.
- **Signing out, or a 401 from Quark,** removes the session copy and the ciphertext, and deletes the key.
- **Upgrading from an older build:** builds before the seal kept the token in plaintext under `connection` in `storage.local`. That copy is deleted, not adopted, and those users sign in once more. An older build's `server` key in `storage.local` is deleted the same way.
- **If sealing fails,** for example when IndexedDB is unavailable in a private-only profile, you stay signed in for this browser session only.

### Nothing in `storage.local` picks the Quark

Content scripts can **write** `storage.local` as well as read it. If the worker trusted anything there, a compromised renderer could plant `{ server: "https://evil.example", token: "x" }` and the worker would send the master password there on the next unlock (issue #75). So:

- The worker connects only to a server from a sealed record that decrypts with the key in IndexedDB, or from a sign-in on the extension's own pages (`connect`, which the gate accepts only from them). The sealed record's server is bound in as associated data, so it can't be swapped without failing to decrypt.
- A plaintext `connection` in `storage.local` is never used. The worker deletes it when it next restores the session, and never deletes the real sealed record or its key because of it.
- The address the popup shows comes from the live connection. When signed out, it is the last address signed in to, which the worker keeps in the extension's IndexedDB next to the seal key, not in `storage.local`.

A content script can still delete or corrupt `sealedConnection`, which signs you out. It can't sign you in somewhere else.

### What this does and doesn't protect

- **Protected:** web pages, content scripts and compromised renderers. The ciphertext in `storage.local` is useless to them without the key, and they can't reach the key or `storage.session`.
- **Not protected:** someone who copies your browser profile from disk. Chrome and Firefox save IndexedDB, CryptoKeys included, without a user secret, so with the whole profile they can decrypt the token. This is the price of "stay signed in" with no prompt. The alternatives were to keep the token only for the browser session, or to ask for your password again after every restart, and both would make "stay signed in" mean nothing. If someone may copy your profile, leave **Stay signed in** unticked. You can also revoke the browser's session any time in Quark's **Settings › Sessions**.
- **Still open (needs Quark):** the token carries full admin rights. A token scoped to the vault would limit the damage if it leaked.

## Who gets credentials when filling

The popup's **Fill**, the keyboard shortcut and the context menu all fill through `fillInTab`. It messages every frame in the tab, so that a login form in a same-site iframe still fills. That message (`FillCommand` in `src/shared/messages.ts`) contains the entry's id, URL and host, and **no username or password**.

Each frame decides what to do with the message using `fillDecision` in `src/content/frame.ts`:

- A frame without login fields stays quiet.
- Another site's iframe also stays quiet, so the frame that fills gets to answer.
- A top frame for a different site refuses and says why.
- A frame that fits the entry asks the worker for the credentials with `fillFromPage`.

The worker answers `fillFromPage` only after it checks the requesting frame. It uses the frame URL and frame id that the browser reports, not anything the page says. For a subframe it also checks the top frame's URL, which it gets by asking frame 0. These are the same checks the inline picker and one-time codes use. A frame that lies in its own check still gets refused by the worker.

## Filling a login on a site it isn't saved for

The popup lists every vault entry, with search. An entry that matches the page fills with one click, through `fillInTab` as above. Any other entry shows **Fill anyway**. That button only opens a warning naming the entry's saved host and the page's host (port included), plus a note when the page is plain http. Nothing is filled until you click **Fill on ‹page host›** in that warning.

That click sends `fillAnyway` to the worker. The gate (`src/background/gate.ts`) accepts it from the extension's own pages only, so no page or content script can start a manual fill. The worker then:

- Reads the tab's URL from the browser, not from the page, and refuses unless it is an http or https page on the host you confirmed. If the tab moved on since you confirmed, you confirm again.
- Takes the normal one-click path if the entry turns out to match after all.
- Otherwise leaves a one-time grant for that tab, entry and page origin, good for ten seconds (`src/background/manual.ts`). It sends a fill command to frame 0 only, never to iframes, and like every fill command it carries no username or password.
- Gives the credentials to a `fillFromPage` request only if the browser reports it from frame 0 of that tab, on that exact origin, for that entry, within the grant's time. The grant goes once it's used, when the fill command is answered, and when the vault locks, you sign out or the tab closes.
- Never auto-submits a manual fill, even with **Submit after filling** on.

The keyboard shortcut, the context menu and the inline picker keep their host checks. They have no manual path.

## Which hosts match

`hostMatches` in `src/shared/host.ts` decides whether a page may use an entry, in the worker and again in the page:

- The same host, ignoring a leading `www.` (unless what's left is a public suffix, so `www.github.io` stays a site).
- Or a subdomain of the entry's host inside the same registrable domain (`login.example.com` for `example.com`).
- A suffix on the public suffix list, private entries such as `github.io` included, is never a parent: an entry for `co.uk` or `github.io` matches no other site.
- An IP address matches only itself.
- A single-label host that isn't on the list (`localhost`, an intranet name) stays a parent of its subdomains.

Scheme and port don't widen the match. A different port or scheme is shown as a labelled fallback and is never filled without a pick. A plain `http://` page is refused unless it is loopback or the entry itself was saved with an `http://` URL (`mayFill`).
