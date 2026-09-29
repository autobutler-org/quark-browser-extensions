import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const requested = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length) ?? "all";
const targets = requested === "all" ? ["chrome", "firefox"] : [requested];

const firefoxManifest = (base) => {
  const { minimum_chrome_version: _, options_page, background, ...rest } = base;
  return {
    ...rest,
    background: { scripts: [background.service_worker], type: "module" },
    options_ui: { page: options_page, open_in_tab: true },
    host_permissions: ["https://*/*", "http://*/*"],
    browser_specific_settings: {
      gecko: {
        id: "vault@autobutler.org",
        strict_min_version: "128.0",
        data_collection_permissions: { required: ["none"] },
      },
    },
  };
};

const manifests = { chrome: (base) => base, firefox: firefoxManifest };
const engines = { chrome: "chrome116", firefox: "firefox128" };

const configsFor = (target) => {
  const shared = {
    bundle: true,
    outdir: `dist/${target}`,
    target: engines[target],
    sourcemap: watch ? "inline" : false,
    minify: !watch,
    logLevel: "info",
  };
  return [
    { ...shared, entryPoints: { background: "src/background/index.ts" }, format: "esm" },
    {
      ...shared,
      entryPoints: { content: "src/content/index.ts", popup: "src/popup/index.ts", options: "src/options/index.ts" },
      format: "iife",
    },
  ];
};

const base = JSON.parse(await readFile("static/manifest.json", "utf8"));
if (!["chrome", "firefox"].includes(requested) && requested !== "all") {
  throw new Error(`unknown --target=${requested}`);
}

await Promise.all(
  targets.map(async (target) => {
    const outdir = `dist/${target}`;
    await rm(outdir, { recursive: true, force: true });
    await mkdir(outdir, { recursive: true });
    await cp("static", outdir, { recursive: true });
    await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifests[target](base), null, 2)}\n`);
  }),
);

const configs = targets.flatMap(configsFor);
if (watch) {
  const contexts = await Promise.all(configs.map((config) => context(config)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(configs.map((config) => build(config)));
}
