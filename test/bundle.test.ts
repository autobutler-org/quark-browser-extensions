import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(__dirname, "..");

// Static value imports only: `import type` and `export type` are erased, and a dynamic import() loads lazily.
const importPattern = /^\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/gm;

const resolveLocal = (from: string, specifier: string): string => {
  const base = resolve(dirname(from), specifier);
  const file = [`${base}.ts`, `${base}/index.ts`, base].find((candidate) => existsSync(candidate));
  if (file === undefined) {
    throw new Error(`cannot resolve ${specifier} from ${from}`);
  }
  return file;
};

// Every package specifier an entry module loads at startup, following its local imports.
const packagesReachedFrom = (entry: string): ReadonlySet<string> => {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(importPattern)) {
      if (specifier.startsWith(".")) {
        visit(resolveLocal(file, specifier));
      } else {
        packages.add(specifier);
      }
    }
  };
  visit(resolve(root, entry));
  return packages;
};

const publicSuffixList = (packages: ReadonlySet<string>): readonly string[] =>
  [...packages].filter((name) => name === "tldts" || name.startsWith("tldts/"));

const keyDerivation = (packages: ReadonlySet<string>): readonly string[] =>
  [...packages].filter((name) => /^@noble\/hashes\/(argon2|blake2|hkdf)(\.js)?$/.test(name));

describe("what each extension page loads", () => {
  it.each(["src/popup/index.ts", "src/options/index.ts"])("%s does not load the public suffix list", (entry) => {
    expect(publicSuffixList(packagesReachedFrom(entry))).toEqual([]);
  });

  it.each(["src/popup/index.ts", "src/options/index.ts"])("%s does not load Argon2 or HKDF", (entry) => {
    expect(keyDerivation(packagesReachedFrom(entry))).toEqual([]);
  });

  it("the worker still loads the suffix list and the key derivation", () => {
    const packages = packagesReachedFrom("src/background/index.ts");
    expect(publicSuffixList(packages)).not.toEqual([]);
    expect(keyDerivation(packages)).toEqual(expect.arrayContaining(["@noble/hashes/argon2.js", "@noble/hashes/hkdf.js"]));
  });

  it("the content script still checks the suffix list in the frame", () => {
    expect(publicSuffixList(packagesReachedFrom("src/content/index.ts"))).not.toEqual([]);
  });
});
