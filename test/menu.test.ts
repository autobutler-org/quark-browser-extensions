import { entryIdFromMenu, maxMenuEntries, menuItems, shortcutPlan } from "../src/shared/menu";
import type { MatchKind, SiteMatch } from "../src/shared/host";

const entry = (id: number, name: string, kind: MatchKind = "exact"): SiteMatch => ({
  id,
  name,
  urlHost: "example.com",
  folderId: null,
  createdAt: "",
  updatedAt: "",
  kind,
  where: kind === "otherPort" ? "example.com:8443" : "example.com",
  note: kind === "otherPort" ? "Different port" : "",
});

describe("menuItems", () => {
  it("shows a disabled placeholder with no matches", () => {
    expect(menuItems([])).toEqual([{ id: "none", title: "No saved logins for this site", enabled: false }]);
  });

  it("lists matches, escaping ampersands and capping the count", () => {
    const items = menuItems(Array.from({ length: 12 }, (_, i) => entry(i + 1, i === 0 ? "Tom & Jerry" : `E${i}`)));
    expect(items).toHaveLength(maxMenuEntries);
    expect(items[0]).toEqual({ id: "fill:1", title: "Fill Tom && Jerry", enabled: true });
  });

  it("names where a fallback was saved", () => {
    expect(menuItems([entry(1, "Admin", "otherPort")])).toEqual([{ id: "fill:1", title: "Fill Admin (example.com:8443)", enabled: true }]);
  });
});

describe("entryIdFromMenu", () => {
  it.each([
    ["fill:42", 42],
    ["fill:0", null],
    ["fill:abc", null],
    ["none", null],
    [7, null],
  ])("%s → %s", (id, expected) => {
    expect(entryIdFromMenu(id)).toBe(expected);
  });
});

describe("shortcutPlan", () => {
  it("fills a single match, opens the picker for several, and the popup for none", () => {
    expect(shortcutPlan([entry(3, "A")])).toEqual({ kind: "fill", entryId: 3 });
    expect(shortcutPlan([entry(3, "A"), entry(4, "B")])).toEqual({ kind: "picker" });
    expect(shortcutPlan([])).toEqual({ kind: "popup" });
  });

  it("fills the single exact match even with fallbacks around it", () => {
    expect(shortcutPlan([entry(3, "A"), entry(4, "B", "otherPort")])).toEqual({ kind: "fill", entryId: 3 });
  });

  it("never fills a fallback without a pick", () => {
    expect(shortcutPlan([entry(4, "B", "otherPort")])).toEqual({ kind: "picker" });
    expect(shortcutPlan([entry(4, "B", "otherScheme")])).toEqual({ kind: "picker" });
  });
});
