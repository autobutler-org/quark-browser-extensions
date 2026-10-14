import { t } from "./i18n";
import { primaryMatches, type SiteMatch } from "./host";

export const menuRoot = "quark-vault";
export const generateMenuId = "generate";
export const fillPrefix = "fill:";
export const maxMenuEntries = 8;

export type MenuItem = Readonly<{
  id: string;
  title: string;
  enabled: boolean;
}>;

// A fallback (another port or scheme on this host) is left out: filling one needs the popup's confirmation.
export const menuItems = (matches: readonly SiteMatch[]): readonly MenuItem[] => {
  const primary = primaryMatches(matches);
  return primary.length === 0
    ? [{ id: "none", title: t("menuNoLogins"), enabled: false }]
    : primary.slice(0, maxMenuEntries).map((entry) => ({
        id: `${fillPrefix}${entry.id}`,
        title: t("fillName", entry.name).replaceAll("&", "&&"),
        enabled: true,
      }));
};

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

// Only a single exact or same-site match is filled straight away. With fallbacks alone, the popup opens, since
// only its confirmation can fill one.
export const shortcutPlan = (matches: readonly SiteMatch[]): ShortcutPlan => {
  const [only, ...rest] = primaryMatches(matches);
  if (only === undefined) {
    return { kind: "popup" };
  }
  return rest.length === 0 ? { kind: "fill", entryId: only.id } : { kind: "picker" };
};
