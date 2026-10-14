import type { Sender } from "./gate";
import type { PageCommand } from "../shared/messages";

// Whether a subframe is shown on the page (#141). A frame can't measure its own <iframe> element when its parent
// is another origin (frameElement is null), and must not be believed if it reports a size for itself. So the
// worker asks the parent: it gives the child frame a nonce, the child's content script posts that nonce to
// window.parent, and the parent's content script finds the <iframe> whose contentWindow sent it, measures that
// element with the same rules as a login field, and reports back. The browser, not the page, says which frame
// sent the report, so the worker learns the parent's frame id and repeats the check for it, up to the top frame.

type Send = (tabId: number, message: PageCommand, options: { frameId: number }) => Promise<unknown>;

type Probe = Readonly<{ tabId: number; settle: (parent: number, shown: boolean) => void }>;

const probes = new Map<string, Probe>();

// How long a parent has to report before the frame counts as hidden.
export const probeTimeoutMs = 1000;

// Frames nest only so deep; a longer chain means something is wrong.
const maxDepth = 16;

// A report from the content script of `sender`. Only a nonce the worker gave out, from the same tab, counts, and
// only the first report for it.
export const frameReport = (sender: Sender, nonce: string, shown: boolean): void => {
  const probe = probes.get(nonce);
  if (probe === undefined || sender.tab?.id !== probe.tabId || sender.frameId === undefined) {
    return;
  }
  probes.delete(nonce);
  probe.settle(sender.frameId, shown);
};

const probeParent = (send: Send, tabId: number, child: number): Promise<Readonly<{ parent: number; shown: boolean }> | null> =>
  new Promise((resolve) => {
    const nonce = crypto.randomUUID();
    const timer = setTimeout(() => {
      probes.delete(nonce);
      resolve(null);
    }, probeTimeoutMs);
    probes.set(nonce, {
      tabId,
      settle: (parent, shown) => {
        clearTimeout(timer);
        resolve({ parent, shown });
      },
    });
    send(tabId, { type: "announceFrame", nonce }, { frameId: child }).catch(() => undefined);
  });

// Whether frame `frameId` and every frame above it are shown in their parents. A parent that doesn't answer in
// time (no content script, a page that swallows the message) counts as hiding it.
export const frameIsShown = async (send: Send, tabId: number, frameId: number): Promise<boolean> => {
  const seen = new Set<number>();
  for (let child = frameId; child !== 0; ) {
    if (seen.has(child) || seen.size >= maxDepth) {
      return false;
    }
    seen.add(child);
    const report = await probeParent(send, tabId, child);
    if (report === null || !report.shown) {
      return false;
    }
    child = report.parent;
  }
  return true;
};
