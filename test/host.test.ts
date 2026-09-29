import { frameMayFill, hostMatches, isSecurePage, matchEntries, mayFill, normalizeServer, searchEntries } from "../src/shared/host";
import type { EntrySummary } from "../src/shared/types";

const entry = (id: number, name: string, urlHost: string): EntrySummary => ({
  id,
  name,
  urlHost,
  folderId: null,
  createdAt: "",
  updatedAt: "",
});

describe("hostMatches", () => {
  it.each([
    ["github.com", "github.com", true],
    ["github.com", "www.github.com", true],
    ["www.github.com", "github.com", true],
    ["github.com", "gist.github.com", true],
    ["GitHub.com", "github.com.", true],
    ["gist.github.com", "github.com", false],
    ["github.com", "evilgithub.com", false],
    ["github.com", "github.com.evil.io", false],
    ["", "github.com", false],
    ["github.com", "", false],
  ])("entry %s on page %s → %s", (entryHost, pageHost, expected) => {
    expect(hostMatches(entryHost, pageHost)).toBe(expected);
  });
});

describe("matchEntries", () => {
  it("puts exact host matches first, then sorts by name", () => {
    const entries = [
      entry(1, "Zulu", "github.com"),
      entry(2, "Alpha", "github.com"),
      entry(3, "Gist", "gist.github.com"),
      entry(4, "Other", "gitlab.com"),
    ];
    expect(matchEntries(entries, "gist.github.com").map((e) => e.id)).toEqual([3, 2, 1]);
    expect(matchEntries(entries, "github.com").map((e) => e.id)).toEqual([2, 1]);
  });
});

describe("searchEntries", () => {
  it("matches name or host, case-insensitively", () => {
    const entries = [entry(1, "Bank", "chase.com"), entry(2, "Email", "fastmail.com"), entry(3, "Router", "")];
    expect(searchEntries(entries, "MAIL").map((e) => e.id)).toEqual([2]);
    expect(searchEntries(entries, "chase").map((e) => e.id)).toEqual([1]);
    expect(searchEntries(entries, "  ").map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe("isSecurePage", () => {
  it.each([
    ["https://github.com/login", true],
    ["http://localhost:8080/", true],
    ["http://127.0.0.1/", true],
    ["http://example.com/", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isSecurePage(url)).toBe(expected);
  });
});

describe("mayFill", () => {
  it("fills on an https page for the entry's host", () => {
    expect(mayFill("https://github.com/login", "https://github.com", "github.com")).toBe(true);
  });

  it("refuses another site", () => {
    expect(mayFill("https://evil.io/login", "https://github.com", "github.com")).toBe(false);
  });

  it("refuses plain http unless the entry was saved as http", () => {
    expect(mayFill("http://github.com/login", "https://github.com", "github.com")).toBe(false);
    expect(mayFill("http://192.168.1.1/", "http://192.168.1.1", "192.168.1.1")).toBe(true);
  });
});

describe("normalizeServer", () => {
  it.each([
    ["quark.local", "https://quark.local"],
    ["  https://quark.local:8443/files?x=1 ", "https://quark.local:8443"],
    ["http://192.168.1.20:8080/", "http://192.168.1.20:8080"],
    ["ftp://quark.local", ""],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(normalizeServer(input)).toBe(expected);
  });
});

describe("frameMayFill", () => {
  const entryUrl = "https://example.com";

  it("fills the top frame of the entry's site", () => {
    expect(frameMayFill("https://example.com/login", "https://example.com/login", entryUrl, "example.com")).toBe(true);
  });

  it("fills a same-site frame", () => {
    expect(frameMayFill("https://login.example.com/frame", "https://www.example.com/", entryUrl, "example.com")).toBe(true);
  });

  it("refuses the entry's site framed inside another site", () => {
    expect(frameMayFill("https://login.example.com/frame", "https://evil.io/", entryUrl, "example.com")).toBe(false);
  });

  it("refuses another site framed inside the entry's site", () => {
    expect(frameMayFill("https://ads.other.net/frame", "https://example.com/", entryUrl, "example.com")).toBe(false);
  });

  it("refuses when the top frame is unknown", () => {
    expect(frameMayFill("https://example.com/frame", "", entryUrl, "example.com")).toBe(false);
  });
});
