import { hostMatches, hostOf, isSecurePage, normalizeHost } from "../shared/host";
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
}>;

export const pendingTtlMs = 120_000;
export const maxCandidates = 5;

export const isFresh = (pending: Pending, now: number): boolean => now - pending.at < pendingTtlMs;

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
