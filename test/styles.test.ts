import { adoptStyles, contrast, dark, light, themeCss, type Theme } from "../src/content/styles";

describe("contrast", () => {
  it("matches the WCAG formula at the extremes and for a known pair", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // The old primary that #27 reported at 4.10:1.
    expect(contrast("#ffffff", "#0284c7")).toBeCloseTo(4.1, 1);
  });
});

describe.each([
  ["dark", dark],
  ["light", light],
] as const)("the %s theme", (_name, theme: Theme) => {
  const text = ["fg", "muted", "accent", "warn", "error-fg"] as const;

  it.each(["card", "hover"] as const)("keeps every text colour at 4.5:1 or more on %s", (background) => {
    text.forEach((name) => expect(contrast(theme[name], theme[background]), name).toBeGreaterThanOrEqual(4.5));
  });

  it("keeps button text, control edges and the focus ring readable", () => {
    expect(contrast(theme["primary-fg"], theme.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.control, theme.card)).toBeGreaterThanOrEqual(3);
    expect(contrast(theme.control, theme.hover)).toBeGreaterThanOrEqual(3);
    expect(contrast(theme.focus, theme.card)).toBeGreaterThanOrEqual(3);
    expect(contrast(theme.focus, theme.hover)).toBeGreaterThanOrEqual(3);
  });
});

describe("themeCss", () => {
  it("defines every token for dark and swaps them in for light mode", () => {
    Object.entries(dark).forEach(([name, value]) => expect(themeCss).toContain(`--${name}: ${value};`));
    const lightBlock = themeCss.slice(themeCss.indexOf("prefers-color-scheme: light"));
    Object.entries(light).forEach(([name, value]) => expect(lightBlock).toContain(`--${name}: ${value};`));
  });
});

describe("adoptStyles", () => {
  it("adopts the theme ahead of the component's own rules", () => {
    const shadow = document.createElement("div").attachShadow({ mode: "open" });
    adoptStyles(shadow, ".x { color: var(--fg); }");
    const css = [...shadow.adoptedStyleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n");
    expect(css.indexOf("--fg")).toBeLessThan(css.indexOf(".x"));
  });

  it("falls back to a style element where constructable sheets are missing", () => {
    const shadow = document.createElement("div").attachShadow({ mode: "open" });
    vi.spyOn(window, "CSSStyleSheet").mockImplementation(() => {
      throw new Error("unsupported");
    });
    adoptStyles(shadow, ".x { color: var(--fg); }");
    expect(shadow.querySelector("style")?.textContent).toBe(themeCss + ".x { color: var(--fg); }");
    vi.restoreAllMocks();
  });
});
