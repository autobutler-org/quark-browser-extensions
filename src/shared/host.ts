import { t } from "./i18n";
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

export const byName = (a: EntrySummary, b: EntrySummary): number =>
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
  }>;

// Offer "Copy one-time code" unless the entry is known to have none.
export const mayHaveOtp = (entry: EntrySummary): boolean => entry.hasTotp !== false;

export const isFallback = (match: SiteMatch): boolean => match.kind === "otherPort" || match.kind === "otherScheme";

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

export const insecureServerRefusal = (): string => t("insecureServerRefusal");

// Whether what's typed in the connect form's address box needs the "unencrypted" confirmation.
export const needsInsecureConfirmation = (input: string): boolean => {
  const server = normalizeServer(input);
  return server !== "" && serverTransport(server) === "insecure";
};

export const insecureServerWarning = (): string => t("insecureServerWarning");
