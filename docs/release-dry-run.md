# Release dry run

A dry run of the packaging in `.github/workflows/release.yml` on 2026-10-14, at
`bea52b4` (version 0.1.0, WXT 0.21.4). It asks one question: would the
stores accept the zips? Nothing was uploaded.

**Result: all four zips could be submitted.** Nothing failed. The recorded run
gave two Firefox-minimum-version warnings; the current Firefox 140 minimum fixed
the desktop warning, leaving only the intentional Firefox-for-Android warning
described below.

## What was run

The build job's steps, from a clean `.output/`:

```sh
npm ci
npx wxt zip -b chrome
npx wxt zip -b firefox     # also writes the AMO sources zip
npx wxt zip -b edge
node scripts/release.js version
node scripts/verify-zip.js --rebuild-sources
npx web-ext lint --source-dir .output/firefox-mv3            # listed, as AMO checks it
npx web-ext lint --source-dir .output/firefox-mv3 --self-hosted
```

The zip commands also write the unpacked builds to `.output/chrome-mv3/`,
`.output/firefox-mv3/` and `.output/edge-mv3/`.

`scripts/verify-zip.js` is new. The build job now runs it after the version
check (see below).

| Zip | Size | Files | SHA-256 |
| --- | ---: | ---: | --- |
| `quark-vault-chrome.zip` | 153 kB | 19 | `26308877…f59439` |
| `quark-vault-edge.zip` | 153 kB | 19 | `26308877…f59439` |
| `quark-vault-firefox.zip` | 153 kB | 19 | `997c9f97…7288be` |
| `quark-vault-sources.zip` | 259 kB | 136 | `84fba4ee…7f7ecc` |

The Chrome and Edge zips are byte-identical. WXT gives Edge the Chrome manifest.

## What `scripts/verify-zip.js` checks

It reads each `quark-vault-*.zip` in `.output/` with its own small zip reader,
so it has no dependencies. It prints one `::error::` line per problem and
exits 1 if there are any.

| Check | Chrome | Firefox | Edge |
| --- | :-: | :-: | :-: |
| `manifest.json` at the root, `manifest_version` 3 | ✔ | ✔ | ✔ |
| `version` equals package.json (0.1.0) | ✔ | ✔ | ✔ |
| No `.map` files, no `//# sourceMappingURL=` | ✔ | ✔ | ✔ |
| No test files (`*.test.*`, `*.spec.*`, `test/`, `e2e/`) | ✔ | ✔ | ✔ |
| No localhost, 127.0.0.1, [::1], 0.0.0.0 or `ws:` in host permissions, permissions, content-script matches or the CSP (`wxt dev` adds these) | ✔ | ✔ | ✔ |
| Every icon in `icons` and `action.default_icon` exists and is a PNG of its declared size (16, 32, 48, 128) | ✔ | ✔ | ✔ |
| Every file the manifest names exists: background, popup, options page, content-script JS and CSS, `web_accessible_resources` globs (none are declared today) | ✔ | ✔ | ✔ |
| Every `src`/`href` in the packaged HTML pages exists (the Vite chunks and stylesheets) | ✔ | ✔ | ✔ |
| `default_locale` "en" has `_locales/en/messages.json`, every locale file parses, and every `__MSG_x__` in the manifest has a message | ✔ | ✔ | ✔ |
| Zip under 5 MB (our own flag; the Chrome Web Store allows 2 GB and AMO 200 MB) | ✔ | ✔ | ✔ |
| `browser_specific_settings.gecko.id` (`vault@autobutler.org`) and `strict_min_version` (140.0 or later) | – | ✔ | – |

The sources zip has its own checks. It has to hold `package.json`,
`package-lock.json`, `wxt.config.ts` and `docs/store/amo-notes.md`, and it
must not hold `node_modules/`, `.output/`, `.wxt/` or `.env` files. It passes
them all. It holds no `*.test.ts` or `*.spec.ts`. The `test/` helpers it does
hold (`fakeChrome.ts`, `fakeIndexedDB.ts`, `setup.ts`) are what
`tsconfig.json` and `vitest.config.ts` point at. The `e2e/` support code is
there too.

`test/zip.test.ts` unit-tests each check on in-memory fixtures. It also builds
small zips, one entry stored and one deflated, to test the reader. It doesn't
run a real build, because a build takes a few seconds and writes to `.output/`.

## AMO sources rebuild

The build steps in [docs/store/amo-notes.md](store/amo-notes.md), followed to
the letter in a clean scratch directory, with Node 22.23.2 and npm 10.9.8:

```sh
unzip quark-vault-sources.zip -d quark-vault && cd quark-vault
npm ci
npx wxt zip -b firefox
```

The rebuilt `.output/firefox-mv3/` and the submitted one match:
`diff -r` prints nothing. The rebuilt `quark-vault-firefox.zip`, and even the
rebuilt sources zip, are byte-identical to the originals, because WXT stamps
every zip entry with the same 1980 date. Node 26.8.2 gives the same result.
`verify-zip.js --rebuild-sources` repeats this and compares the two Firefox
zips file by file. It takes about a minute, mostly `npm ci`. The build job now
runs it, so a sources zip that no longer rebuilds the add-on fails the release
before anything is submitted.

`npm ci` in the rebuild prints deprecation warnings for `whatwg-encoding` and
for an `eslint@9` that a dependency pulls in. They don't affect the build.

## `web-ext lint`

0 errors and 0 notices, both as listed and with `--self-hosted`. The dry run
found two warnings:

- `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`: `strict_min_version` 128 was older
  than Firefox 140, the first version that reads `data_collection_permissions`.
- `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: the same for Firefox for
  Android, which reads it from 142.

[#153](https://github.com/autobutler-org/quark-browser-extensions/issues/153)
raised `strict_min_version` to 140.0 (and the Vite target to `firefox140`), so
the first warning is gone and `verify-zip.js` now refuses a Firefox zip below
140. The Android warning remains on purpose: the add-on is desktop-only and
declares no `gecko_android` block (see [store/permissions.md](store/permissions.md)).

## Changes made and follow-up

- Added `scripts/verify-zip.js` and its tests in `test/zip.test.ts`.
- Added a step to the build job in `.github/workflows/release.yml`, after the
  version check: `node scripts/verify-zip.js --rebuild-sources`.
- The original dry run did not change `wxt.config.ts`. The later fix for #153
  set `strict_min_version` to 140.0 and the Vite target to `firefox140`; the
  verifier now rejects an older Firefox minimum.

## Not checked here

- Store credentials and the `wxt submit` dry run. That needs the repository
  secrets, so it only runs in Actions.
- The original run did not check the listing text, screenshots or privacy policy
  ([docs/store/](store/)); those remain a separate release review.
