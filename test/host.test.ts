import {
  frameMayFill,
  hostMatches,
  hostOf,
  isFallback,
  isSecurePage,
  matchEntries,
  mayFill,
  normalizeServer,
  primaryMatches,
  searchEntries,
} from "../src/shared/host";
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
    expect(matchEntries(entries, "https://gist.github.com/").map((e) => e.id)).toEqual([3, 2, 1]);
    expect(matchEntries(entries, "https://github.com/login").map((e) => e.id)).toEqual([2, 1]);
  });

  it("matches nothing on a page that isn't a URL", () => {
    expect(matchEntries([entry(1, "A", "github.com")], "github.com")).toEqual([]);
  });

  describe("by origin", () => {
    // Self-hosters run many services on one box; each port is its own site.
    const local = [
      entry(1, "Router", "localhost"),
      entry(2, "NAS", "localhost"),
      entry(3, "Quark", "localhost"),
      entry(4, "Old NAS", "localhost"),
      entry(5, "Docs", "localhost"),
    ];
    const urls: Record<number, string> = {
      1: "http://localhost:8099/basic.html",
      2: "http://localhost:8087/login",
      3: "https://localhost:8087",
      4: "http://localhost:8087/",
      5: "localhost",
    };
    const urlOf = (e: { id: number }) => urls[e.id];
    const view = (pageUrl: string) =>
      matchEntries(local, pageUrl, urlOf).map(({ id, kind, where, note }) => ({ id, kind, where, note }));

    it("ranks exact-origin matches first and labels other ports and schemes as fallbacks", () => {
      expect(view("http://localhost:8087/login")).toEqual([
        { id: 2, kind: "exact", where: "localhost:8087/login", note: "" },
        { id: 4, kind: "exact", where: "localhost:8087", note: "" },
        { id: 1, kind: "otherPort", where: "localhost:8099/basic.html", note: "Different port" },
        { id: 5, kind: "otherScheme", where: "https://localhost", note: "Saved for https" },
        { id: 3, kind: "otherScheme", where: "https://localhost:8087", note: "Saved for https" },
      ]);
    });

    it("counts only exact and same-site matches as primary", () => {
      expect(primaryMatches(matchEntries(local, "http://localhost:8099/", urlOf)).map((e) => e.id)).toEqual([1]);
      expect(primaryMatches(matchEntries(local, "http://localhost:9000/", urlOf))).toEqual([]);
      expect(matchEntries(local, "http://localhost:9000/", urlOf).every(isFallback)).toBe(true);
    });

    it("never offers an http entry on an https page without saying so", () => {
      const [match] = matchEntries([entry(1, "Shop", "shop.example")], "https://shop.example/", () => "http://shop.example/");
      expect(match).toMatchObject({ kind: "otherScheme", where: "http://shop.example", note: "Saved for http" });
    });

    it("never offers an https entry on an http page without saying so", () => {
      const [match] = matchEntries([entry(1, "Shop", "shop.example")], "http://shop.example/", () => "https://shop.example/");
      expect(match).toMatchObject({ kind: "otherScheme", note: "Saved for https" });
    });

    it("treats default ports as the same origin", () => {
      expect(matchEntries([entry(1, "A", "example.com")], "https://example.com:443/", () => "https://example.com")[0]?.kind).toBe("exact");
      expect(matchEntries([entry(1, "A", "example.com")], "http://example.com/", () => "http://example.com:80/")[0]?.kind).toBe("exact");
    });

    it("keeps subdomain matches on the same scheme and port as primary", () => {
      expect(matchEntries([entry(1, "A", "github.com")], "https://gist.github.com/", () => "https://github.com/login")[0]).toMatchObject({
        kind: "site",
        where: "github.com/login",
      });
    });

    it("reads an entry URL without a scheme, or an unknown URL, as https on the default port", () => {
      expect(matchEntries([entry(1, "A", "github.com")], "https://github.com/", () => "github.com/login")[0]?.kind).toBe("exact");
      expect(matchEntries([entry(1, "A", "github.com")], "https://github.com/")[0]).toMatchObject({ kind: "exact", where: "github.com" });
      expect(matchEntries([entry(1, "A", "github.com")], "https://github.com/", () => "ftp://github.com")[0]?.kind).toBe("exact");
      expect(matchEntries([entry(1, "A", "github.com")], "https://github.com/", () => "http://[github.com")[0]?.kind).toBe("exact");
    });

    it("still filters by host, whatever the entry's URL claims", () => {
      expect(matchEntries([entry(1, "A", "github.com")], "https://evil.io/", () => "https://evil.io/")).toEqual([]);
    });
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

    it("doesn't treat the tail of an IPv4 address as a parent domain", () => {
      expect(hostMatches("168.1.1", "192.168.1.1")).toBe(false);
    });

    // Quark stores a bare IPv6 host, as Go's URL.Hostname() returns it.
    it("matches a bare IPv6 entry host on the bracketed page host", () => {
      expect(hostMatches("::1", hostOf("http://[::1]/"))).toBe(true);
    });

    it("doesn't treat IPv6 addresses as parent domains", () => {
      expect(hostMatches("::1", hostOf("http://[2001:db8::1]/"))).toBe(false);
      expect(hostMatches("[::1]", "[::1].example")).toBe(false);
    });

    it("treats IPv4 and IPv6 loopback over http as secure", () => {
      expect(isSecurePage("http://127.0.0.1:8080/")).toBe(true);
      expect(isSecurePage("http://127.0.0.2/")).toBe(false);
      expect(isSecurePage("http://[::1]/")).toBe(true);
      expect(isSecurePage("http://[::2]/")).toBe(false);
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

    // Quark stores the host as typed, so an IDN host can arrive in Unicode.
    it("matches a Unicode entry host on its punycode page", () => {
      expect(hostMatches("bücher.de", hostOf("https://bücher.de/"))).toBe(true);
      expect(hostMatches("BÜCHER.de", hostOf("https://shop.bücher.de/"))).toBe(true);
      expect(hostMatches("аpple.com", hostOf("https://apple.com/"))).toBe(false);
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

    it("matches an entry host that carries a port on its host", () => {
      expect(hostMatches("quark.local:8443", hostOf("https://quark.local:8443/"))).toBe(true);
      expect(hostMatches("[::1]:8080", hostOf("http://[::1]:8080/"))).toBe(true);
      expect(hostMatches("quark.local:8443", hostOf("https://evil.local:8443/"))).toBe(false);
    });

    it.each(["evil.io/github.com", "github.com@evil.io", "evil.io#github.com", "evil.io\\github.com", "git hub.com", "quark.local:99999"])(
      "never matches the malformed entry host %s",
      (entryHost) => {
        expect(hostMatches(entryHost, "github.com")).toBe(false);
        expect(hostMatches(entryHost, "evil.io")).toBe(false);
      },
    );

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
