# Content script performance

An audit of what `src/content/**` costs on heavy pages, measured on 2026-10-14. The content script runs in every
frame of every http(s) page (`allFrames: true`, `matches: https://*/*, http://*/*`), so its idle cost is paid
everywhere, not only on login pages.

## How it works

- One `MutationObserver` on `document.documentElement` (`childList`, `subtree`) calls `scheduleScan`, a 400 ms
  trailing debounce. Attribute and text changes don't trigger it.
- `scan()` finds password, one-time-code and identifier fields, asks the worker for a `hello` once, and attaches a
  picker to fields it hasn't decorated yet.
- Field detection (`forms.ts`) walks the whole document with `querySelectorAll("*")`, recursing into every open
  shadow root, then filters. `isVisible` calls `getComputedStyle` on every ancestor of each candidate input.
- Each picker adds a host to `<body>` plus `scroll` (capture), `resize` and `mousedown` (capture) listeners.

## Method

`forms.ts`, `picker.ts` and `index.ts` bundled with Vite and loaded into headless Chromium (puppeteer-core) with a
stubbed `chrome.runtime`. Synthetic pages; timings are the median of 5 runs of the synchronous work one `scan()`
does (`passwordFields`, `otpFields`, `identifierField`, `isNewPasswordField`). Whole-document walks were counted by
wrapping `querySelectorAll("*")`. The harness was not committed; the scenarios are listed with each issue.

## Findings

| Page | Elements | One scan | Document walks |
| --- | ---: | ---: | ---: |
| Articles, no login form | 10,000 | 23 ms | 5 |
| Articles, no login form | 50,000 | 117 ms | 5 |
| Grid of 5,000 text inputs | 3,000 cells | 87 ms | 5 |
| 3,000 open shadow roots | 33,000 | 117 ms | 15,005 |
| Login form at depth 1,000 | 1,028 | 75 ms | 4 |
| 1 password field outside `<form>`, 2,000 inputs | 4,000 | 45 ms | 4 |
| 10 password fields outside `<form>` | 4,000 | 360 ms | 13 |
| 40 password fields outside `<form>` | 4,100 | 1,329 ms | 43 |

1. **Busy pages never get scanned.** The debounce only fires after 400 ms of quiet. A page that adds nodes more
   often than that (a clock, ticker, chat, carousel) starves it: with a 100 ms or 250 ms ticker, 0 scans ran in 6 s
   and a login form added at 1 s never got a picker. At 500 ms and 1,000 ms it appeared after ~460 ms. (#83)
2. **Every scan re-walks everything, on every page.** Each scan walks the whole document 5 times (each shadow root
   too), whether or not the mutation touched an input, and on pages with no login form at all. On the 50,000-element
   page with a node added every 500 ms, 20 scans in 10 s used 2.0 s of script time: 20% of the main thread for a
   page the extension has nothing to do on. (#84)
3. **Quadratic field matching.** `ancestors()` builds its list by recursive spread (O(depth²)), and `nearestGroup`
   compares every input's ancestor list for each password field outside a `<form>`. A deep tree or several
   formless password fields turn a scan into a long task of 75 ms to 1.3 s. (#85)
4. **Pickers outlive their fields.** Nothing destroys a picker when an SPA removes its field. After 60 form swaps:
   61 picker hosts in `<body>`, 61 `requestAnimationFrame` callbacks per scroll, and 64 `HTMLInputElement`s on the
   heap against 3 in the document (the listeners' closures keep the detached fields alive). Scroll cost stayed small
   (0.4 → 0.8 ms per frame), so the cost is memory and DOM growth over a long-lived tab. (#86)
5. **The `hello` is cached for the life of the tab.** If the vault is locked when a login form first appears, a
   form shown after unlocking (an SPA route change) gets no picker until the page is reloaded; new entries and
   changed settings are likewise ignored. Measured: one `hello` message, no picker after unlock. (#87)

## Checked and fine

- Listeners on `document` and `chrome.runtime.onMessage` are added once per frame; the observer is never
  disconnected, which is correct for a page-lifetime script.
- Pages with no input at all return before messaging the worker, and `fieldFocused` is answered from a per-origin
  cache in the worker, so focus doesn't rebuild the context menu each time.
- Scroll repositioning is batched into one `requestAnimationFrame` per picker.
