import { gap, gutter, placePanel } from "../src/content/position";

// A 22px trigger whose right edge is at `right` and top at `top`.
const trigger = (top: number, right = 300) => ({ top, left: right - 22, right, bottom: top + 22 });

describe("placePanel", () => {
  it("opens below the trigger, right-aligned with it, when there is room", () => {
    expect(placePanel(trigger(100, 400), { width: 800, height: 600 }, { width: 300, height: 200 })).toEqual({
      side: "below",
      top: 122 + gap,
      left: 100,
      width: 300,
      maxHeight: 600 - gutter - 122 - gap,
    });
  });

  it("flips above the trigger when only the space above fits it", () => {
    const spot = placePanel(trigger(260, 400), { width: 800, height: 300 }, { width: 300, height: 200 });
    expect(spot.side).toBe("above");
    expect(spot.top + 200).toBe(260 - gap);
    expect(spot.top).toBeGreaterThanOrEqual(gutter);
  });

  it("takes the roomier side and scrolls when neither side fits it all", () => {
    const below = placePanel(trigger(100), { width: 800, height: 400 }, { width: 300, height: 1000 });
    expect(below).toMatchObject({ side: "below", top: 122 + gap, maxHeight: 400 - gutter - 122 - gap });
    const above = placePanel(trigger(280), { width: 800, height: 400 }, { width: 300, height: 1000 });
    expect(above).toMatchObject({ side: "above", top: gutter, maxHeight: 280 - gap - gutter });
    expect(above.top + above.maxHeight).toBe(280 - gap);
  });

  it("covers a frame too small for either side and stays inside it", () => {
    const spot = placePanel(trigger(60), { width: 320, height: 150 }, { width: 300, height: 400 });
    expect(spot).toMatchObject({ side: "over", top: gutter, maxHeight: 150 - 2 * gutter });
  });

  it("centres a short panel in a tiny frame", () => {
    const spot = placePanel(trigger(40), { width: 320, height: 104 }, { width: 300, height: 48 });
    expect(spot.side).toBe("over");
    expect(spot.top).toBe(gutter + (104 - 2 * gutter - 48) / 2);
  });

  it("narrows to a narrow frame and keeps its left edge inside", () => {
    const spot = placePanel(trigger(10, 150), { width: 200, height: 600 }, { width: 300, height: 100 });
    expect(spot.width).toBe(200 - 2 * gutter);
    expect(spot.left).toBe(gutter);
  });

  it("pulls a panel back from either edge of the frame", () => {
    expect(placePanel(trigger(10, 100), { width: 800, height: 600 }, { width: 300, height: 100 }).left).toBe(gutter);
    expect(placePanel(trigger(10, 1000), { width: 800, height: 600 }, { width: 300, height: 100 }).left).toBe(800 - gutter - 300);
  });

  it("never returns negative sizes for a degenerate frame", () => {
    const spot = placePanel(trigger(0, 0), { width: 0, height: 0 }, { width: 300, height: 100 });
    expect(spot.width).toBe(0);
    expect(spot.maxHeight).toBe(0);
  });
});
