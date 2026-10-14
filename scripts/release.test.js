// Tests for scripts/release.js, run with `npm run test:scripts` (node:test, so
// they stay out of the extension's Vitest suite). Each test runs the script the
// way the release workflow does, against a scratch repo root.
/* global process */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dirname, "release.js");

// A scratch root holding package.json at `version` and the three built manifests.
function fakeRoot(version, manifests = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-test-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  for (const dir of ["chrome-mv3", "firefox-mv3", "edge-mv3"]) {
    mkdirSync(join(root, ".output", dir), { recursive: true });
    writeFileSync(join(root, ".output", dir, "manifest.json"), JSON.stringify({ version: manifests[dir] ?? version }));
  }
  writeFileSync(join(root, "env"), "");
  writeFileSync(join(root, "out"), "");
  return root;
}

function run(root, command, env = {}) {
  const result = spawnSync(process.execPath, [script, command], {
    encoding: "utf8",
    // Only what the test passes: no store credentials leak in from the shell.
    env: {
      PATH: process.env.PATH,
      RELEASE_ROOT: root,
      GITHUB_ENV: join(root, "env"),
      GITHUB_OUTPUT: join(root, "out"),
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    env: readFileSync(join(root, "env"), "utf8"),
    out: readFileSync(join(root, "out"), "utf8"),
  };
}

const chrome = {
  CHROME_EXTENSION_ID: "abc",
  CHROME_PUBLISHER_ID: "pub",
  CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL: "ci@example.iam.gserviceaccount.com",
  CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: "key",
};
const firefox = { FIREFOX_EXTENSION_ID: "vault@autobutler.org", FIREFOX_JWT_ISSUER: "user:1", FIREFOX_JWT_SECRET: "s" };
const edge = { EDGE_PRODUCT_ID: "p", EDGE_CLIENT_ID: "c", EDGE_API_KEY: "k" };

test("version passes when the tag matches package.json and every manifest", () => {
  const r = run(fakeRoot("1.2.3"), "version", { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3", DRY_RUN: "false" });
  assert.equal(r.status, 0, r.stdout);
});

test("version fails when the tag names another version", () => {
  const r = run(fakeRoot("1.2.3"), "version", { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.4", DRY_RUN: "false" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::tag v1\.2\.4 does not match version 1\.2\.3/);
});

test("version fails when a manifest lags package.json", () => {
  const r = run(fakeRoot("1.2.3", { "firefox-mv3": "1.2.2" }), "version", { GITHUB_REF_TYPE: "branch", DRY_RUN: "true" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /firefox-mv3\/manifest\.json has version 1\.2\.2/);
});

test("version refuses a real publish from a branch", () => {
  const r = run(fakeRoot("1.2.3"), "version", { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main", DRY_RUN: "false" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /has to run from a version tag/);
});

test("version allows a dry run from a branch", () => {
  const r = run(fakeRoot("1.2.3"), "version", { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main", DRY_RUN: "true" });
  assert.equal(r.status, 0, r.stdout);
});

test("stores picks every store whose credentials are all set", () => {
  const root = fakeRoot("1.0.0");
  const r = run(root, "stores", { ...chrome, ...firefox, ...edge });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out, "stores=chrome,firefox,edge\n");
  const out = join(root, ".output");
  assert.equal(
    r.env,
    [
      `CHROME_ZIP=${join(out, "quark-vault-chrome.zip")}`,
      "CHROME_API_VERSION=v2",
      `FIREFOX_ZIP=${join(out, "quark-vault-firefox.zip")}`,
      `FIREFOX_SOURCES_ZIP=${join(out, "quark-vault-sources.zip")}`,
      `EDGE_ZIP=${join(out, "quark-vault-edge.zip")}`,
      "",
    ].join("\n"),
  );
});

test("stores skips a store with no credentials without failing the others", () => {
  const r = run(fakeRoot("1.0.0"), "stores", { ...firefox });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out, "stores=firefox\n");
  assert.doesNotMatch(r.env, /CHROME_ZIP|EDGE_ZIP/);
  assert.match(r.stdout, /Chrome Web Store: not set up, skipped/);
});

test("stores warns about and skips a store that is half set up", () => {
  const r = run(fakeRoot("1.0.0"), "stores", { ...chrome, EDGE_PRODUCT_ID: "p", EDGE_CLIENT_ID: " " });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out, "stores=chrome\n");
  assert.match(r.stdout, /::warning::Edge Add-ons skipped: EDGE_CLIENT_ID, EDGE_API_KEY not set/);
});

test("stores submits nothing when no store is set up", () => {
  const r = run(fakeRoot("1.0.0"), "stores");
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.out, "stores=\n");
  assert.equal(r.env, "");
});
