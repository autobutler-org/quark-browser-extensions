import type { EntrySummary } from "./types";

export const normalizeHost = (host: string): string =>
  host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

// The host as the browser would see it: punycode, IPv4 in dotted-quad form, IPv6 in brackets, no port.
// Anything that isn't a bare host (a path, credentials, a backslash) comes back empty so it never matches.
const canonicalHost = (host: string): string => {
  const trimmed = host.trim();
  if (trimmed === "" || /[/?#@\\\s]/.test(trimmed)) {
    return "";
  }
  const bareIpv6 = !trimmed.startsWith("[") && trimmed.split(":").length > 2;
  try {
    return new URL(`http://${bareIpv6 ? `[${trimmed}]` : trimmed}`).hostname;
  } catch {
    return "";
  }
};

const isIpHost = (host: string): boolean => host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

const siteHost = (host: string): string => normalizeHost(canonicalHost(host));

// Host-level match, which the worker's fill checks rely on: the same host, or a subdomain of a named
// host. An IP address only ever matches itself.
export const hostMatches = (entryHost: string, pageHost: string): boolean => {
  const entry = siteHost(entryHost);
  const page = siteHost(pageHost);
  if (entry === "" || page === "") {
    return false;
  }
  return page === entry || (!isIpHost(entry) && !isIpHost(page) && page.endsWith(`.${entry}`));
};

const byName = (a: EntrySummary, b: EntrySummary): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

// exact: same scheme, host and port. site: same scheme and port on a subdomain of the entry's host.
// otherPort and otherScheme are fallbacks: offered, but labelled and never filled without a pick.
export type MatchKind = "exact" | "site" | "otherPort" | "otherScheme";

export type SiteMatch = EntrySummary &
  Readonly<{
    kind: MatchKind;
    // Where the entry was saved, with the port and path when they tell it apart from others on the host.
    where: string;
    // Why a fallback is only a fallback; empty for exact and site matches.
    note: string;
    // Whether the entry has a one-time code; missing when the worker couldn't look the entry up.
    hasTotp?: boolean;
  }>;

// Offer "Copy one-time code" unless the entry is known to have none.
export const mayHaveOtp = (match: SiteMatch): boolean => match.hasTotp !== false;

export const isFallback = (match: SiteMatch): boolean => match.kind === "otherPort" || match.kind === "otherScheme";

const rankOf: Readonly<Record<MatchKind, number>> = { exact: 0, site: 1, otherPort: 2, otherScheme: 3 };

const defaultPort = (protocol: string): string => (protocol === "https:" ? "443" : protocol === "http:" ? "80" : "");

type Origin = Readonly<{ protocol: string; host: string; port: string; display: string; path: string }>;

const originOf = (url: URL): Origin => ({
  protocol: url.protocol,
  host: siteHost(url.hostname),
  port: url.port === "" ? defaultPort(url.protocol) : url.port,
  display: url.host,
  path: url.pathname === "/" ? "" : url.pathname,
});

// Quark reads a URL typed without a scheme as https, so this does too.
const entryOrigin = (entryUrl: string): Origin | null => {
  const trimmed = entryUrl.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === "https:" || url.protocol === "http:" ? originOf(url) : null;
  } catch {
    return null;
  }
};

const pageOrigin = (pageUrl: string): Origin | null => {
  try {
    return originOf(new URL(pageUrl));
  } catch {
    return null;
  }
};

const kindOf = (page: Origin, entry: Origin): MatchKind => {
  if (entry.protocol !== page.protocol) {
    return "otherScheme";
  }
  if (entry.port !== page.port) {
    return "otherPort";
  }
  return entry.host === page.host ? "exact" : "site";
};

const noteFor = (kind: MatchKind, entry: Origin): string => {
  switch (kind) {
    case "otherScheme":
      return `Saved for ${entry.protocol.replace(":", "")}`;
    case "otherPort":
      return "Different port";
    default:
      return "";
  }
};

// The list from Quark only carries each entry's host, so `urlOf` supplies the full URL where it's known.
// An entry whose URL isn't known is taken as https on the default port, which is how Quark reads a bare host.
export const matchEntries = (
  entries: readonly EntrySummary[],
  pageUrl: string,
  urlOf: (entry: EntrySummary) => string | undefined = () => undefined,
): readonly SiteMatch[] => {
  const page = pageOrigin(pageUrl);
  if (page === null) {
    return [];
  }
  return entries
    .filter((entry) => hostMatches(entry.urlHost, page.host))
    .map((entry): SiteMatch => {
      const known = entryOrigin(urlOf(entry) ?? "");
      const origin = known ?? { protocol: "https:", host: siteHost(entry.urlHost), port: "443", display: entry.urlHost, path: "" };
      const kind = kindOf(page, origin);
      const scheme = kind === "otherScheme" ? `${origin.protocol}//` : "";
      return { ...entry, kind, where: `${scheme}${origin.display}${origin.path}`, note: noteFor(kind, origin) };
    })
    .toSorted((a, b) => rankOf[a.kind] - rankOf[b.kind] || byName(a, b));
};

// Matches that may be filled or counted without the user choosing among fallbacks.
export const primaryMatches = (matches: readonly SiteMatch[]): readonly SiteMatch[] =>
  matches.filter((match) => !isFallback(match));

export const searchEntries = (
  entries: readonly EntrySummary[],
  query: string,
): readonly EntrySummary[] => {
  const needle = query.trim().toLowerCase();
  const matches = (entry: EntrySummary): boolean =>
    needle === "" ||
    entry.name.toLowerCase().includes(needle) ||
    entry.urlHost.toLowerCase().includes(needle);
  return entries.filter(matches).toSorted(byName);
};

export const isSecurePage = (pageUrl: string): boolean => {
  try {
    const { protocol, hostname } = new URL(pageUrl);
    return protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
};

export const mayFill = (pageUrl: string, entryUrl: string, entryHost: string): boolean => {
  const insecureAllowed = entryUrl.trim().toLowerCase().startsWith("http://");
  return hostMatches(entryHost, hostOf(pageUrl)) && (isSecurePage(pageUrl) || insecureAllowed);
};

export const frameMayFill = (frameUrl: string, topUrl: string, entryUrl: string, entryHost: string): boolean =>
  mayFill(frameUrl, entryUrl, entryHost) && hostMatches(entryHost, hostOf(topUrl));

export const normalizeServer = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed === "") {
    return "";
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
};

// Loopback never leaves the machine, so plain http there is as private as https.
export const isLoopbackHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
};

// "insecure" means the sign-in, the master password, the token and every decrypted entry cross the network in
// cleartext, so the extension only connects there after an explicit confirmation.
export type ServerTransport = "https" | "loopback" | "insecure";

export const serverTransport = (server: string): ServerTransport => {
  try {
    const url = new URL(server);
    if (url.protocol === "https:") {
      return "https";
    }
    return isLoopbackHost(url.hostname) ? "loopback" : "insecure";
  } catch {
    return "insecure";
  }
};

export const insecureServerRefusal =
  "This Quark address uses plain http, so your passwords would cross the network unencrypted. Use an https address, or confirm that you understand the risk.";

// Whether what's typed in the connect form's address box needs the "unencrypted" confirmation.
export const needsInsecureConfirmation = (input: string): boolean => {
  const server = normalizeServer(input);
  return server !== "" && serverTransport(server) === "insecure";
};

export const insecureServerWarning =
  "Connected over plain http. Your passwords cross the network unencrypted. Switch to an https address.";
