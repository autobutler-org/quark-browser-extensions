// Colour tokens for the in-page UI, named like static/theme.css so the picker and save bar follow
// the same palette as the popup. Every text pair is at least 4.5:1 and every control edge or focus
// ring at least 3:1 (WCAG 1.4.3 / 1.4.11); test/styles.test.ts checks the ratios.
export type Theme = Readonly<{
  card: string;
  hover: string;
  border: string;
  control: string;
  fg: string;
  muted: string;
  accent: string;
  primary: string;
  "primary-fg": string;
  focus: string;
  warn: string;
  "error-fg": string;
}>;

export const dark: Theme = {
  card: "#0f172a",
  hover: "#1e293b",
  border: "#1e293b",
  control: "#64748b",
  fg: "#e2e8f0",
  muted: "#94a3b8",
  accent: "#38bdf8",
  primary: "#0369a1",
  "primary-fg": "#ffffff",
  focus: "#7dd3fc",
  warn: "#fbbf24",
  "error-fg": "#fca5a5",
};

export const light: Theme = {
  card: "#ffffff",
  hover: "#e2e8f0",
  border: "#cbd5e1",
  control: "#64748b",
  fg: "#0f172a",
  muted: "#475569",
  accent: "#0369a1",
  primary: "#0369a1",
  "primary-fg": "#ffffff",
  focus: "#0369a1",
  warn: "#92400e",
  "error-fg": "#b91c1c",
};

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};

export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const vars = (theme: Theme): string =>
  Object.entries(theme)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(" ");

export const themeCss = `
:host { ${vars(dark)} color-scheme: dark; }
@media (prefers-color-scheme: light) {
  :host { ${vars(light)} color-scheme: light; }
}
`;

export const adoptStyles = (shadow: ShadowRoot, css: string): void => {
  const text = themeCss + css;
  const view = shadow.ownerDocument.defaultView;
  try {
    if (view === null) {
      throw new Error("no window");
    }
    const sheet = new view.CSSStyleSheet();
    sheet.replaceSync(text);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = shadow.ownerDocument.createElement("style");
    style.textContent = text;
    shadow.append(style);
  }
};
