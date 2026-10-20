import { showWelcome, welcomeSections } from "../src/popup/welcome";
import { defaultSettings, type VaultState } from "../src/shared/types";

describe("showWelcome", () => {
  const disconnected: VaultState = { kind: "disconnected" };

  it("shows once, before the first connect", () => {
    expect(showWelcome(disconnected, defaultSettings)).toBe(true);
    expect(showWelcome(disconnected, { ...defaultSettings, welcomeSeen: true })).toBe(false);
  });

  it("never interrupts someone who has signed in before", () => {
    const states: readonly VaultState[] = [
      { kind: "signedOut", server: "https://quark.local" },
      { kind: "locked", server: "https://quark.local" },
      { kind: "unlocked", server: "https://quark.local", autoLockSeconds: 0 },
      { kind: "unreachable", server: "https://quark.local", message: "" },
    ];
    for (const state of states) {
      expect(showWelcome(state, defaultSettings)).toBe(false);
    }
  });
});

describe("welcomeSections", () => {
  const text = (browser: "chrome" | "firefox"): string =>
    welcomeSections(browser)
      .flatMap((section) => [section.title, ...section.lines])
      .join("\n");

  it("explains the account, its end-to-end encrypted vault and the address format", () => {
    const chrome = text("chrome");
    expect(chrome).toContain("Quark account");
    expect(chrome).toContain("same password unlocks your vault");
    expect(chrome).toContain("end-to-end encrypted");
    expect(chrome).toContain("http://host:port");
    expect(chrome).toContain("unencrypted");
  });

  it("names each browser's own permission prompts", () => {
    expect(text("chrome")).toContain("Read and change all your data on all websites");
    expect(text("chrome")).toContain("Manage your apps, extensions");
    expect(text("firefox")).toContain("Access to your data for all websites");
    expect(text("firefox")).not.toContain("Manage your apps");
  });
});
