import { browserCopy, browserFromUrl } from "../src/shared/platform";

describe("platform", () => {
  it("tells browsers apart by extension URL scheme", () => {
    expect(browserFromUrl("moz-extension://1234/")).toBe("firefox");
    expect(browserFromUrl("chrome-extension://abcd/")).toBe("chrome");
  });

  it("only offers to turn other add-ons off in Chrome", () => {
    expect(browserCopy("chrome").canDisableOthers).toBe(true);
    expect(browserCopy("firefox").canDisableOthers).toBe(false);
    expect(browserCopy("firefox").builtInManager).toBe("Firefox Password Manager");
  });

  it("names neither browser outside the built-in manager's name and the browser's own pages", () => {
    const chrome = browserCopy("chrome");
    const firefox = browserCopy("firefox");
    expect(chrome.builtInManager).toBe("Google Password Manager");
    expect(firefox.settingsPage).toBe("about:preferences#privacy");
    expect(chrome.settingsPage).toBe("chrome://settings");
    for (const copy of [chrome, firefox]) {
      expect([copy.builtInOn, copy.builtInManaged, copy.builtInOff].join(" ")).not.toMatch(/Chrome|Firefox|Google/);
    }
    expect(firefox.builtInOn).toBe(chrome.builtInOn);
  });
});

