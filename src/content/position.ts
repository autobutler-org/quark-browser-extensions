// Where the picker's panel goes, as pure geometry so it can be tested without a layout engine. Everything is in
// viewport pixels of the frame the picker lives in: inside an iframe that viewport is the frame's box, so a panel
// that fits here is never clipped by the frame.

export type Box = Readonly<{ top: number; left: number; right: number; bottom: number }>;

export type Viewport = Readonly<{ width: number; height: number }>;

export type PanelSize = Readonly<{
  // The width the panel asks for and the height its content would take with no limit.
  width: number;
  height: number;
}>;

export type Placement = Readonly<{
  side: "below" | "above" | "over";
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}>;

// Space kept between the panel and the frame's edges, and between the panel and the trigger.
export const gutter = 8;
export const gap = 6;
// Below this much room on either side the panel covers the trigger and uses the whole frame height instead.
export const minHeight = 120;

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));

export const placePanel = (trigger: Box, viewport: Viewport, panel: PanelSize): Placement => {
  const width = Math.max(0, Math.min(panel.width, viewport.width - 2 * gutter));
  // Right-aligned with the trigger, which sits at the field's right edge, then pulled back inside the frame.
  const left = clamp(trigger.right - width, gutter, Math.max(gutter, viewport.width - gutter - width));
  const below = viewport.height - gutter - (trigger.bottom + gap);
  const above = trigger.top - gap - gutter;

  if (panel.height <= below) {
    return { side: "below", top: trigger.bottom + gap, left, width, maxHeight: below };
  }
  if (panel.height <= above) {
    return { side: "above", top: trigger.top - gap - panel.height, left, width, maxHeight: above };
  }
  if (Math.max(below, above) >= minHeight) {
    // Neither side fits it all: take the roomier one and let the panel scroll.
    return below >= above
      ? { side: "below", top: trigger.bottom + gap, left, width, maxHeight: below }
      : { side: "above", top: gutter, left, width, maxHeight: above };
  }
  // A frame too small for either side: fill it, centred when the content is shorter than the frame.
  const room = Math.max(0, viewport.height - 2 * gutter);
  const height = Math.min(panel.height, room);
  return { side: "over", top: gutter + (room - height) / 2, left, width, maxHeight: room };
};
