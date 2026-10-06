import { entryIdFromMenu, maxMenuEntries, menuItems, shortcutPlan } from "../src/shared/menu";
import type { EntrySummary } from "../src/shared/types";

const entry = (id: number, name: string): EntrySummary => ({
  id,
  name,
  urlHost: "example.com",
  folderId: null,
  createdAt: "",
  updatedAt: "",
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
});
