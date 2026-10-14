# Second security review

A fresh pass over credential handling after the fixes for #74 (generate goes only to the clicked frame), #75 (sealed session restore), #76 (one-time legacy upgrade), #129 (hidden-field rule), #130 (same-site submit), and #132 (Firefox idle lock). The question was whether those fixes can be bypassed, and whether anything next to them is open.

No `src/` files were changed. Each confirmed failure below was shown by a scratch unit test (not committed) or by a headless Chromium measurement the unit test then encoded. Issues are filed for the failures only.

## What was checked

- `docs/security.md`, `docs/hostile-pages.md`, `docs/legacy-upgrade.md`
- `src/background/storage.ts`, `gate.ts`, `index.ts`, `idle.ts`, and `sealKey.ts` where storage calls it
- `src/content/forms.ts`, `index.ts`, `picker.ts`, `frame.ts`
- `src/shared/api.ts`, `authKey.ts`, `hostMatch.ts`, `host.ts`, `settings.ts`

Bypass classes that were tried on purpose: `clip-path`, `transform`, `mask`, `filter`, `pointer-events`, `content-visibility`, `visibility: collapse`, zero-size and off-screen iframes, open and closed shadow slots, `formaction` outside the form, `<base href>`, `javascript:` and `data:` actions, fetch redirects, wiping or replaying sealed storage, wiping the legacy-upgrade record, spending one consent twice, and message-gate checks on sender frame and tab.

## What held

**#129, for the styles it names.** `opacity: 0`, a 1px box, `display: none`, `visibility: hidden`, `[hidden]`, `tabindex="-1"`, `aria-hidden`, and an off-screen position are still rejected. `transform: scale(0)` computes to an empty border box and fails the 4px check. `clip-path: inset(50%)` and `circle(0)` match `clipsAway`. A closed `<details>` and `content-visibility: hidden` on an ancestor fail `checkVisibility()`. `content-visibility: hidden` on the input itself is still hit-tested in Chromium, so it is not a hide. `pointer-events: none` leaves the field painted. Overlay and background-color camouflage stay out of scope, as `docs/security.md` says.

**Suggest password re-checks.** `suggest` calls `fillNewPassword`, which goes through `newPasswordGroup` and therefore `isLoginField`. Hiding a new-password field with `opacity: 0` after the picker is attached leaves it empty. It fails open only on the styles in #142.

**#130, for form submit.** `sameSiteAction` rejects `javascript:` (any capitalization), `data:`, `blob:`, an https-to-http downgrade, a protocol-relative URL, a userinfo or backslash host, and a public-suffix lookalike (`login.example.com.evil.test`). An empty action is the document URL, not the `<base href>`. A relative action is resolved against the base URL and then refused when that host is another site. A submit button that lives outside the form, an `input type="image"`, and `formaction=""` do not redirect the auto-submit. A sibling host such as `notlogin.example.com` is the same registrable domain as `login.example.com` and is accepted on purpose.

**#74.** Generate-from-the-menu is sent with the click's `frameId`, and falls back to frame 0 only when the browser omits it. Chrome 116 and Firefox 140 always set it. `fillGeneratedHere` fills only the focused password field, and only when `passwordFields` contains it and `onScreen` passes. There is no broadcast and no fallback field.

**#75.** The seal is AES-GCM with the server as associated data. A tampered blob, a blob moved to another server, or a planted plaintext `connection` fails closed and does not replace the sealed record. The key lives in the extension origin's IndexedDB. Content scripts cannot open that database or `storage.session`. `restrictSessionStorage` asks for `TRUSTED_CONTEXTS`; Chrome 116+ already defaults to it when the call is not awaited. No downgrade or replay turned up beyond the cases `test/storage.test.ts` already covers.

**Gate.** Extension pages must present this extension's id and a URL under `chrome.runtime.getURL("")`. Content scripts must present a tab and a non-extension URL. `captured`, `myOffer`, and `resolveSave` are top-frame only. `reveal`, `unlock`, `connect`, and `fillAnyway` are extension-page only. `fillFromPage` and `otpFromPage` re-check the browser-reported frame URL and the top URL. `whereAmI` is answered by the frame-0 content script from `location.href`. A compromised renderer that lies there is the threat model the worker already treats as untrusted for storage; the worker still checks `sender.url` on the credential request itself.

**#132.** `idleAction` matches the code and the tests: Firefox treats `idle` as a lock because the platform never reports `locked`. The screen lock is noticed only after the detection interval (up to 30 minutes). That delay is the Firefox API limit documented with the fix, not a logic bug.

**#76, except the two holes below.** The password is withheld on non-loopback `http`, when `hasKey` is true, and when there is no fresh consent. Consent lives in `storage.session` and is removed on read. Usernames match case-insensitively, trimmed.

## What did not hold

Six issues, each with a failing scratch test.

| Issue | Severity | Hole |
| --- | --- | --- |
| [#142](https://github.com/autobutler-org/quark-browser-extensions/issues/142) | medium | `isLoginField` still accepts `visibility: collapse`, `filter: opacity(0)` (including on an ancestor), a transparent `mask-image`, and the `clip-path` strings Chromium actually computes (`inset(100px)`, `inset(0 100% 0 0)`, a zero polygon, `rect()` rewritten to `inset(0px 100% 100% 0px)`, `circle(1px)`, `ellipse(50px 0px)`). `fillLogin` then puts the password in that decoy and leaves the real form empty. |
| [#139](https://github.com/autobutler-org/quark-browser-extensions/issues/139) | medium | A light-DOM password field slotted into an open or closed shadow, clipped by a 0×0 `overflow: hidden` wrapper or a zero `clip-path` in that shadow, keeps a full border box. `parentOf` walks the host, not the slot. A closed shadow has `shadowRoot === null`, so the clipper cannot be read. `isLoginField` returns true. |
| [#141](https://github.com/autobutler-org/quark-browser-extensions/issues/141) | medium | `fillInTab` fills every matching frame. A field inside a 0×0, 1×1, opacity-0, off-screen, or `clip-path: inset(100%)` iframe still has a full inner border box and `checkVisibility() === true`. `passwordFields` on the inner document returns it. A same-site child frame is allowed by `frameMayFill`. |
| [#143](https://github.com/autobutler-org/quark-browser-extensions/issues/143) | medium | `keyedAccounts` is in `chrome.storage.local`. After `markKeyed`, removing that key and consenting again makes `login` post the password. #76's "never twice" record is writable by a content script. |
| [#144](https://github.com/autobutler-org/quark-browser-extensions/issues/144) | medium | `send` follows redirects. A 307 from the consented loopback origin delivered `{"username":"brandon","password":"s3cret-password","authKey":"key"}` to a different port. `unlock` and entry writes use the same helper. |
| [#140](https://github.com/autobutler-org/quark-browser-extensions/issues/140) | low | `takeConsent` is get-then-remove. Two overlapping `login` calls after one `giveConsent` both posted the password. Both went to the consented server. |

Chromium measurements behind #142, #139, and #141: for the styles in #142, `checkVisibility()` is true and the border box stays full, while `elementFromPoint` misses the input for `visibility: collapse`, a zero polygon, and `inset(100px)`. `filter: opacity(0)` and a transparent mask are hit-tested and still invisible. For #141 the inner field stayed about 185×21 with `checkVisibility()` true inside a 0×0 frame (inner viewport 0×0), a 1×1 frame, an 800×600 opacity-0 frame parked at `left: -10000px`, and a frame with `clip-path: inset(100%)`.

## Considered and not filed

- **Sibling hosts.** `sameSiteAction("https://notlogin.example.com/collect", "https://login.example.com/signin")` is true. Both are `example.com`. That is the #130 rule.
- **`content-visibility: hidden` on the field.** Chromium still hit-tests it and `checkVisibility()` is true. Not a bypass.
- **Settings in `storage.local`.** `lockOnIdle`, `autoSubmit`, and `inlineButton` are decoded from `storage.local`, which a content script can write. Turning off lock-on-idle does not stop the Firefox idle lock. `autoSubmit` still has to pass `sameSiteAction`. Worth knowing; not a separate hole beyond #143's store.
- **Idle detection delay.** Up to `idleMinutes` before Firefox observes a locked screen. Documented with #132.
- **Compromised-renderer lies about `location.href` in `whereAmI`.** The worker's credential decision uses `sender.url`. Not filed.

## How it was checked

Scratch tests lived in `test/security-review-2.scratch.test.ts` while they ran, then were deleted so `npm run check` does not execute them. They are not part of this commit. The redirect test used Node's `fetch` against two `127.0.0.1` listeners. Layout facts came from headless Chromium via Playwright, because jsdom has no layout and will happily report a full box for a style Chromium clips.
