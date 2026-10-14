#!/usr/bin/env node
// Checks that the zips `wxt zip` makes are fit to submit to the stores.
//
//   node scripts/verify-zip.js [zip...]
//     Checks each zip (by default every quark-vault-*.zip in .output/). A
//     browser zip must hold an MV3 manifest at package.json's version, no
//     sourcemaps or test files, no localhost host permissions or CSP sources,
//     every icon at its declared size, every file the manifest and its HTML
//     pages name, and the default locale's messages for every __MSG_x__; a
//     Firefox zip also needs the gecko id and a strict_min_version of 140 or
//     later. The sources zip has to hold what docs/store/amo-notes.md builds
//     from. Anything over 5 MB is flagged.
//
//   node scripts/verify-zip.js --rebuild-sources
//     Also follows the build steps in docs/store/amo-notes.md in a scratch
//     directory (unzip the sources zip, `npm ci`, `npx wxt zip -b firefox`)
//     and checks the rebuilt add-on matches quark-vault-firefox.zip file for
//     file. Takes a minute or so; it needs the npm registry.
//
// Exits 1 with one `::error::` line per problem. RELEASE_ROOT swaps the repo
// root (package.json and .output/) like scripts/release.js does.
/* global process, console, Buffer */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export const MAX_ZIP_BYTES = 5 * 1024 * 1024;
// The first Firefox that reads browser_specific_settings.gecko.data_collection_permissions (#153).
const MIN_FIREFOX = 140;

// Reads every file in a zip into a Map of path → contents. Stored and deflated
// entries only, no zip64: all `wxt zip` writes.
export function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip: no end of central directory");
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("not a zip: bad central directory entry");
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + compressed);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`${name}: unsupported compression method ${method}`);
    if (files.get(name).length !== size) throw new Error(`${name}: size does not match the central directory`);
  }
  return files;
}

// Which store a zip is for, from WXT's artifact name (quark-vault-{{browser}}.zip).
export function zipKind(path) {
  const name = basename(path);
  if (name.includes("sources")) return "sources";
  for (const browser of ["firefox", "chrome", "edge"]) if (name.includes(browser)) return browser;
  return "chrome";
}

const testFile = /(^|\/)(test|tests|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const devHost = /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|^ws:/;

// Width and height of a PNG, or undefined when it is not one.
function pngSize(data) {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

// Strips the leading slash an extension URL has; manifest paths are relative to the root.
const clean = (path) => posix.normalize(path.replace(/^\//, ""));

// Every problem with a browser zip's files, as messages. An empty list means it passes.
export function checkExtension(files, { version, browser, zipBytes }) {
  const problems = [];
  const has = (path) => files.has(clean(path));

  if (zipBytes !== undefined && zipBytes > MAX_ZIP_BYTES) {
    problems.push(`is ${(zipBytes / 1024 / 1024).toFixed(1)} MB, over the 5 MB we allow`);
  }
  const raw = files.get("manifest.json");
  if (raw === undefined) return [...problems, "has no manifest.json at its root"];
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    return [...problems, `manifest.json is not JSON: ${error.message}`];
  }

  if (manifest.manifest_version !== 3) problems.push(`manifest_version is ${manifest.manifest_version}, not 3`);
  if (manifest.version !== version) problems.push(`manifest version ${manifest.version} is not package.json's ${version}`);

  for (const name of files.keys()) {
    if (name.endsWith(".map")) problems.push(`ships the sourcemap ${name}`);
    else if (testFile.test(name)) problems.push(`ships the test file ${name}`);
    else if (/\.[cm]?js$/.test(name) && /^\/\/# sourceMappingURL=/m.test(files.get(name).toString("utf8"))) {
      problems.push(`${name} links a sourcemap`);
    }
  }

  const hostLists = {
    host_permissions: manifest.host_permissions,
    optional_host_permissions: manifest.optional_host_permissions,
    permissions: manifest.permissions,
    ...Object.fromEntries((manifest.content_scripts ?? []).map((script, i) => [`content_scripts[${i}].matches`, script.matches])),
  };
  for (const [key, list] of Object.entries(hostLists)) {
    for (const entry of list ?? []) if (devHost.test(entry)) problems.push(`${key} has the dev-only ${entry}`);
  }
  const csp = manifest.content_security_policy;
  for (const policy of typeof csp === "string" ? [csp] : Object.values(csp ?? {})) {
    if (devHost.test(policy)) problems.push(`content_security_policy allows a dev server: ${policy}`);
  }

  const icons = [
    ["icons", manifest.icons],
    ["action.default_icon", manifest.action?.default_icon],
  ];
  for (const [key, set] of icons) {
    if (typeof set === "string") {
      if (!has(set)) problems.push(`${key} ${set} is missing`);
      continue;
    }
    for (const [size, path] of Object.entries(set ?? {})) {
      const data = files.get(clean(path));
      if (data === undefined) {
        problems.push(`${key} ${size}: ${path} is missing`);
        continue;
      }
      const png = pngSize(data);
      if (png === undefined) problems.push(`${key} ${size}: ${path} is not a PNG`);
      else if (png.width !== Number(size) || png.height !== Number(size)) {
        problems.push(`${key} ${size}: ${path} is ${png.width}x${png.height}`);
      }
    }
  }

  const referenced = [
    ["background.service_worker", manifest.background?.service_worker],
    ...(manifest.background?.scripts ?? []).map((path) => ["background.scripts", path]),
    ["background.page", manifest.background?.page],
    ["action.default_popup", manifest.action?.default_popup],
    ["options_page", manifest.options_page],
    ["options_ui.page", manifest.options_ui?.page],
    ["side_panel.default_path", manifest.side_panel?.default_path],
    ["devtools_page", manifest.devtools_page],
    ...Object.entries(manifest.chrome_url_overrides ?? {}).map(([key, path]) => [`chrome_url_overrides.${key}`, path]),
    ...(manifest.content_scripts ?? []).flatMap((script, i) =>
      [...(script.js ?? []), ...(script.css ?? [])].map((path) => [`content_scripts[${i}]`, path]),
    ),
  ];
  for (const [key, path] of referenced) {
    if (path !== undefined && !has(path)) problems.push(`${key} names ${path}, which is missing`);
  }
  for (const [i, entry] of (manifest.web_accessible_resources ?? []).entries()) {
    for (const resource of entry.resources ?? []) {
      const pattern = globToRegExp(clean(resource));
      if (![...files.keys()].some((name) => pattern.test(name))) {
        problems.push(`web_accessible_resources[${i}] names ${resource}, which matches no file`);
      }
    }
  }

  // The scripts and stylesheets each packaged page loads.
  for (const [name, data] of files) {
    if (!name.endsWith(".html")) continue;
    for (const [, path] of data.toString("utf8").matchAll(/\s(?:src|href)="([^"]+)"/g)) {
      if (/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(path)) continue;
      const target = path.startsWith("/") ? clean(path) : posix.join(posix.dirname(name), path);
      if (!files.has(target)) problems.push(`${name} loads ${path}, which is missing`);
    }
  }

  const locales = [...files.keys()].filter((name) => /^_locales\/[^/]+\/messages\.json$/.test(name));
  const messages = new Map();
  for (const name of locales) {
    try {
      messages.set(name.split("/")[1], JSON.parse(files.get(name).toString("utf8")));
    } catch (error) {
      problems.push(`${name} is not JSON: ${error.message}`);
    }
  }
  const usedKeys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+?)__/g)].map(([, key]) => key);
  if (manifest.default_locale === undefined) {
    if (locales.length > 0) problems.push("has _locales but no default_locale");
    if (usedKeys.length > 0) problems.push(`uses __MSG_${usedKeys[0]}__ but has no default_locale`);
  } else if (!files.has(`_locales/${manifest.default_locale}/messages.json`)) {
    problems.push(`default_locale is ${manifest.default_locale} but _locales/${manifest.default_locale}/messages.json is missing`);
  } else {
    const defaults = messages.get(manifest.default_locale) ?? {};
    // The message keys are case-insensitive in every browser.
    const known = new Set(Object.keys(defaults).map((key) => key.toLowerCase()));
    for (const key of new Set(usedKeys)) {
      if (!known.has(key.toLowerCase())) problems.push(`the manifest uses __MSG_${key}__, which _locales/${manifest.default_locale} lacks`);
    }
  }

  if (browser === "firefox") {
    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko?.id) problems.push("has no browser_specific_settings.gecko.id");
    if (!gecko?.strict_min_version) problems.push("has no browser_specific_settings.gecko.strict_min_version");
    else if (parseInt(gecko.strict_min_version, 10) < MIN_FIREFOX) {
      problems.push(
        `has browser_specific_settings.gecko.strict_min_version ${gecko.strict_min_version}; Firefox before ${MIN_FIREFOX} ignores data_collection_permissions`,
      );
    }
  }
  return problems;
}

// What the AMO build steps need from the sources zip, and what it must leave out.
export function checkSources(files, { zipBytes } = {}) {
  const problems = [];
  if (zipBytes !== undefined && zipBytes > MAX_ZIP_BYTES) {
    problems.push(`is ${(zipBytes / 1024 / 1024).toFixed(1)} MB, over the 5 MB we allow`);
  }
  for (const needed of ["package.json", "package-lock.json", "wxt.config.ts", "docs/store/amo-notes.md"]) {
    if (!files.has(needed)) problems.push(`has no ${needed}, which the AMO build steps need`);
  }
  for (const name of files.keys()) {
    if (/^(node_modules|\.output|\.wxt)\//.test(name)) problems.push(`ships the build directory file ${name}`);
    else if (/(^|\/)\.env(\.|$)/.test(name)) problems.push(`ships the env file ${name}`);
  }
  return problems;
}

// Paths that differ between two zips' files, as messages.
export function diffFiles(expected, actual) {
  const problems = [];
  for (const [name, data] of expected) {
    const other = actual.get(name);
    if (other === undefined) problems.push(`${name} is missing from the rebuild`);
    else if (!other.equals(data)) problems.push(`${name} differs in the rebuild`);
  }
  for (const name of actual.keys()) if (!expected.has(name)) problems.push(`${name} is only in the rebuild`);
  return problems;
}

// Follows docs/store/amo-notes.md's build steps in a scratch directory and
// returns the files of the add-on zip it makes.
function rebuildFromSources(sourcesZip) {
  const scratch = mkdtempSync(join(tmpdir(), "amo-rebuild-"));
  try {
    const dir = join(scratch, "quark-vault");
    for (const [name, data] of readZip(readFileSync(sourcesZip))) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), data);
    }
    const run = (args) => execFileSync("npx", args, { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("npm", ["ci"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
    run(["wxt", "zip", "-b", "firefox"]);
    return readZip(readFileSync(join(dir, ".output", "quark-vault-firefox.zip")));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv) {
  const root = process.env.RELEASE_ROOT ?? resolve(import.meta.dirname, "..");
  const output = join(root, ".output");
  const rebuild = argv.includes("--rebuild-sources");
  let zips = argv.filter((arg) => !arg.startsWith("--"));
  if (zips.length === 0) {
    zips = readdirSync(output)
      .filter((name) => /^quark-vault-.*\.zip$/.test(name))
      .map((name) => join(output, name));
  }
  if (zips.length === 0) {
    console.log(`::error::no quark-vault-*.zip in ${output}; run \`wxt zip\` first`);
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  let failed = false;
  for (const zip of zips) {
    const kind = zipKind(zip);
    const zipBytes = statSync(zip).size;
    const files = readZip(readFileSync(zip));
    const problems =
      kind === "sources" ? checkSources(files, { zipBytes }) : checkExtension(files, { version, browser: kind, zipBytes });
    if (kind === "sources" && rebuild) {
      const submitted = zips.find((other) => zipKind(other) === "firefox") ?? join(output, "quark-vault-firefox.zip");
      problems.push(...diffFiles(readZip(readFileSync(submitted)), rebuildFromSources(zip)));
    }
    for (const problem of problems) console.log(`::error::${basename(zip)} ${problem}`);
    if (problems.length === 0) {
      const note = kind === "sources" && rebuild ? ", rebuilds the Firefox zip exactly" : "";
      console.log(`${basename(zip)}: ok (${files.size} files, ${(zipBytes / 1024).toFixed(0)} kB${note})`);
    }
    failed ||= problems.length > 0;
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main(process.argv.slice(2));
