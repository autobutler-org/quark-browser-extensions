import { frameMayFill, hostMatches, hostOf, isSecurePage, matchEntries, mayFill, normalizeServer, searchEntries } from "../src/shared/host";
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

describe("host matching edge cases", () => {
  describe("IP literals", () => {
    it.each([
      ["192.168.1.1", "http://192.168.1.1/", true],
      ["192.168.1.1", "http://192.168.1.1:8080/admin", true],
      ["192.168.1.1", "http://192.168.1.10/", false],
      ["192.168.1.1", "http://10.192.168.1.1.nip.io/", false],
      ["10.0.0.1", "http://110.0.0.1/", false],
      // The URL parser rewrites other IPv4 spellings to dotted quads before matching.
      ["127.0.0.1", "http://2130706433/", true],
      ["127.0.0.1", "http://0x7f.1/", true],
      ["[::1]", "http://[::1]:8080/", true],
      ["[2001:db8::1]", "https://[2001:db8::1]/", true],
      ["[2001:db8::1]", "https://[2001:db8::2]/", false],
    ])("entry %s on %s → %s", (entryHost, pageUrl, expected) => {
      expect(hostMatches(entryHost, hostOf(pageUrl))).toBe(expected);
    });

    // Known gap: IP hosts go through the same suffix rule as domain names, so a partial address
    // matches a full one. Quark's own URL parsing keeps such hosts as written.
    it.fails("doesn't treat the tail of an IPv4 address as a parent domain", () => {
      expect(hostMatches("168.1.1", "192.168.1.1")).toBe(false);
    });

    // Known gap: a bare IPv6 host (as Go's URL.Hostname() returns it) never matches the bracketed
    // form the browser reports.
    it.fails("matches a bare IPv6 entry host on the bracketed page host", () => {
      expect(hostMatches("::1", hostOf("http://[::1]/"))).toBe(true);
    });

    it("treats only IPv4 loopback over http as secure", () => {
      expect(isSecurePage("http://127.0.0.1:8080/")).toBe(true);
      expect(isSecurePage("http://127.0.0.2/")).toBe(false);
      expect(isSecurePage("http://[::1]/")).toBe(false);
    });
  });

  describe("trailing dots", () => {
    it.each([
      ["github.com", "https://github.com./login", true],
      ["github.com.", "https://github.com/login", true],
      ["github.com.", "https://gist.github.com./", true],
      ["github.com", "https://github.com../", false],
      ["github.com", "https://evilgithub.com./", false],
    ])("entry %s on %s → %s", (entryHost, pageUrl, expected) => {
      expect(hostMatches(entryHost, hostOf(pageUrl))).toBe(expected);
    });

    it("fills a fully qualified page for the entry's site", () => {
      expect(mayFill("https://github.com./login", "https://github.com", "github.com")).toBe(true);
    });
  });

  describe("punycode and IDN hosts", () => {
    it("reports page hosts in punycode", () => {
      expect(hostOf("https://bücher.de/")).toBe("xn--bcher-kva.de");
      expect(hostOf("https://BÜCHER.de/")).toBe("xn--bcher-kva.de");
    });

    it.each([
      ["xn--bcher-kva.de", "https://bücher.de/", true],
      ["xn--bcher-kva.de", "https://shop.bücher.de/", true],
      ["xn--bcher-kva.de", "https://xn--bcher-kva.de/", true],
      // Look-alikes: Cyrillic "а" in place of Latin "a".
      ["apple.com", "https://аpple.com/", false],
      ["xn--pple-43d.com", "https://apple.com/", false],
      ["bucher.de", "https://bücher.de/", false],
    ])("entry %s on %s → %s", (entryHost, pageUrl, expected) => {
      expect(hostMatches(entryHost, hostOf(pageUrl))).toBe(expected);
    });

    // Known gap: entry hosts are compared as stored. If Quark stores an IDN host in Unicode, it
    // never matches the punycode host the browser reports.
    it.fails("matches a Unicode entry host on its punycode page", () => {
      expect(hostMatches("bücher.de", hostOf("https://bücher.de/"))).toBe(true);
    });

    it("normalizes an IDN server address to punycode", () => {
      expect(normalizeServer("bücher.de:8443")).toBe("https://xn--bcher-kva.de:8443");
    });
  });

  describe("ports", () => {
    it.each([
      ["github.com", "https://github.com:8443/", true],
      ["github.com", "https://GITHUB.com:443/", true],
      ["github.com", "https://github.com.evil.io:443/", false],
    ])("entry %s on %s → %s", (entryHost, pageUrl, expected) => {
      expect(hostMatches(entryHost, hostOf(pageUrl))).toBe(expected);
    });

    it("ignores the port when filling", () => {
      expect(mayFill("https://github.com:8443/login", "https://github.com", "github.com")).toBe(true);
      expect(mayFill("http://192.168.1.1:8080/", "http://192.168.1.1:8080", "192.168.1.1")).toBe(true);
    });

    it("never matches an entry host that carries a port", () => {
      expect(hostMatches("quark.local:8443", hostOf("https://quark.local:8443/"))).toBe(false);
    });

    it.each([
      ["[::1]:8080", "https://[::1]:8080"],
      ["quark.local:443", "https://quark.local"],
      ["http://quark.local:80/", "http://quark.local"],
      ["quark.local:99999", ""],
    ])("normalizeServer %s → %s", (input, expected) => {
      expect(normalizeServer(input)).toBe(expected);
    });
  });
});
