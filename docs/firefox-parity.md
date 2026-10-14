# Firefox parity

The Firefox build supports Firefox 140 and later on desktop (`strict_min_version` 140.0) and Firefox for Android 142 and later (`gecko_android.strict_min_version` 142.0). Checked on Firefox 158.0 (`e2e/.firefox`, linux-stable) against the production build in `.output/firefox-mv3`. `npm run test:e2e:firefox:mock` passed all three smoke tests. The other rows come from a throwaway extension in that same Firefox (content scripts, `permissions.request`, the real toolbar popup, clipboard, alarms, menus, IndexedDB, and `storage.session`). An OS screen lock was not simulated; the screen-lock row is from Firefox 158's idle implementation plus a live `chrome.idle.queryState(60)`.

| Area | Chrome | Firefox | Status |
| --- | --- | --- | --- |
| Background | MV3 service worker | MV3 event page (`background.scripts`). `window`, `document`, and `indexedDB` are present. In-memory maps still die when the page suspends. | ok |
| `storage.session` | `setAccessLevel(TRUSTED_CONTEXTS)` keeps the live token off content scripts | `setAccessLevel` is missing. Content scripts have no `storage.session` (`get` and `set` throw), so the token stays unreadable. | ok |
| IndexedDB seal key | Non-extractable AES-GCM key in the extension origin | The same round trip succeeds in the event page. | ok |
| Commands | `fill-login` is Ctrl+Shift+L and the listener receives the active tab | `commands.getAll` reports that shortcut. Firefox 158 passes the active tab and grants `activeTab`. A synthetic Ctrl+Shift+L from WebDriver did not fire the command. | ok |
| Context menus | `onClicked` includes `frameId` | Creating the parent and its children without awaiting still installed every item. Firefox copies `frameId` from the clicked frame onto `onClicked`. | ok |
| `scripting` | Unused | The API exists and is unused | ok |
| Action popup | Body is 360×580 | The toolbar panel opens at 300×580. `scrollWidth` is 300, so the layout fits the panel (#108). An `html` width of 360px grows the panel to 360×580. | ok |
| `web_accessible_resources` | None. Page UI is a shadow tree. | None | ok |
| Host permissions | Content-script matches are granted at install. No `host_permissions`. | `host_permissions` are `https://*/*` and `http://*/*`, and the user can withhold them. Allow calls `permissions.request` for those origins. While they are granted the call returns true. After `permissions.remove`, Firefox shows its permission prompt; with that prompt turned off the same call grants the origins again and the content script injects on reload. | ok |
| CSP | `script-src 'self'; object-src 'none'; base-uri 'none'` | The same policy. `eval` throws `EvalError`. | ok |
| Tabs and frames | `tabs.sendMessage` without `frameId` reaches every frame | The same on 158: the top frame and a child iframe both received the message, and the first reply wins. `location.ancestorOrigins` is present; a child frame reported the top origin. | ok |
| Clipboard | The popup writes after the reveal round trip | `navigator.clipboard.writeText` on an extension page succeeds in the click turn and after an 800ms wait. | ok |
| Alarms | Unused | Unused. An alarm with `delayInMinutes: 0.02` was created. | ok |
| Screen lock | Idle state `"locked"` locks the vault even when lock-on-idle is off | `queryState` and `onStateChanged` only produce `"active"` and `"idle"`, so Firefox cannot see a screen lock. On Firefox the worker treats `"idle"` as the screen lock and locks the vault whether or not lock-on-idle is on. A locked screen therefore locks the vault once the idle time (15 minutes unless changed) passes with no input, not at the moment it locks, and an idle but unlocked computer locks it too. On Firefox the options page says so, and shows lock-on-idle as on and fixed, with the idle time always editable ([#151](https://github.com/autobutler-org/quark-browser-extensions/issues/151)). | fixed ([#132](https://github.com/autobutler-org/quark-browser-extensions/issues/132)) |

These differences are already handled in the Firefox build: the event page, `options_ui` (Chrome uses `options_page`), the frame-0 URL fallback for Firefox versions before `ancestorOrigins` (it arrived in Firefox 148, so the supported 140–147 still need it), shortcut steps in place of opening `about:addons`, and listing other password managers without a Turn off button (`canDisableOthers` is false).

`scripting`, `web_accessible_resources`, and `alarms` are unused, so differences in those APIs do not affect this extension.
