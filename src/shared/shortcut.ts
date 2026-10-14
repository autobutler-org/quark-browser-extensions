import { t } from "./i18n";
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
  const label = bound ? shortcut : t("shortcutNotSet");
  if (browser === "firefox") {
    return { bound, label, url: null, steps: bound ? t("shortcutFirefoxChange") : t("shortcutFirefoxUnbound") };
  }
  return {
    bound,
    label,
    url: chromeShortcutsPage,
    steps: bound ? t("shortcutChange", chromeShortcutsPage) : t("shortcutUnbound", chromeShortcutsPage),
  };
};
