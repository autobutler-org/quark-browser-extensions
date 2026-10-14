import { hostOf, isSecurePage, normalizeHost } from "../shared/host";
import { hostMatches } from "../shared/hostMatch";
import type { Credentials, EntryDetail, EntrySummary, Result } from "../shared/types";

export type SaveOffer =
  | Readonly<{ kind: "save"; host: string; username: string }>
  | Readonly<{ kind: "update"; host: string; username: string; entryId: number; entryName: string }>
  | Readonly<{ kind: "unlock"; host: string; username: string }>;

export type SaveAction = "save" | "update" | "never" | "dismiss" | "unlock";

export type Pending = Readonly<{
  pageUrl: string;
  credentials: Credentials;
  at: number;
  // Whether the tab has navigated since the submit; the first navigation is the one the submit caused.
  navigated: boolean;
}>;

export const pendingTtlMs = 120_000;
// How soon after the submit a navigation must start to count as the submit's own.
export const postSubmitWindowMs = 15_000;
export const maxCandidates = 5;

export const isFresh = (pending: Pending, now: number): boolean => now - pending.at < pendingTtlMs;

export const capturedNow = (pageUrl: string, credentials: Credentials, now: number): Pending => ({
  pageUrl,
  credentials,
  at: now,
  navigated: false,
});

// A login is offered on the page that submitted it and on the page the submit lands on, and on no later page:
// the navigation the submit causes keeps it, any other navigation drops it (and the password with it).
export const afterNavigation = (pending: Pending, now: number): Pending | null =>
  !pending.navigated && now - pending.at < postSubmitWindowMs ? { ...pending, navigated: true } : null;

export const relatedHosts = (a: string, b: string): boolean => hostMatches(a, b) || hostMatches(b, a);

export const sameUser = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export const isNeverSaved = (neverSave: readonly string[], pageUrl: string): boolean =>
  neverSave.some((host) => hostMatches(host, hostOf(pageUrl)));

export type OfferInput = Readonly<{
  pageUrl: string;
  credentials: Credentials;
  matches: readonly EntrySummary[];
  locked: boolean;
  loadDetail: (id: number) => Promise<Result<EntryDetail>>;
}>;

const details = async (input: OfferInput): Promise<readonly EntryDetail[]> => {
  const loaded = await Promise.all(input.matches.slice(0, maxCandidates).map((entry) => input.loadDetail(entry.id)));
  return loaded.flatMap((result) => (result.ok ? [result.value] : []));
};

export const decideOffer = async (input: OfferInput): Promise<SaveOffer | null> => {
  const host = normalizeHost(hostOf(input.pageUrl));
  const { username, password } = input.credentials;
  if (host === "" || password === "") {
    return null;
  }
  if (input.locked) {
    return input.matches.length > 0 || isSecurePage(input.pageUrl) ? { kind: "unlock", host, username } : null;
  }
  const candidates = await details(input);
  const match =
    candidates.find((entry) => sameUser(entry.username, username)) ??
    (username === "" && candidates.length === 1 ? candidates[0] : undefined);
  if (match !== undefined) {
    return match.password === password
      ? null
      : { kind: "update", host, username: match.username, entryId: match.id, entryName: match.name };
  }
  return isSecurePage(input.pageUrl) && username !== "" ? { kind: "save", host, username } : null;
};

export const newEntryFor = (pageUrl: string, credentials: Credentials) => ({
  name: normalizeHost(hostOf(pageUrl)),
  url: new URL(pageUrl).origin,
  username: credentials.username,
  password: credentials.password,
});
