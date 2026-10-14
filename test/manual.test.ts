import type { Sender } from "../src/background/gate";
import { grantAllows, grantFor, manualFillCommand, manualFillRefusal, manualGrantMs, pageHostOf, type ManualGrant } from "../src/background/manual";
import { fillDecision } from "../src/content/frame";

const tab = (id?: number): chrome.tabs.Tab => ({ id }) as chrome.tabs.Tab;
const now = 1_000_000;
const pageUrl = "https://forum.example/login?next=/";
const grant: ManualGrant = { tabId: 7, entryId: 3, origin: "https://forum.example", expires: now + manualGrantMs };
const top: Sender = { id: "quark", url: "https://forum.example/login", tab: tab(7), frameId: 0 };
const without = (key: "tab" | "frameId" | "url"): Sender => {
  const { [key]: _, ...rest } = top;
  return rest;
};

describe("pageHostOf", () => {
  it.each([
    ["https://forum.example/login", "forum.example"],
    ["http://intranet:8080/", "intranet:8080"],
    ["chrome://settings", ""],
    ["file:///etc/passwd", ""],
    ["not a url", ""],
  ])("%s → %s", (url, host) => {
    expect(pageHostOf(url)).toBe(host);
  });
});

describe("manualFillRefusal", () => {
  it("allows the host the user confirmed", () => {
    expect(manualFillRefusal(pageUrl, "forum.example")).toBeNull();
  });

  it("refuses when the tab moved to another host since the confirm", () => {
    expect(manualFillRefusal("https://evil.example/", "forum.example")).toBe(
      "This tab is now on evil.example, not forum.example. Open the popup again to fill it.",
    );
  });

  it("tells ports apart", () => {
    expect(manualFillRefusal("https://forum.example:8443/", "forum.example")).not.toBeNull();
  });

  it.each(["", "chrome://extensions", "about:blank", "file:///home/"])("refuses a page that isn't on the web: %j", (url) => {
    expect(manualFillRefusal(url, pageHostOf(url))).toBe("This page can't be filled.");
  });
});

describe("grantFor", () => {
  it("binds the tab, the entry and the page's origin, for a short while", () => {
    expect(grantFor(7, 3, pageUrl, now)).toEqual(grant);
  });

  it("gives none for a page that isn't on the web", () => {
    expect(grantFor(7, 3, "chrome://settings", now)).toBeNull();
  });
});

describe("grantAllows", () => {
  it("lets the confirmed tab's top frame collect the confirmed entry", () => {
    expect(grantAllows(grant, top, 3, now)).toBe(true);
    expect(grantAllows(grant, { ...top, url: "https://forum.example/other" }, 3, now)).toBe(true);
  });

  it.each<[string, ManualGrant | undefined, Sender, number, number]>([
    ["no grant", undefined, top, 3, now],
    ["another entry", grant, top, 4, now],
    ["another tab", grant, { ...top, tab: tab(8) }, 3, now],
    ["a tab with no id", grant, { ...top, tab: tab() }, 3, now],
    ["no tab", grant, without("tab"), 3, now],
    ["a sub frame", grant, { ...top, frameId: 2 }, 3, now],
    ["no frame id", grant, without("frameId"), 3, now],
    ["another origin", grant, { ...top, url: "https://evil.example/login" }, 3, now],
    ["another port", grant, { ...top, url: "https://forum.example:444/login" }, 3, now],
    ["another scheme", grant, { ...top, url: "http://forum.example/login" }, 3, now],
    ["a subdomain", grant, { ...top, url: "https://a.forum.example/login" }, 3, now],
    ["no url", grant, without("url"), 3, now],
    ["an expired grant", grant, top, 3, now + manualGrantMs],
  ])("refuses %s", (_, given, sender, entryId, at) => {
    expect(grantAllows(given, sender, entryId, at)).toBe(false);
  });
});

describe("manualFillCommand", () => {
  it("carries no secret and names the page as the target", () => {
    expect(manualFillCommand(3, pageUrl)).toEqual({
      type: "fill",
      entryId: 3,
      entryUrl: pageUrl,
      entryHost: "forum.example",
      topUrl: pageUrl,
    });
  });

  it("makes the top frame ask the worker, and a frame from another site stay quiet", () => {
    const command = manualFillCommand(3, pageUrl);
    expect(fillDecision(true, true, "https://forum.example/login", pageUrl, command.entryUrl, command.entryHost)).toEqual({ kind: "ask" });
    expect(fillDecision(false, true, "https://ads.example/frame", pageUrl, command.entryUrl, command.entryHost)).toEqual({ kind: "silent" });
  });

  it("still lets a plain http page ask, since the user confirmed it", () => {
    const command = manualFillCommand(3, "http://intranet/login");
    expect(fillDecision(true, true, "http://intranet/login", "http://intranet/login", command.entryUrl, command.entryHost)).toEqual({ kind: "ask" });
  });
});
