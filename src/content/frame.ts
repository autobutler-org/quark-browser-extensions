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
