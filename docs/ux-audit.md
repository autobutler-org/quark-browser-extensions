# UX audit, October 2026

I walked the built Chrome extension (`npm run build:chrome`) in headless Chromium. It used the Playwright fixtures in `e2e/` against the offline mock Quark (`E2E_TARGET=mock`), because no `quark` binary was built. Small stub servers stood in for the 426, too-old-Quark, 500 and 429 replies. The popup ran as a tab at its own 360×580 size, and also at 320, 300 and 250 px wide. Each step got a screenshot, which I then looked at. The screenshots aren't committed.

## What was walked

| Flow | Result |
| --- | --- |
| First run: welcome banner, Read, Got it | Works; the copy is clear. The connect form gets no initial focus (#109). |
| Connect: wrong password, unknown user | Correct message ("Invalid username or password."), but the form clears the address and username (#98). |
| Connect: plain-http LAN address | The confirm tick appears and blocks submit until ticked. Works. |
| Connect: address without a scheme (`quark.local`) | Blocked by the browser with "Please enter a URL." (#99). |
| Connect: server unreachable | Generic message with no "tried https://…" hint, unlike the saved-connection screen (#100). |
| Connect: 426, Quark too old, 500, 429 | Each shows the right message. The form clears each time (#98). |
| Legacy upgrade tick (#76) | Asks, names the host, the tick blocks submit, and the upgrade then lands on Unlock. The password and "Stay signed in" are cleared when it asks (#98). |
| Unreachable after connecting, Edit address | Hint and Edit address work. The heading is the full sentence and repeats the hint (#112). Edit address drops the username (#98). |
| Unlock: wrong vault password, then right | Works. |
| Lock | Works; lands on Unlock. |
| Search | Works. No results shows only "All entries · 0" (#110). |
| Fill: popup over a login page, inline picker, Fill anyway | Fill works. The Fill anyway warning is cramped (#105). Rows with Fill anyway overlap their host text (#106). |
| Save offer after sign-in | In-page bar and popup banner both show and work. |
| Update offer | In-page bar fine. The popup banner truncates its title and wraps "Not now" (#104). |
| Generate password | Copies, but never shows the password (#111). |
| TOTP copy | Copies with a countdown that never updates. The notice stays forever, even beside a later error (#102). Every row offers a code, even with no secret (#103). |
| Sign-up page picker | The confirm field's Quark button draws over the open picker (#107). |
| Long vault list (42 entries, long names and hosts) | Scrolls. Long names truncate with no way to read them (#106). |
| Narrow popup (<360 px) | Scrolls sideways, clips the Lock button and footer (#108). |
| Dark mode: popup, picker, save bar, options | Reads well. No problems found. |
| Light mode success text | `--success` is 2.4:1 on the light background (#101). |
| Options page, wide and 400 px, keyboard focus | Layout and focus rings fine. |

## Not walked

- Against a real `quark serve`: no binary in this checkout (`scripts/build-quark.sh` needs `QUARK_SRC`).
- The real toolbar popup. Headless Chromium can't click the action, so the popup ran as a tab, with `chrome.tabs.query` stubbed to report the login tab, as `activeTab` would.
- Firefox.
