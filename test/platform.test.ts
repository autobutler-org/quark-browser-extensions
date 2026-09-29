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
});
