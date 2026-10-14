import { gap, gutter, iconInset, iconRight, iconSize, placePanel } from "../src/content/position";

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

  // A same-site iframe of 360px with the field in the middle has room for two rows on either side. Covering the
  // trigger shows every row instead of a two-row scroll box (#117).
  it("covers the trigger to show the whole panel when the frame fits it but neither side does", () => {
    const spot = placePanel(trigger(150), { width: 520, height: 360 }, { width: 300, height: 270 });
    expect(spot).toMatchObject({ side: "over", top: 360 - gutter - 270, maxHeight: 360 - 2 * gutter });
    expect(spot.top).toBeGreaterThanOrEqual(gutter);
    expect(spot.top + 270).toBeLessThanOrEqual(360 - gutter);
  });

  it("stays as close below the trigger as it can when covering it", () => {
    const spot = placePanel(trigger(60), { width: 520, height: 300 }, { width: 300, height: 240 });
    expect(spot).toMatchObject({ side: "over", top: 300 - gutter - 240 });
  });

  it("uses the whole frame and scrolls when the content is taller than the frame", () => {
    for (const top of [100, 280]) {
      expect(placePanel(trigger(top), { width: 800, height: 400 }, { width: 300, height: 1000 })).toMatchObject({
        side: "over",
        top: gutter,
        maxHeight: 400 - 2 * gutter,
      });
    }
  });

  it("covers a frame too small for either side and stays inside it", () => {
    const spot = placePanel(trigger(60), { width: 320, height: 150 }, { width: 300, height: 400 });
    expect(spot).toMatchObject({ side: "over", top: gutter, maxHeight: 150 - 2 * gutter });
  });

  it("keeps a short panel in a tiny frame inside it", () => {
    const spot = placePanel(trigger(40), { width: 320, height: 104 }, { width: 300, height: 70 });
    expect(spot.side).toBe("over");
    expect(spot.top).toBe(104 - gutter - 70);
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

// A field 300px wide and 32px tall at (100, 50).
const field = { top: 50, left: 100, right: 400, bottom: 82 };

describe("iconRight", () => {
  it("sits just inside the field's right edge when nothing else is there", () => {
    expect(iconRight(field, [])).toBe(400 - iconInset);
  });

  // A show-password toggle drawn over the field's right end (#119).
  it("moves left of a control drawn inside the field's right end", () => {
    const eye = { top: 54, left: 368, right: 392, bottom: 78 };
    expect(iconRight(field, [eye])).toBe(368 - iconInset);
  });

  it("clears every trailing control, in any order", () => {
    const eye = { top: 54, left: 368, right: 392, bottom: 78 };
    const clear = { top: 56, left: 344, right: 364, bottom: 76 };
    expect(iconRight(field, [clear, eye])).toBe(344 - iconInset);
  });

  it("ignores controls beside, above or below the field, or at its start", () => {
    const after = { top: 50, left: 410, right: 440, bottom: 82 };
    const below = { top: 90, left: 360, right: 390, bottom: 110 };
    const leading = { top: 54, left: 104, right: 128, bottom: 78 };
    expect(iconRight(field, [after, below, leading])).toBe(400 - iconInset);
  });

  it("stays at the right edge rather than leave a narrow field", () => {
    const narrow = { top: 50, left: 100, right: 150, bottom: 82 };
    const eye = { top: 54, left: 120, right: 144, bottom: 78 };
    expect(iconRight(narrow, [eye])).toBe(150 - iconInset);
    expect(iconSize).toBe(22);
  });
});
