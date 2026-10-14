import { parse } from "tldts/dist/index.esm.min.js";
import { byName, type MatchKind, type SiteMatch } from "./host";
import { t } from "./i18n";
import type { EntrySummary } from "./types";

// Matching that needs the public suffix list. It lives apart from host.ts so the popup and the options page, which
// only use host.ts's helpers, don't load the list.

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

// Where the host sits in the public suffix list, private suffixes such as github.io included.
// `domain` is the registrable domain (eTLD+1), null when the host is itself a suffix.
type Registration = Readonly<{ domain: string | null; listedSuffix: boolean }>;

const registrationOf = (host: string): Registration => {
  const { domain, isIcann, isPrivate } = parse(host, { allowPrivateDomains: true, extractHostname: false });
  return { domain, listedSuffix: domain === null && (isIcann === true || isPrivate === true) };
};

// A leading "www." only goes when what's left is still a site: www.github.io is somebody's site, not github.io.
const siteHost = (host: string): string => {
  const named = canonicalHost(host).replace(/\.$/, "");
  const stripped = named.replace(/^www\./, "");
  return stripped !== named && registrationOf(stripped).listedSuffix ? named : stripped;
};

// Whether a page on `page` may use an entry saved for `entry`, a strict parent of it.
// A suffix on the public suffix list (co.uk, github.io, netlify.app) is shared by unrelated owners, so it is
// never a parent, and a parent must sit inside the page's registrable domain. A single-label host that isn't
// on the list (localhost, an intranet name) has no registrable domain, so it stays a parent of its subdomains.
const isParentSite = (entry: string, page: string): boolean => {
  if (isIpHost(entry) || isIpHost(page) || !page.endsWith(`.${entry}`)) {
    return false;
  }
  const { domain, listedSuffix } = registrationOf(entry);
  if (listedSuffix) {
    return false;
  }
  return domain === null || registrationOf(page).domain === domain;
};

// Host-level match, which the worker's and the page's fill checks both rely on: the same host, or a
// subdomain of it within the same registrable domain. An IP address only ever matches itself.
export const hostMatches = (entryHost: string, pageHost: string): boolean => {
  const entry = siteHost(entryHost);
  const page = siteHost(pageHost);
  if (entry === "" || page === "") {
    return false;
  }
  return page === entry || isParentSite(entry, page);
};

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

const savedOrigin = (entryUrl: string, entryHost: string): Origin =>
  entryOrigin(entryUrl) ?? { protocol: "https:", host: siteHost(entryHost), port: "443", display: entryHost, path: "" };

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
      return t("matchSavedForScheme", entry.protocol.replace(":", ""));
    case "otherPort":
      return t("matchDifferentPort");
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
      const origin = savedOrigin(urlOf(entry) ?? "", entry.urlHost);
      const kind = kindOf(page, origin);
      const scheme = kind === "otherScheme" ? `${origin.protocol}//` : "";
      return { ...entry, kind, where: `${scheme}${origin.display}${origin.path}`, note: noteFor(kind, origin) };
    })
    .toSorted((a, b) => rankOf[a.kind] - rankOf[b.kind] || byName(a, b));
};

export const mayFill = (pageUrl: string, entryUrl: string, entryHost: string): boolean => {
  const page = pageOrigin(pageUrl);
  if (page === null || !hostMatches(entryHost, page.host)) {
    return false;
  }
  const kind = kindOf(page, savedOrigin(entryUrl, entryHost));
  return kind === "exact" || kind === "site";
};

export const frameMayFill = (frameUrl: string, topUrl: string, entryUrl: string, entryHost: string): boolean =>
  mayFill(frameUrl, entryUrl, entryHost) && mayFill(topUrl, entryUrl, entryHost);

// The site a host belongs to: its registrable domain, or the host itself when it has none (an IP address, a
// suffix on the list, a single-label name).
const siteOf = (hostname: string): string => {
  const host = canonicalHost(hostname).replace(/\.$/, "");
  return host === "" || isIpHost(host) ? host : (registrationOf(host).domain ?? host);
};

// Whether a form on `pageUrl` may be submitted to `actionUrl` without the user pressing the button: http or https
// on the page's own site, and never from https down to http. Another site, or a downgrade, gets the login only
// when the user sends it.
export const sameSiteAction = (actionUrl: string, pageUrl: string): boolean => {
  try {
    const action = new URL(actionUrl);
    const page = new URL(pageUrl);
    const site = siteOf(page.hostname);
    return (
      (action.protocol === "https:" || action.protocol === page.protocol) &&
      (action.protocol === "https:" || action.protocol === "http:") &&
      site !== "" &&
      siteOf(action.hostname) === site
    );
  } catch {
    return false;
  }
};
