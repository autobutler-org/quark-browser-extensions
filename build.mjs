import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

const shared = {
  bundle: true,
  outdir,
  target: "chrome116",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

const configs = [
  {
    ...shared,
    entryPoints: { background: "src/background/index.ts" },
    format: "esm",
  },
  {
    ...shared,
    entryPoints: {
      content: "src/content/index.ts",
      popup: "src/popup/index.ts",
      options: "src/options/index.ts",
    },
    format: "iife",
  },
];

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("static", outdir, { recursive: true });

if (watch) {
  const contexts = await Promise.all(configs.map((config) => context(config)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(configs.map((config) => build(config)));
}
