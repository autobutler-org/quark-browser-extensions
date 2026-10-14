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

### Frames the user can't see

A frame can be hidden as a whole: an `<iframe>` at 0×0, transparent, clipped or moved off-screen, whose document looks normal from inside (issue #141). A login field in a frame must also be in a frame the user can see. Each `<iframe>` (or `<frame>` or `<object>`) from the field's frame up to the top is held to the field rules below, except the honeypot marks. Those rules are the box size, opacity, clipping and position in the parent's page.

- **Same origin:** the frame reads its own `frameElement` and checks it, with each same-origin frame element above it (`documentShown` in `src/content/forms.ts`).
- **Another origin:** `frameElement` is null, and nothing a frame says about itself counts. When a subframe asks for a login with `fillFromPage`, the worker (`src/background/frames.ts`):
  1. sends that frame a random nonce (`announceFrame`);
  2. the frame's content script posts the nonce to `window.parent`;
  3. the parent's content script finds the frame element whose `contentWindow` is the message's `source`, which the page can't forge, checks it and sends `frameReport`;
  4. the worker takes the first report for that nonce, from that tab, with the frame id the browser gives it, and repeats from that frame until it reaches the top.

  A hidden frame anywhere on the way, no report within a second, or a chain that loops is refused with "This login form is in a frame you can't see on this page". This covers the popup's Fill, the shortcut, the context menu and the inline picker, since they all ask through `fillFromPage`.

Limits:

- The nonce passes through the parent page as a `message` event. A parent page running hostile script can stop that event before the content script sees it, which only refuses the fill. It can also repost the nonce from a visible frame it controls, so that the visible frame is reported in place of the hidden one. That takes script on a page the login matches, and such a page can already draw a barely visible form of its own.
- One-time codes (`otpFromPage`) and the generated password still go to subframes without this check.
- The extension asks for no `webNavigation` permission, so the worker learns a frame's parent only from that parent's report.

## Which fields get a login

A page on the login's own site can still run hostile script: a third-party tag, an XSS. It can lay out decoy fields the user never sees, ahead of the real form, to catch a fill that has no target field, or hide the real field once the inline picker is open (issue #129). So a username or password field is filled only when the user can see it (`isLoginField` in `src/content/forms.ts`). It must be:

- Shown: not `display:none`, `visibility:hidden` or `visibility:collapse`, `[hidden]` or disabled, itself or through an ancestor.
- Reachable: not `tabindex=-1`, and not under `aria-hidden="true"`, the marks spam honeypots carry.
- Opaque: its opacity times every ancestor's, each multiplied by the `opacity()` functions in its `filter`, is at least 0.1.
- Not clipped or masked away: no `clip: rect(…)` narrower than 4px, and no `mask-image` made only of gradients whose every colour is transparent, on it or an ancestor.
- Rendered and big enough: the browser's `checkVisibility()` passes (a closed `<details>` fails it), and its box is at least 4px by 4px after every ancestor's `clip-path` and any ancestor with `overflow: hidden` or `clip` cut it. A clip-path is read as the browser computes it: `inset()` in pixels, percentages or a `calc()` of the two (which is also how Chromium reports `rect()` and `xywh()`), `rect()` and `xywh()`, `polygon()`, which counts only if its part inside the element covers 4px by 4px and 16 square pixels, and `circle()` or `ellipse()` by their bounds. A polygon's or circle's bounds stand for its shape. A clip-path clips positioned descendants too, so it counts whatever the containing block.
- On the page: not moved left of or above the page, nor past the right edge of a page that can't scroll sideways. A fixed field must sit in the viewport. Below the fold still counts, and so does a field scrolled out of view inside a scrolling panel: the user can scroll to either.

These rules follow the flat tree, as the page is drawn (#139). A light-DOM field slotted into a web component's shadow root is checked through its slot and the slot's wrappers, then out through the host. That is how a component's own `overflow: hidden`, `clip-path` or `opacity` clips or fades what it slots. A closed shadow root hides its slots from the page (`assignedSlot` is null), but not from an extension: the content script opens it with `chrome.dom.openOrClosedShadowRoot` in Chrome and `Element.openOrClosedShadowRoot()` in Firefox, and the rules apply the same way.

**The closed-shadow policy.** If a browser offers neither call, or refuses one, the content script can't see what a closed root does with a slotted field: a clip and ordinary styling look the same from outside. Refusing every field in a closed component would break real sign-in cards, and ignoring the question leaves the hole open. So a fill with no target the user chose (the popup's **Fill**, the shortcut and the context menu) takes such a field only if it is provably shown: a hit test at the centre of its box finds the field itself. A field that fails is skipped, so the fill moves on to the next one; with none left it fills nothing. A field outside the viewport, or covered by another element, fails the hit test too, so in such a browser those fields fill only from the picker. The inline picker is unaffected, because the user picked the field it sits on. Chrome 116 and Firefox 140, the oldest versions the extension supports, both have the call, so the policy is a fallback and not the normal path. The code is `shadowRootOf`, `slotting` and `provablyShown` in `src/content/forms.ts`.

The popup's **Fill**, the shortcut and the context menu skip fields that fail, so they fill the real form behind any decoys. The inline picker checks its field again when the user picks, before it asks the worker for the login, and `fillLogin` checks once more when the login arrives. A field hidden in between gets nothing, and the picker says it couldn't find the login fields. Real forms with floating labels, screen-reader-only labels, or a two-step page's visually hidden username field still fill; their fixtures are in `test/fixtures/forms/`. One-time code fields keep the looser checks: some code inputs are transparent boxes drawn over digit cells.

Not covered: a field covered by another element, or drawn in the page's background color. Those need hit testing, which pages can fool as easily. Also not covered (#142): a mask from an image (`url()`), a mask sized or placed off the element, a `clip-path` of `path()`, `shape()` or `url()`, an SVG `filter`, and a clip-path value this can't read (an `em` length, a four-value position). Each counts as showing the field.

## Submit after filling

**Submit after filling** (off by default) submits the form once the login is in. It submits only to the page's own site (issue #130): `submit` in `src/content/forms.ts` resolves where the form would go, the clicked button's `formaction` or else the form's `action` (read as attributes, since a field named `action` shadows `form.action`), against the page's base URL, and `sameSiteAction` in `src/shared/hostMatch.ts` accepts it only when:

- it is http or https, and not plain http from an https page;
- its registrable domain (eTLD+1, private suffixes such as `github.io` included) is the page's, or for a host without one (an IP address, `localhost`), the host is the page's.

No action, an empty one, `#`, a relative path, the same origin and another host on the same site all submit. Anything else, `javascript:` included, is filled and left for the user to submit, so markup injected into the login's own site can't send the password elsewhere without a press of its Sign in button.

## Generating a password

**Suggest strong password**, on a new-password field, runs in that field's frame. It asks the worker for a password sized to the field's `maxlength` (from 12 to 20 characters) and fills the field and its confirmation.

Right-click › **Generate password** goes only to the frame you clicked (issue #74). The worker sends `fillGenerated` with that click's `frameId` (`src/background/index.ts`); when the browser doesn't report one, it uses frame 0, and it never broadcasts to the tab. The frame fills only the password field you are on, and only one you can see and reach (`fillGeneratedHere` in `src/content/index.ts`). A field that is off-screen, hidden, or kept out of keyboard reach is left alone, and there is no fallback to another field, so a page that embeds a sign-up iframe can't collect the password through fields of its own. A new-password field also fills its confirmation. The length is 20 characters, not the field's `maxlength`.

The popup's **Generate password** copies a new password and shows it masked, with **Show**, **Copy** and **Generate another** (issue #111). It stays only in the popup's memory: it is never stored, never sent to the live region that announces notices, and is forgotten when you dismiss it, the vault locks or the popup closes.

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

Scheme and port don't widen the match. A different port or scheme is shown as a labelled fallback and is never filled without a pick. A plain `http://` page is refused unless the host is `localhost`, `127.0.0.1` or `[::1]`, or the entry itself was saved with an `http://` URL (`mayFill`). That is narrower than loopback for a Quark address: `127.0.0.2` and `*.localhost` are not treated as secure pages.
