import type { FillCommand } from "../shared/messages";
import type { Sender } from "./gate";

// "Fill anyway": the one path that fills an entry into a page its host doesn't match. Only the popup can start
// it (fillAnyway is an extension-page request), and only after the user confirmed a warning naming both hosts.
// Starting it leaves a grant behind: for a few seconds, the top frame of that tab, still on the origin the user
// confirmed, may collect that one entry once with fillFromPage. The credentials still travel the usual way, pulled
// by the frame from the worker, never pushed.

export type ManualGrant = Readonly<{
  tabId: number;
  entryId: number;
  origin: string;
  expires: number;
}>;

// Long enough for the top frame to answer the fill command, short enough that a grant left over by a frame that
// never asked can't be used later.
export const manualGrantMs = 10_000;

const webUrl = (url: string): URL | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
};

// The host the popup shows the user, port included, so the confirmation names exactly what the worker checks.
export const pageHostOf = (url: string): string => webUrl(url)?.host ?? "";

// Why the worker won't start a manual fill in a tab now on `tabUrl` after the user confirmed `confirmedHost`;
// null when it may.
export const manualFillRefusal = (tabUrl: string, confirmedHost: string): string | null => {
  const host = pageHostOf(tabUrl);
  if (host === "") {
    return "This page can't be filled.";
  }
  return host === confirmedHost ? null : `This tab is now on ${host}, not ${confirmedHost}. Open the popup again to fill it.`;
};

export const grantFor = (tabId: number, entryId: number, tabUrl: string, now: number): ManualGrant | null => {
  const url = webUrl(tabUrl);
  return url === null ? null : { tabId, entryId, origin: url.origin, expires: now + manualGrantMs };
};

// Whether `sender`, asking for `entryId`, is the frame the user confirmed: frame 0 of the granted tab, on the
// granted origin, as the browser reports it.
export const grantAllows = (grant: ManualGrant | undefined, sender: Sender, entryId: number, now: number): boolean =>
  grant !== undefined &&
  now < grant.expires &&
  sender.frameId === 0 &&
  sender.tab?.id === grant.tabId &&
  entryId === grant.entryId &&
  webUrl(sender.url ?? "")?.origin === grant.origin;

// The fill command for a manual fill goes to frame 0 only. It names the page itself as the target, so the top
// frame's own check passes and it asks the worker, which then answers only because of the grant. It still carries
// no username or password.
export const manualFillCommand = (entryId: number, tabUrl: string): FillCommand => ({
  type: "fill",
  entryId,
  entryUrl: tabUrl,
  entryHost: webUrl(tabUrl)?.hostname ?? "",
  topUrl: tabUrl,
});
