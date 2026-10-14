import type { Browser } from "./platform";

export const fillCommand = "fill-login";

const chromeShortcutsPage = "chrome://extensions/shortcuts";

// The manifest only suggests keys: the browser skips them when another extension or the OS already has them,
// so the real binding has to be read back from commands.getAll().
export const fillShortcut = (commands: readonly Readonly<{ name?: string; shortcut?: string }>[]): string =>
  commands.find((command) => command.name === fillCommand)?.shortcut ?? "";

export type ShortcutHelp = Readonly<{
  bound: boolean;
  label: string;
  steps: string;
  // A page an extension may open with tabs.create; null where it can't (Firefox's about:addons).
  url: string | null;
}>;

export const shortcutHelp = (browser: Browser, shortcut: string): ShortcutHelp => {
  const bound = shortcut !== "";
  const label = bound ? shortcut : "Not set";
  if (browser === "firefox") {
    const where = "open about:addons, click the gear button, then Manage Extension Shortcuts.";
    return { bound, label, url: null, steps: bound ? `To change it, ${where}` : `Firefox didn't bind it. To set one, ${where}` };
  }
  return {
    bound,
    label,
    url: chromeShortcutsPage,
    steps: bound
      ? `Change it at ${chromeShortcutsPage}.`
      : `Chrome didn't bind it, often because another extension has the same keys. Set one at ${chromeShortcutsPage}.`,
  };
};
