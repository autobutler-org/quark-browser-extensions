import { fillCommand, fillShortcut, shortcutHelp } from "../src/shared/shortcut";

describe("fillShortcut", () => {
  it("reads the binding the browser actually made", () => {
    expect(fillShortcut([{ name: "_execute_action", shortcut: "" }, { name: fillCommand, shortcut: "Ctrl+Shift+L" }])).toBe("Ctrl+Shift+L");
  });

  it("is empty when the browser left the command unbound or it's missing", () => {
    expect(fillShortcut([{ name: fillCommand, shortcut: "" }])).toBe("");
    expect(fillShortcut([{ name: fillCommand }])).toBe("");
    expect(fillShortcut([])).toBe("");
  });
});

describe("shortcutHelp", () => {
  it("shows a bound shortcut and where to change it", () => {
    expect(shortcutHelp("chrome", "Ctrl+Shift+L")).toEqual({
      bound: true,
      label: "Ctrl+Shift+L",
      steps: "Change it at chrome://extensions/shortcuts.",
      url: "chrome://extensions/shortcuts",
    });
  });

  it("says Not set and links Chrome users to the shortcuts page", () => {
    expect(shortcutHelp("chrome", "")).toEqual({
      bound: false,
      label: "Not set",
      steps: "Chrome didn't bind it, often because another extension has the same keys. Set one at chrome://extensions/shortcuts.",
      url: "chrome://extensions/shortcuts",
    });
  });

  it("gives Firefox users steps, since an extension can't open about:addons", () => {
    const help = shortcutHelp("firefox", "");
    expect(help.bound).toBe(false);
    expect(help.label).toBe("Not set");
    expect(help.url).toBeNull();
    expect(help.steps).toContain("about:addons");
    expect(help.steps).toContain("Manage Extension Shortcuts");
  });
});
