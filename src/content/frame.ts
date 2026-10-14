import { frameMayFill } from "../shared/host";

type Origins = Readonly<{ length: number; item: (index: number) => string | null }>;

// The top page's URL as seen from this frame. location.ancestorOrigins is page-independent, so it wins where it
// exists; Firefox lacks it, so there the frame falls back to the top URL the service worker verified with frame 0.
export const frameTopUrl = (
  isTop: boolean,
  href: string,
  ancestorOrigins: Origins | undefined,
  verifiedTopUrl: string | undefined,
): string => {
  if (isTop) {
    return href;
  }
  if (ancestorOrigins === undefined) {
    return verifiedTopUrl ?? "";
  }
  const top = ancestorOrigins.length === 0 ? null : ancestorOrigins.item(ancestorOrigins.length - 1);
  return top ?? "";
};

export type FillDecision =
  | Readonly<{ kind: "silent" }>
  | Readonly<{ kind: "refuse"; reason: string }>
  | Readonly<{ kind: "ask" }>;

// What a frame does with a fill command. Every frame in the tab gets one, so only a frame whose own URL and top
// URL fit the entry asks the worker for the credentials ("ask"); the worker then checks again with the URLs the
// browser reports. Other frames stay quiet so the frame that fills gets to answer, except a top frame that
// doesn't fit, which says why.
export const fillDecision = (
  isTop: boolean,
  hasLoginFields: boolean,
  href: string,
  topUrl: string,
  entryUrl: string,
  entryHost: string,
): FillDecision => {
  if (!hasLoginFields) {
    return { kind: "silent" };
  }
  if (!frameMayFill(href, href, entryUrl, entryHost)) {
    return isTop ? { kind: "refuse", reason: "This login doesn't belong to this site." } : { kind: "silent" };
  }
  if (!frameMayFill(href, topUrl, entryUrl, entryHost)) {
    return { kind: "refuse", reason: "This login form is embedded in another site, so Quark Vault won't fill it." };
  }
  return { kind: "ask" };
};
