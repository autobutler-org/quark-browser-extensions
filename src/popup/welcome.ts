import type { Browser } from "../shared/platform";
import type { Settings, VaultState } from "../shared/types";

export type WelcomeSection = Readonly<{ title: string; lines: readonly string[] }>;

// Shown once, before the first connect form. Someone already signed in never sees it.
export const showWelcome = (state: VaultState, settings: Settings): boolean =>
  state.kind === "disconnected" && !settings.welcomeSeen;

export const welcomeSections = (browser: Browser): readonly WelcomeSection[] => [
  {
    title: "What you need",
    lines: [
      "A Quark with the password vault set up, an admin account on it, and the vault password.",
      "You sign in with the admin account first, then unlock with the vault password. Only admins can open the vault; if you aren't one, ask whoever runs your Quark.",
      "This browser shows up in your Quark's Settings › Sessions, where you can revoke it any time.",
    ],
  },
  {
    title: "Your Quark's address",
    lines: [
      "Use https://your-quark when it has https, or http://host:port for a Quark on your own network, such as http://192.168.1.20:8080.",
      "Plain http to another machine asks you to confirm first, because passwords would cross the network unencrypted.",
    ],
  },
  {
    title: "Why it asks for these permissions",
    lines: [
      browser === "firefox"
        ? "Access to your data for all websites: to find login forms on the pages you visit and fill them. Firefox asks for it separately; the popup shows Allow until you grant it."
        : "Read and change all your data on all websites: to find login forms on the pages you visit and fill them.",
      "A page never gets a password until you pick a login saved for that site, and your Quark session stays out of pages' reach.",
      "Storage keeps your settings and sign-in, idle locks the vault when this computer locks, and the right-click menu offers Fill.",
      browser === "firefox"
        ? "Privacy and management, asked only if you choose to check for other password managers in the options."
        : "Privacy and management (Manage your apps, extensions…), asked only if you choose to check for other password managers in the options.",
    ],
  },
];
