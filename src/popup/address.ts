import { t } from "../shared/i18n";

// What to suggest when the saved Quark address can't be reached. An address typed without a scheme is
// saved as https, which is the usual mistake for a Quark that only serves plain http on the LAN.
export const unreachableHint = (server: string): string => {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return t("addressCheck");
  }
  if (url.protocol === "https:") {
    return t("addressTriedHttps", url.origin, url.host);
  }
  return t("addressTried", url.origin);
};
