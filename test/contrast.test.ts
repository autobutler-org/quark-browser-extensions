import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast } from "../src/content/styles";

// The popup and options page take their colours from static/theme.css: dark tokens on :root, and the
// light ones override some of them under prefers-color-scheme: light.
const css = readFileSync(join(import.meta.dirname, "../static/theme.css"), "utf8");

const tokens = (block: string): Record<string, string> =>
  Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(([, name, value]) => [name, value]));

const lightStart = css.indexOf("@media (prefers-color-scheme: light)");
const dark = tokens(css.slice(0, lightStart));
const light = { ...dark, ...tokens(css.slice(lightStart, css.indexOf("}", css.indexOf("{", css.indexOf(":root", lightStart))))) };

describe.each([
  ["dark", dark],
  ["light", light],
] as const)("the %s popup theme", (_name, theme) => {
  const surfaces = ["bg", "card", "input"] as const;

  it("keeps text at 4.5:1 or more on every surface", () => {
    for (const surface of surfaces) {
      for (const text of ["fg", "muted", "accent", "error-fg"]) {
        expect(contrast(theme[text]!, theme[surface]!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(theme["error-fg"]!, theme["error-bg"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps button text on the primary colour at 4.5:1 or more", () => {
    expect(contrast(theme["primary-fg"]!, theme.primary!)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps control edges and the focus ring at 3:1 or more on every surface", () => {
    for (const surface of surfaces) {
      expect(contrast(theme.control!, theme[surface]!), `control on ${surface}`).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.focus!, theme[surface]!), `focus on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("theme.css", () => {
  it("draws the focus ring and input edges with the checked tokens", () => {
    expect(css).toMatch(/:focus-visible[^}]*outline: 2px solid var\(--focus\)/);
    expect(css).toMatch(/input\[type="search"\] \{[^}]*border: 1px solid var\(--control\)/);
  });
});

describe("the toolbar badge", () => {
  it("keeps its white count at 4.5:1 or more", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/background/index.ts"), "utf8");
    const color = /setBadgeBackgroundColor\(\{[^}]*color: "(#[0-9a-f]{6})"/i.exec(source)?.[1];
    expect(color).toBeDefined();
    expect(contrast("#ffffff", color!)).toBeGreaterThanOrEqual(4.5);
  });
});
