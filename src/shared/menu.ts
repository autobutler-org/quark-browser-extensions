import type { EntrySummary } from "./types";

export const menuRoot = "quark-vault";
export const generateMenuId = "generate";
export const fillPrefix = "fill:";
export const maxMenuEntries = 8;

export type MenuItem = Readonly<{
  id: string;
  title: string;
  enabled: boolean;
}>;

export const menuItems = (matches: readonly EntrySummary[]): readonly MenuItem[] =>
  matches.length === 0
    ? [{ id: "none", title: "No saved logins for this site", enabled: false }]
    : matches.slice(0, maxMenuEntries).map((entry) => ({
        id: `${fillPrefix}${entry.id}`,
        title: `Fill ${entry.name.replaceAll("&", "&&")}`,
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

export const shortcutPlan = (matches: readonly EntrySummary[]): ShortcutPlan => {
  const [only, ...rest] = matches;
  if (only === undefined) {
    return { kind: "popup" };
  }
  return rest.length === 0 ? { kind: "fill", entryId: only.id } : { kind: "picker" };
};
