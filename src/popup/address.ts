// What to suggest when the saved Quark address can't be reached. An address typed without a scheme is
// saved as https, which is the usual mistake for a Quark that only serves plain http on the LAN.
export const unreachableHint = (server: string): string => {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return "Check the address, then try again.";
  }
  if (url.protocol === "https:") {
    return `Tried ${url.origin}. If your Quark serves plain http, edit the address to http://${url.host}.`;
  }
  return `Tried ${url.origin}. Check the address and port, and that your Quark is online.`;
};
