#!/usr/bin/env node
// Helpers for .github/workflows/release.yml.
//
//   node scripts/release.js version
//     Checks that package.json and every built manifest in .output/ carry the
//     same version, and that a release tag (vX.Y.Z) names that version. A real
//     publish (DRY_RUN=false) has to run from a tag.
//
//   node scripts/release.js stores
//     Picks the stores `wxt submit` uploads to: a store takes part only when all
//     of its credentials are set, so a store nobody has set up yet never fails
//     the others. It points `wxt submit` at that store's zip by appending
//     CHROME_ZIP, FIREFOX_ZIP and so on to $GITHUB_ENV, and writes
//     `stores=chrome,firefox` to $GITHUB_OUTPUT (empty when none is set up).
//
// Both read the GitHub Actions environment: GITHUB_REF_TYPE, GITHUB_REF_NAME,
// DRY_RUN, GITHUB_ENV, GITHUB_OUTPUT, and the store credentials themselves.
// RELEASE_ROOT swaps the repo root (package.json and .output/) for the tests.
/* global process, console */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.env.RELEASE_ROOT ?? resolve(import.meta.dirname, "..");
const output = join(root, ".output");

// What each store needs before `wxt submit` can use it, and the env vars that
// point it at the zips the build job made.
const stores = {
  chrome: {
    name: "Chrome Web Store",
    required: [
      "CHROME_EXTENSION_ID",
      "CHROME_PUBLISHER_ID",
      "CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL",
      "CHROME_SERVICE_ACCOUNT_PRIVATE_KEY",
    ],
    env: { CHROME_ZIP: "quark-vault-chrome.zip", CHROME_API_VERSION: "v2" },
  },
  firefox: {
    name: "Firefox Add-ons",
    required: ["FIREFOX_EXTENSION_ID", "FIREFOX_JWT_ISSUER", "FIREFOX_JWT_SECRET"],
    env: { FIREFOX_ZIP: "quark-vault-firefox.zip", FIREFOX_SOURCES_ZIP: "quark-vault-sources.zip" },
  },
  edge: {
    name: "Edge Add-ons",
    required: ["EDGE_PRODUCT_ID", "EDGE_CLIENT_ID", "EDGE_API_KEY"],
    env: { EDGE_ZIP: "quark-vault-edge.zip" },
  },
};

const manifests = ["chrome-mv3", "firefox-mv3", "edge-mv3"];

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function readVersion(path) {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

function checkVersion(env) {
  const expected = readVersion(join(root, "package.json"));
  for (const dir of manifests) {
    const path = join(output, dir, "manifest.json");
    if (!existsSync(path)) fail(`${path} is missing; run \`wxt zip\` for every browser first`);
    const version = readVersion(path);
    if (version !== expected) {
      fail(`${dir}/manifest.json has version ${version} but package.json has ${expected}; rebuild after bumping package.json (see .github/RELEASING.md)`);
    }
  }
  if (env.GITHUB_REF_TYPE === "tag") {
    if (env.GITHUB_REF_NAME !== `v${expected}`) {
      fail(`tag ${env.GITHUB_REF_NAME} does not match version ${expected}; tag v${expected} instead`);
    }
  } else if (env.DRY_RUN === "false") {
    fail("a real publish has to run from a version tag; pick the tag in “Use workflow from”, or keep dry run on");
  }
  console.log(`Version ${expected}`);
}

function pickStores(env) {
  const picked = [];
  const lines = [];
  for (const [id, store] of Object.entries(stores)) {
    const missing = store.required.filter((name) => !env[name]?.trim());
    if (missing.length === store.required.length) {
      console.log(`${store.name}: not set up, skipped`);
      continue;
    }
    if (missing.length > 0) {
      console.log(`::warning::${store.name} skipped: ${missing.join(", ")} not set`);
      continue;
    }
    picked.push(id);
    for (const [name, value] of Object.entries(store.env)) {
      lines.push(`${name}=${value.endsWith(".zip") ? join(output, value) : value}`);
    }
    console.log(`${store.name}: submitting`);
  }
  if (picked.length === 0) console.log("::notice::No store has its credentials set; nothing to submit");
  if (env.GITHUB_ENV && lines.length > 0) appendFileSync(env.GITHUB_ENV, lines.map((l) => `${l}\n`).join(""));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `stores=${picked.join(",")}\n`);
}

const command = process.argv[2];
if (command === "version") checkVersion(process.env);
else if (command === "stores") pickStores(process.env);
else fail(`usage: node scripts/release.js version|stores (got ${command ?? "nothing"})`);
