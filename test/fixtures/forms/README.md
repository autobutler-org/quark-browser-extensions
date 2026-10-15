# Login form fixtures

Small HTML pages for `test/forms.fixtures.test.ts`. Each fixture shows one pattern found on real login, sign-up, change-password, two-step and one-time-code pages, and tags its fields with `data-fx="…"` so the test can name them. `forms.ts` never reads `data-*` attributes, so the tags don't affect detection. Don't use `id`s for tagging: `forms.ts` does read those.

The test runs every `.html` file here and checks:

- which password fields `passwordFields` finds
- which username field `usernameFieldFor` pairs with each password field
- which field `standaloneUsernameField` picks for the identifier step of a two-step login
- which field `identifierField` gives the inline button: the identifier step only, never a page with a password or code field
- which fields `otpFields` reports
- which password fields `isNewPasswordField` accepts

A fixture with no matching row in the test fails the run. To add a fixture, write the page, tag its fields, then add a row for it.

## Writing a fixture

- Keep it short and write it by hand. Copy the pattern, not the page: no proprietary markup, scripts, branding or copy from real sites.
- Start with an HTML comment that says what the page is and what makes it hard.
- Shadow DOM uses declarative `<template shadowrootmode="open">`. jsdom doesn't parse that syntax, so the test attaches those roots itself.

## Sources

One fixture is saved rather than written: `login-flutter-quark.html` is the live DOM of Quark's own web login (#159), because what breaks there is the markup Flutter generates, and a hand-written copy would test a guess at it. Quark is MIT-0 like this repository.

Every other fixture here was written for this repository and falls under its MIT-0 licence. None is copied or derived from another project's files, so none needs attribution.

If you bring in a fixture based on an MPL-2.0 or MIT source, for example Firefox's LoginManager test pages (`toolkit/components/passwordmgr/test/`, MPL-2.0), list it below with its upstream path, licence and changes. An MPL-2.0 file also has to keep its licence header.

| Fixture | Upstream | Licence | Changes |
| ------- | -------- | ------- | ------- |
| `login-flutter-quark.html` | [autobutler-org/quark](https://github.com/autobutler-org/quark) 7ecf1021, `/login` as a Flutter 3.47.7 release build draws it | MIT-0 | Boot splash, scripts and Flutter's stylesheets left out; `data-fx` tags added |
