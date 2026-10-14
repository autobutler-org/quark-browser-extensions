import { t } from "./i18n";
import { isFallback, primaryMatches, type SiteMatch } from "./host";

export const menuRoot = "quark-vault";
export const generateMenuId = "generate";
export const fillPrefix = "fill:";
export const maxMenuEntries = 8;

export type MenuItem = Readonly<{
  id: string;
  title: string;
  enabled: boolean;
}>;

// A fallback (another port or scheme on this host) names where it was saved, so it's never mistaken for
// a login for this page.
export const menuItems = (matches: readonly SiteMatch[]): readonly MenuItem[] =>
  matches.length === 0
    ? [{ id: "none", title: t("menuNoLogins"), enabled: false }]
    : matches.slice(0, maxMenuEntries).map((entry) => ({
        id: `${fillPrefix}${entry.id}`,
        title: (isFallback(entry) ? t("menuFillWhere", entry.name, entry.where) : t("fillName", entry.name)).replaceAll("&", "&&"),
        enabled: true,
      }));

export const entryIdFromMenu = (menuItemId: string | number): number | null => {
  const id = String(menuItemId);
  if (!id.startsWith(fillPrefix)) {
    return null;
  }
  const parsed = Number(id.slice(fillPrefix.length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export type ShortcutPlan =
  | Readonly<{ kind: "fill"; entryId: number }>
  | Readonly<{ kind: "picker" }>
  | Readonly<{ kind: "popup" }>;

// Only a single exact or same-site match is filled straight away; a fallback always needs a pick.
export const shortcutPlan = (matches: readonly SiteMatch[]): ShortcutPlan => {
  if (matches.length === 0) {
    return { kind: "popup" };
  }
  const [only, ...rest] = primaryMatches(matches);
  return only !== undefined && rest.length === 0 ? { kind: "fill", entryId: only.id } : { kind: "picker" };
};
