import { t } from "../shared/i18n";
import type { Browser } from "../shared/platform";
import type { Settings, VaultState } from "../shared/types";

export type WelcomeSection = Readonly<{ title: string; lines: readonly string[] }>;

// Shown once, before the first connect form. Someone already signed in never sees it.
export const showWelcome = (state: VaultState, settings: Settings): boolean =>
  state.kind === "disconnected" && !settings.welcomeSeen;

export const welcomeSections = (browser: Browser): readonly WelcomeSection[] => [
  {
    title: t("welcomeNeedTitle"),
    lines: [t("welcomeNeedQuark"), t("welcomeNeedAdmin"), t("welcomeNeedSessions")],
  },
  {
    title: t("welcomeAddressTitle"),
    lines: [t("welcomeAddressFormat"), t("welcomeAddressInsecure")],
  },
  {
    title: t("welcomePermissionsTitle"),
    // Each browser's own wording for the permission prompts it shows.
    lines: [
      browser === "firefox" ? t("welcomeSitesFirefox") : t("welcomeSitesChrome"),
      t("welcomePageSafety"),
      t("welcomeOtherPermissions"),
      browser === "firefox" ? t("welcomeOptionalFirefox") : t("welcomeOptionalChrome"),
    ],
  },
];
