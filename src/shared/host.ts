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

export const hostMatches = (entryHost: string, pageHost: string): boolean => {
  const entry = normalizeHost(entryHost);
  const page = normalizeHost(pageHost);
  return entry !== "" && page !== "" && (page === entry || page.endsWith(`.${entry}`));
};

const byName = (a: EntrySummary, b: EntrySummary): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export const matchEntries = (
  entries: readonly EntrySummary[],
  pageHost: string,
): readonly EntrySummary[] => {
  const page = normalizeHost(pageHost);
  const rank = (entry: EntrySummary): number => (normalizeHost(entry.urlHost) === page ? 0 : 1);
  return entries
    .filter((entry) => hostMatches(entry.urlHost, pageHost))
    .toSorted((a, b) => rank(a) - rank(b) || byName(a, b));
};

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
    return protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

export const mayFill = (pageUrl: string, entryUrl: string, entryHost: string): boolean => {
  const insecureAllowed = entryUrl.trim().toLowerCase().startsWith("http://");
  return hostMatches(entryHost, hostOf(pageUrl)) && (isSecurePage(pageUrl) || insecureAllowed);
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
