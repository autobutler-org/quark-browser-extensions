# Releasing

`.github/workflows/release.yml` builds the extension and submits it to the
Chrome Web Store, Firefox Add-ons (AMO) and Edge Add-ons with `wxt submit`
(publish-browser-extension, which comes with WXT).

| Trigger | What it does |
| --- | --- |
| Push a `vX.Y.Z` tag | Builds, checks the tag matches the version, uploads and submits for review to every store that is set up. |
| Pull request touching the release files | Builds, checks the versions agree, and runs a dry run. |
| Run workflow (Actions tab) | Dry run by default. Turned off, it publishes, but only when run from a tag. |

A dry run checks the Chrome and Firefox credentials against the store APIs
without uploading anything. Edge's dry run only checks that the zip exists.

Each job uploads the zips as the `quark-vault-release` artifact:
`quark-vault-chrome.zip`, `quark-vault-firefox.zip`, `quark-vault-sources.zip`
(the source code AMO asks for) and `quark-vault-edge.zip`.

A store takes part only when all of its secrets and variables below are set. A
store with none of them set is skipped quietly; one with only some set is
skipped with a warning. One store failing does not stop the others, but it does
fail the run.

## Secrets and variables

Set these under Settings → Secrets and variables → Actions. Secrets go on the
Secrets tab, variables on the Variables tab.

### Chrome Web Store (API v2, service account)

| Name | Kind | What it is |
| --- | --- | --- |
| `CHROME_EXTENSION_ID` | variable | The item ID from the Developer Dashboard. |
| `CHROME_PUBLISHER_ID` | variable | The publisher ID from the Developer Dashboard's account page. |
| `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | secret | The Google Cloud service account's email. |
| `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | secret | That service account's private key (the `private_key` field of its JSON key). |

### Firefox Add-ons

| Name | Kind | What it is |
| --- | --- | --- |
| `FIREFOX_JWT_ISSUER` | secret | The JWT issuer from AMO's API credentials page. |
| `FIREFOX_JWT_SECRET` | secret | The JWT secret from the same page. |
| `FIREFOX_EXTENSION_ID` | variable, optional | Defaults to `vault@autobutler.org`, the `gecko.id` in `wxt.config.ts`. |
| `FIREFOX_CHANNEL` | variable, optional | `listed` (the default) or `unlisted`. |

### Edge Add-ons

| Name | Kind | What it is |
| --- | --- | --- |
| `EDGE_PRODUCT_ID` | variable | The product ID from Partner Center. |
| `EDGE_CLIENT_ID` | secret | The Publish API client ID. |
| `EDGE_API_KEY` | secret | The Publish API key. |

## First submission to each store

None of the APIs can create a store item, so the first version goes in by hand.
Build it with `npx wxt zip -b chrome`, `npx wxt zip -b firefox` and
`npx wxt zip -b edge` (or take the zips from a dry run's artifact).

All three listings need a privacy policy URL. The extension handles
credentials, so say plainly that data goes only to the user's own Quark,
nothing goes to us, and decrypted passwords are never stored. The listing text,
screenshots (the e2e tests save 1280×800 ones with `E2E_SCREENSHOTS`) and
permission justifications are tracked in #4.

### Chrome Web Store

1. Register a developer account in the Chrome Web Store Developer Dashboard
   (one-time fee) and set up the publisher.
2. Add a new item and upload `quark-vault-chrome.zip`.
3. Fill in the store listing (description, category, 128px icon from
   `static/icons`, screenshots), the privacy tab (single purpose, a
   justification for each permission and for host access, the data usage
   disclosures, the privacy policy URL) and distribution. Publish as unlisted
   or private first.
4. Note the item ID (`CHROME_EXTENSION_ID`) and the publisher ID
   (`CHROME_PUBLISHER_ID`).
5. In Google Cloud, enable the Chrome Web Store API in a project, create a
   service account and a JSON key for it, and add the service account's email
   to the publisher in the Developer Dashboard. Store the email and the key's
   `private_key` as the two secrets.

### Firefox Add-ons (AMO)

1. Sign in to the AMO Developer Hub and submit a new add-on, choosing
   "On this site" (listed) or "On your own" (unlisted) to match
   `FIREFOX_CHANNEL`.
2. Upload `quark-vault-firefox.zip`. When asked whether you need to submit
   source code, answer yes: the add-on is bundled by WXT, so reviewers need
   `quark-vault-sources.zip` and the build steps. The steps are in
   `.github/amo-metadata.json`; paste them into the reviewer notes. The
   workflow sends that file as the approval notes and uploads the sources zip
   on every later version.
3. Fill in the listing: summary, description, categories, support email or
   site, licence (MIT-0) and privacy policy. The manifest already declares
   `data_collection_permissions: none`.
4. Generate API credentials under "Manage API Keys" and store the JWT issuer
   and secret as the two secrets.

### Edge Add-ons

1. Register for the Microsoft Edge program in Partner Center (free).
2. Create a new extension, upload `quark-vault-edge.zip`, and fill in
   availability, properties (category, privacy policy URL), the store listing
   and the testing notes. Submit it.
3. Note the product ID (`EDGE_PRODUCT_ID`).
4. Under Microsoft Edge → Publish API, enable the API and create credentials.
   Store the client ID and API key as the two secrets. The API key expires;
   Partner Center shows when, and an expired key fails only the Edge
   submission.

## Bumping the version

The tag, `package.json` and every built manifest must agree, or the build job
fails before anything is uploaded. Each store also refuses a version it has
already seen, so a failed submission needs a new patch version, not the same
tag again.

1. On a branch, set the new version:
   `npm version X.Y.Z --no-git-tag-version` (this updates `package.json` and
   `package-lock.json`). That is the only place to edit: WXT writes the
   version from `package.json` into every built manifest.
2. Open a pull request (`chore(release): vX.Y.Z`). The release workflow runs a
   dry run on it.
3. After it merges, tag the merge commit on `main` and push the tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Watch the release run. Chrome and Edge review it before it goes live; AMO
   signs listed versions after review.

To retry a store that failed for a reason other than the version (an expired
key, say), fix the cause and run the workflow from the tag with dry run off.
Stores that already took that version fail again with a duplicate-version
error, which is expected.
