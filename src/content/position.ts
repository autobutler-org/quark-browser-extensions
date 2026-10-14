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
  // Neither side fits it all, as in a short iframe (#117): cover the trigger rather than scroll, staying as close
  // below it as the frame allows, so every row shows. Content taller than the frame fills it and scrolls.
  const room = Math.max(0, viewport.height - 2 * gutter);
  const height = Math.min(panel.height, room);
  return { side: "over", top: Math.max(gutter, Math.min(trigger.bottom + gap, viewport.height - gutter - height)), left, width, maxHeight: room };
};

// The inline button: its size, and the space kept between it and the field's right edge or a control there.
export const iconSize = 22;
export const iconInset = 6;

// Where the button's right edge goes in a field whose right end may hold the page's own controls, such as a
// show-password toggle (#119). Each control that overlaps the field's middle row in its right half pushes the
// button to its left. A field too narrow to fit the button beside them keeps it at the right edge.
export const iconRight = (field: Box, controls: readonly Box[]): number => {
  const middle = (field.top + field.bottom) / 2;
  const half = (field.left + field.right) / 2;
  const inField = controls.filter(
    (control) => control.top <= middle && control.bottom >= middle && control.right > half && control.left < field.right,
  );
  let right = field.right - iconInset;
  for (const control of [...inField].sort((a, b) => b.right - a.right)) {
    if (control.left < right && control.right > right - iconSize) {
      right = Math.min(right, control.left - iconInset);
    }
  }
  return right - iconSize < field.left ? field.right - iconInset : right;
};
