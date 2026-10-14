import { sameSiteAction } from "../shared/hostMatch";
import type { FieldRules } from "../shared/password";
import type { Credentials } from "../shared/types";

const usernameTypes = new Set(["text", "email", "tel", ""]);

// A host's shadow root, open or closed. Content scripts may read closed ones: Chrome through chrome.dom, Firefox
// through Element.openOrClosedShadowRoot. Undefined when neither is there to ask, or the browser refuses.
const shadowRootOf = (host: Element): ShadowRoot | null | undefined => {
  if (host.shadowRoot !== null) {
    return host.shadowRoot;
  }
  try {
    const firefox = (host as Partial<{ openOrClosedShadowRoot: () => ShadowRoot | null }>).openOrClosedShadowRoot;
    if (typeof firefox === "function") {
      return firefox.call(host);
    }
    const dom = (globalThis as Partial<{ chrome: Partial<typeof chrome> }>).chrome?.dom;
    if (typeof dom?.openOrClosedShadowRoot === "function") {
      return host instanceof HTMLElement ? dom.openOrClosedShadowRoot(host) : null;
    }
  } catch {
    // Treated as unreadable.
  }
  return undefined;
};

// The slot a light-DOM element is drawn in (#139), and whether that could be told: assignedSlot is null for a
// closed root, so its slots are searched instead.
type Slotting = Readonly<{ slot: HTMLSlotElement | null; known: boolean }>;

const slotting = (element: Element, host: Element | null): Slotting => {
  if (element.assignedSlot !== null || host === null || host.shadowRoot !== null) {
    return { slot: element.assignedSlot, known: true };
  }
  const cached = pass?.slots.get(element);
  if (cached !== undefined) {
    return cached;
  }
  const root = shadowRootOf(host);
  const slot = root?.querySelectorAll("slot") ?? [];
  const found: Slotting = {
    slot: [...slot].find((candidate) => candidate.assignedElements().includes(element)) ?? null,
    known: root !== undefined,
  };
  pass?.slots.set(element, found);
  return found;
};

// The parent in the flat tree, as the page is drawn: a slotted element's slot, else its parent, else the host of
// the shadow root it is in. So checks walk through the slot's wrappers and out of shadow roots.
const parentOf = (element: Element): Element | null => {
  const parent = element.parentElement;
  return slotting(element, parent).slot ?? parent ?? (element.getRootNode() as Partial<ShadowRoot>).host ?? null;
};

const ancestors = (element: Element): readonly Element[] => {
  const found: Element[] = [];
  for (let node: Element | null = element; node !== null; node = parentOf(node)) {
    found.push(node);
  }
  return found;
};

// While a pass runs, the page is taken as unchanged: each scope is walked once and each element's style read once.
type Pass = Readonly<{
  inputs: Map<ParentNode, readonly HTMLInputElement[]>;
  styles: Map<Element, CSSStyleDeclaration | undefined>;
  opacity: Map<Element, number>;
  shown: Map<Element, boolean>;
  unclipped: Map<Element, boolean>;
  exposed: Map<Element, boolean>;
  slots: Map<Element, Slotting>;
  frames: Map<Document, boolean>;
  canvases: Map<Document, readonly HTMLCanvasElement[]>;
  checks: Map<object, Map<HTMLInputElement, boolean>>;
}>;
let pass: Pass | null = null;

// Runs `detect` as one pass over the page. It must not change the page.
export const onePass = <T>(detect: () => T): T => {
  if (pass !== null) {
    return detect();
  }
  pass = { inputs: new Map(), styles: new Map(), opacity: new Map(), shown: new Map(), unclipped: new Map(), exposed: new Map(), slots: new Map(), frames: new Map(), canvases: new Map(), checks: new Map() };
  try {
    return detect();
  } finally {
    pass = null;
  }
};

// A check on one input, answered once per pass.
const perPass = (check: (input: HTMLInputElement) => boolean): ((input: HTMLInputElement) => boolean) => {
  const key = {};
  return (input) => {
    if (pass === null) {
      return check(input);
    }
    const answers = pass.checks.get(key) ?? new Map<HTMLInputElement, boolean>();
    pass.checks.set(key, answers);
    const answer = answers.get(input) ?? check(input);
    answers.set(input, answer);
    return answer;
  };
};

const styleOf = (node: Element): CSSStyleDeclaration | undefined => {
  if (pass?.styles.has(node) === true) {
    return pass.styles.get(node);
  }
  const style = node.ownerDocument.defaultView?.getComputedStyle(node);
  pass?.styles.set(node, style);
  return style;
};

const isShown = (node: Element): boolean => {
  const style = styleOf(node);
  return (
    !node.hasAttribute("hidden") &&
    (style === undefined || (style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"))
  );
};

// Whether `test` holds for `element` and every ancestor; in a pass, each ancestor's answer is kept for its other
// descendants in `known`.
const everyAncestor = (element: Element, test: (node: Element) => boolean, known: Map<Element, boolean> | undefined): boolean => {
  if (known === undefined) {
    return ancestors(element).every(test);
  }
  const unknown: Element[] = [];
  let result = true;
  for (let node: Element | null = element; node !== null; node = parentOf(node)) {
    const answer = known.get(node);
    if (answer !== undefined) {
      result = answer;
      break;
    }
    unknown.push(node);
  }
  // Settle from the top down, so a failing ancestor answers for everything below it without testing them.
  for (const node of unknown.reverse()) {
    result = result && test(node);
    known.set(node, result);
  }
  return result;
};

export const isVisible = (element: HTMLElement): boolean =>
  !(element as HTMLInputElement).disabled && everyAncestor(element, isShown, pass?.shown);

// Below this opacity, or this many pixels across, the user can't see a field.
const minOpacity = 0.1;
const minSize = 4;

// How much a filter fades what it draws: the product of its opacity() functions (#142).
const filterOpacity = (filter: string): number =>
  [...filter.matchAll(/(?:^|[\s)])opacity\(\s*([^)]*)\)/g)]
    .map(([, amount = ""]) => {
      const value = Number.parseFloat(amount);
      const fraction = amount.trim() === "" ? 1 : amount.trim().endsWith("%") ? value / 100 : value;
      return Number.isNaN(fraction) ? 1 : Math.min(1, Math.max(0, fraction));
    })
    .reduce((product, factor) => product * factor, 1);

// The opacity the element is drawn with: its own times every ancestor's, filters included.
const opacityOf = (element: Element): number => {
  const known = pass?.opacity;
  const unknown: Element[] = [];
  let product = 1;
  for (let node: Element | null = element; node !== null; node = parentOf(node)) {
    const found = known?.get(node);
    if (found !== undefined) {
      product = found;
      break;
    }
    unknown.push(node);
  }
  for (const node of unknown.reverse()) {
    const style = styleOf(node);
    const own = Number.parseFloat(style?.opacity ?? "");
    product *= (Number.isNaN(own) ? 1 : own) * filterOpacity(style?.filter ?? "");
    known?.set(node, product);
  }
  return product;
};

type Box = { left: number; top: number; right: number; bottom: number };

const cut = (box: Box, by: Box): Box => ({
  left: Math.max(box.left, by.left),
  top: Math.max(box.top, by.top),
  right: Math.min(box.right, by.right),
  bottom: Math.min(box.bottom, by.bottom),
});

const fits = (box: Box): boolean => box.right - box.left >= minSize && box.bottom - box.top >= minSize;

// Splits a CSS value at `separator` outside parentheses.
const splitTop = (text: string, separator: string): readonly string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  [...text].forEach((char, index) => {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (depth === 0 && (separator === " " ? /\s/.test(char) : char === separator)) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  });
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
};

// A length as pixels plus a percentage of some size: "12px", "50%", "0", or a calc() that adds and subtracts them.
type Length = Readonly<{ px: number; pct: number }>;

const lengthOf = (token: string): Length | null => {
  const sum = /^calc\((.*)\)$/.exec(token)?.[1];
  if (sum !== undefined) {
    const terms = sum.replace(/\s+-\s+/g, " + -").split(/\s+\+\s+/).map((term) => lengthOf(term.trim()));
    return terms.some((term) => term === null)
      ? null
      : terms.reduce<Length>((total, term) => ({ px: total.px + (term?.px ?? 0), pct: total.pct + (term?.pct ?? 0) }), { px: 0, pct: 0 });
  }
  const [, number = "", unit] = /^(-?[\d.]+(?:e-?\d+)?)(px|%)?$/.exec(token) ?? [];
  const value = Number.parseFloat(number);
  if (Number.isNaN(value) || (unit === undefined && value !== 0)) {
    return null;
  }
  return unit === "%" ? { px: 0, pct: value } : { px: value, pct: 0 };
};

const zero: Length = { px: 0, pct: 0 };

const resolve = (length: Length, size: number): number => length.px + (length.pct / 100) * size;

type Point = readonly [number, number];

// What is left of a polygon inside the box from (0, 0) to (width, height): Sutherland–Hodgman, one edge at a time.
const clipToBox = (polygon: readonly Point[], width: number, height: number): readonly Point[] => {
  const edges: readonly ((point: Point) => number)[] = [([x]) => x, ([x]) => width - x, ([, y]) => y, ([, y]) => height - y];
  return edges.reduce<readonly Point[]>((points, inside) => {
    return points.flatMap((point, index) => {
      const previous = points[(index + points.length - 1) % points.length] ?? point;
      const [now, before] = [inside(point), inside(previous)];
      const crossing = (): Point => {
        const t = before / (before - now);
        return [previous[0] + t * (point[0] - previous[0]), previous[1] + t * (point[1] - previous[1])];
      };
      if (now >= 0) {
        return before < 0 ? [crossing(), point] : [point];
      }
      return before >= 0 ? [crossing()] : [];
    });
  }, polygon);
};

// What a polygon leaves of the box from (0, 0) to (width, height): its bounds once cut to the box, or nothing
// when it covers less than minSize² there.
const polygonBounds = (polygon: readonly Point[], width: number, height: number): Box => {
  const left = clipToBox(polygon, width, height);
  const twiceArea = left.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = left[(index + 1) % left.length] ?? [x, y];
    return sum + x * nextY - nextX * y;
  }, 0);
  if (left.length < 3 || Math.abs(twiceArea) / 2 < minSize * minSize) {
    return nothing;
  }
  const xs = left.map(([x]) => x);
  const ys = left.map(([, y]) => y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
};

const nothing: Box = { left: 0, top: 0, right: 0, bottom: 0 };

const positionKeywords: Readonly<Record<string, Length>> = {
  left: { px: 0, pct: 0 },
  top: { px: 0, pct: 0 },
  center: { px: 0, pct: 50 },
  right: { px: 0, pct: 100 },
  bottom: { px: 0, pct: 100 },
};

// The centre of a circle() or ellipse(): "at X Y" with lengths or single keywords, else the middle of the box.
const centreOf = (position: string | undefined, width: number, height: number): Point | null => {
  const [x = "center", y = "center"] = position === undefined ? [] : splitTop(position, " ");
  const [atX, atY] = [positionKeywords[x] ?? lengthOf(x), positionKeywords[y] ?? lengthOf(y)];
  return atX === null || atY === null || splitTop(position ?? "", " ").length > 2 ? null : [resolve(atX, width), resolve(atY, height)];
};

// A circle() or ellipse() radius along one axis: a length, or the distance to the nearest or farthest side.
const radiusOf = (token: string, centre: number, size: number, reference: number): number | null => {
  if (token === "closest-side") {
    return Math.min(Math.abs(centre), Math.abs(size - centre));
  }
  if (token === "farthest-side") {
    return Math.max(Math.abs(centre), Math.abs(size - centre));
  }
  const length = lengthOf(token);
  return length === null ? null : resolve(length, reference);
};

// The bounds of a clip-path's basic shape in the element's own box, which may reach past it. Null for no shape,
// an unknown one (path(), url()) or values this can't read: those count as clipping nothing.
const shapeBounds = (clipPath: string, width: number, height: number): Box | null => {
  const [, shape, args = ""] = /\b(inset|rect|xywh|polygon|circle|ellipse)\((.*)\)/.exec(clipPath) ?? [];
  if (shape === "inset") {
    const lengths = splitTop(args.split(/\sround\s/)[0] ?? "", " ").map(lengthOf);
    if (lengths.length === 0 || lengths.length > 4 || lengths.some((length) => length === null)) {
      return null;
    }
    const [top = zero, right = top, bottom = top, left = right] = lengths as Length[];
    return { left: resolve(left, width), top: resolve(top, height), right: width - resolve(right, width), bottom: height - resolve(bottom, height) };
  }
  if (shape === "rect" || shape === "xywh") {
    const tokens = splitTop(args.split(/\sround\s/)[0] ?? "", " ");
    const edges = tokens.map((token, index) =>
      token === "auto" && shape === "rect" ? { px: 0, pct: index === 0 || index === 3 ? 0 : 100 } : lengthOf(token),
    );
    if (tokens.length !== 4 || edges.some((edge) => edge === null)) {
      return null;
    }
    // rect(top right bottom left); xywh(x y width height).
    const vertical = shape === "rect" ? [true, false, true, false] : [false, true, false, true];
    const [a = 0, b = 0, c = 0, d = 0] = (edges as Length[]).map((edge, index) => resolve(edge, vertical[index] === true ? height : width));
    return shape === "rect" ? { left: d, top: a, right: b, bottom: c } : { left: a, top: b, right: a + c, bottom: b + d };
  }
  if (shape === "polygon") {
    const parts = splitTop(args, ",");
    const points = parts
      .filter((part, index) => !(index === 0 && /^(nonzero|evenodd)$/.test(part)))
      .map((part) => splitTop(part, " ").map(lengthOf));
    if (points.some((point) => point.length !== 2 || point.some((length) => length === null))) {
      return null;
    }
    return polygonBounds(points.map(([x, y]) => [resolve(x as Length, width), resolve(y as Length, height)]), width, height);
  }
  if (shape === "circle" || shape === "ellipse") {
    const [radii = "", position] = args.split(/(?:^|\s)at\s/).map((part) => part.trim());
    const centre = centreOf(position, width, height);
    const tokens = splitTop(radii, " ");
    if (centre === null) {
      return null;
    }
    const [cx, cy] = centre;
    const [rx, ry] =
      shape === "circle"
        ? (() => {
            const token = tokens[0] ?? "closest-side";
            const r =
              token === "closest-side" || token === "farthest-side"
                ? (token === "closest-side" ? Math.min : Math.max)(radiusOf(token, cx, width, 0) ?? 0, radiusOf(token, cy, height, 0) ?? 0)
                : radiusOf(token, 0, 0, Math.hypot(width, height) / Math.SQRT2);
            return [r, r];
          })()
        : [radiusOf(tokens[0] ?? "closest-side", cx, width, width), radiusOf(tokens[1] ?? "closest-side", cy, height, height)];
    return rx === null || ry === null ? null : { left: cx - rx, top: cy - ry, right: cx + rx, bottom: cy + ry };
  }
  return null;
};

// The clip-path's bounds on the page, or null when it doesn't clip.
const clipPathBox = (node: Element, style: CSSStyleDeclaration): Box | null => {
  if (style.clipPath === "" || style.clipPath === "none") {
    return null;
  }
  const edge = node.getBoundingClientRect();
  const bounds = shapeBounds(style.clipPath, edge.width, edge.height);
  return bounds === null
    ? null
    : { left: edge.left + bounds.left, top: edge.top + bounds.top, right: edge.left + bounds.right, bottom: edge.top + bounds.bottom };
};

const transparentColor = (token: string): boolean => {
  if (token === "transparent") {
    return true;
  }
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(token)?.[1];
  if (hex !== undefined) {
    return /^0+$/.test(hex.slice(hex.length === 4 ? 3 : 6));
  }
  const inner = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((.*)\)$/.exec(token)?.[1];
  if (inner === undefined) {
    return false;
  }
  const alpha = inner.includes("/") ? inner.split("/")[1] : splitTop(inner, ",")[3];
  return alpha !== undefined && Number.parseFloat(alpha) === 0;
};

const gradientWords =
  /^(to|at|from|in|left|right|top|bottom|center|circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner|srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|lab|oklab|xyz|xyz-d50|xyz-d65|hsl|hwb|lch|oklch|shorter|longer|increasing|decreasing|hue)$/;

// A gradient whose every colour is transparent: as a mask, it hides everything under it.
const transparentGradient = (layer: string): boolean => {
  const inner = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/.exec(layer)?.[1];
  if (inner === undefined) {
    return false;
  }
  const colours = splitTop(inner, ",")
    .flatMap((part) => splitTop(part, " "))
    .filter((token) => lengthOf(token) === null && !gradientWords.test(token) && !/^-?[\d.]+(deg|rad|grad|turn)$/.test(token));
  return colours.length > 0 && colours.every(transparentColor);
};

// A mask made only of transparent gradients (#142). Masks from images can't be read here and count as showing.
const masksAway = (style: CSSStyleDeclaration): boolean => {
  const layers = splitTop(style.maskImage || style.getPropertyValue("-webkit-mask-image"), ",").filter((layer) => layer !== "none");
  return layers.length > 0 && layers.every(transparentGradient);
};

// clip or mask that leaves nothing of the element to see: the screen-reader-only rect(0 0 0 0), a transparent
// mask (#142). Without layout (jsdom) a clip-path is also judged here, against a nominal box: with layout,
// outOfSight cuts the field's box by every clip-path above it instead.
const clipsAway = (node: Element, style: CSSStyleDeclaration): boolean => {
  const rect = /^rect\((.*)\)$/.exec(style.clip)?.[1]?.split(/[\s,]+/).map(Number.parseFloat) ?? [];
  const [top = NaN, right = NaN, bottom = NaN, left = NaN] = rect;
  if (rect.length === 4 && !rect.some(Number.isNaN) && (right - left < minSize || bottom - top < minSize)) {
    return true;
  }
  if (masksAway(style)) {
    return true;
  }
  if ("checkVisibility" in node || style.clipPath === "" || style.clipPath === "none") {
    return false;
  }
  const nominal = 1000;
  const bounds = shapeBounds(style.clipPath, nominal, nominal);
  return bounds !== null && !fits(cut({ left: 0, top: 0, right: nominal, bottom: nominal }, bounds));
};

const isUnclipped = (node: Element): boolean => {
  const style = styleOf(node);
  return style === undefined || !clipsAway(node, style);
};

const clips = (overflow: string): boolean => overflow === "hidden" || overflow === "clip";

// Whether layout puts the element where the user can't see it: not rendered, shrunk to a few pixels, cut off by
// an ancestor's overflow, or moved out of the page's scrollable area. Below the fold, or scrolled out of view in a
// scrolling panel, is still on the page. jsdom has no layout and no checkVisibility, so there only the style
// checks run.
const outOfSight = (element: Element): boolean => {
  if (!("checkVisibility" in element)) {
    return false;
  }
  if (!element.checkVisibility()) {
    return true;
  }
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const { left, top, right, bottom } = element.getBoundingClientRect();
  let box: Box = { left, top, right, bottom };
  // What clips an element is its containing block's chain: an absolute one skips static ancestors, a fixed one
  // all of them. <html> and <body> hand their overflow to the viewport, which scrolls.
  let skip: "none" | "static" | "all" = "none";
  let fixed = false;
  for (const node of ancestors(element)) {
    const style = styleOf(node);
    if (style === undefined) {
      continue;
    }
    // A clip-path clips every descendant, positioned or not (#142).
    const shape = clipPathBox(node, style);
    if (shape !== null) {
      box = cut(box, shape);
    }
    if (skip === "all" || (skip === "static" && style.position === "static")) {
      continue;
    }
    const [clipsX, clipsY] = [clips(style.overflowX), clips(style.overflowY)];
    if (node !== element && node !== doc.documentElement && node !== doc.body && (clipsX || clipsY)) {
      const edge = node.getBoundingClientRect();
      box = cut(box, {
        left: clipsX ? edge.left : -Infinity,
        right: clipsX ? edge.right : Infinity,
        top: clipsY ? edge.top : -Infinity,
        bottom: clipsY ? edge.bottom : Infinity,
      });
    }
    fixed ||= style.position === "fixed";
    skip = style.position === "fixed" ? "all" : style.position === "absolute" ? "static" : "none";
  }
  if (!fits(box)) {
    return true;
  }
  if (view === null) {
    return false;
  }
  // Fixed boxes stay where they are in the viewport; the rest move with the page's scroll.
  const x = fixed ? 0 : view.scrollX;
  const y = fixed ? 0 : view.scrollY;
  const root = doc.documentElement;
  const sideways = [root, doc.body].some((node) => node !== null && clips(styleOf(node)?.overflowX ?? ""));
  const width = fixed || sideways ? view.innerWidth : Math.max(root.scrollWidth, view.innerWidth);
  return box.right + x <= 0 || box.bottom + y <= 0 || box.left + x >= width;
};

// An element the user can see (#129). Pages hide fields with opacity, a 1px size, clipping or an off-screen
// position, none of which display, visibility or [hidden] catch, to get a fill the user never sees. `drawnBelow`
// may vouch for an element faded out, when something else draws it for the user.
const inSight = (element: Element, drawnBelow: (element: Element) => boolean = () => false): boolean =>
  (opacityOf(element) >= minOpacity || drawnBelow(element)) &&
  everyAncestor(element, isUnclipped, pass?.unclipped) &&
  !outOfSight(element);

// Where a hit test looks inside an element's box, as fractions of its width and height: the centre and a point
// toward each corner, all clear of the inline button at the right edge.
const probes: readonly Point[] = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.6, 0.25],
  [0.25, 0.75],
  [0.6, 0.75],
];

// The extension's own UI drawn on the page: inline buttons, their open pickers, the save bar. A hit test that
// lands on one says nothing about the page, so an open picker over the confirmation field doesn't hide it.
const ownHosts = new WeakSet<Element>();

export const markOwn = (host: Element): void => {
  ownHosts.add(host);
};

// Whether another element is drawn over the whole of this one (#147): an empty opaque box laid over a login's
// fields passes every style and size check, but the user can't see or click them. A hit test at any probe that
// reaches the element, or one of its own labels floating over it (that label, not something inside it), shows the user can; a sticky header or a cookie
// banner that covers part of it leaves some probe free. Probes outside the viewport or on the extension's own UI
// can't be tested, and without
// any (below the fold, or no hit testing in jsdom) nothing counts as covered.
const covered = (element: Element): boolean => {
  const own = [element, ...((element as HTMLInputElement).labels ?? [])];
  const results = probeHits(element);
  return results.length > 0 && !results.some((hit) => own.includes(hit));
};

// What a hit test finds at each probe inside the viewport, less the extension's own UI.
const probeHits = (element: Element): readonly Element[] => {
  const root = element.getRootNode() as Partial<DocumentOrShadowRoot>;
  const view = element.ownerDocument.defaultView;
  if (typeof root.elementFromPoint !== "function" || view === null) {
    return [];
  }
  const { left, top, width, height } = element.getBoundingClientRect();
  return probes
    .map(([x, y]): Point => [left + x * width, top + y * height])
    .filter(([x, y]) => x >= 0 && y >= 0 && x < view.innerWidth && y < view.innerHeight)
    .map(([x, y]) => root.elementFromPoint?.call(root, x, y) ?? null)
    .filter((hit): hit is Element => hit !== null && !ownHosts.has(hit));
};

const findCanvases = (scope: ParentNode): readonly HTMLCanvasElement[] =>
  [...scope.querySelectorAll("*")].flatMap((element) => [
    ...(element.localName === "canvas" ? [element as HTMLCanvasElement] : []),
    ...(element.shadowRoot === null ? [] : findCanvases(element.shadowRoot)),
  ]);

// The page's <canvas> elements, open shadow roots included, found once per pass.
const canvases = (doc: Document): readonly HTMLCanvasElement[] => {
  const found = pass?.canvases.get(doc) ?? findCanvases(doc);
  pass?.canvases.set(doc, found);
  return found;
};

// Whether a transparent field is typed into through a canvas that paints it (#159). Flutter web draws the whole
// app, fields included, into a <canvas>, and lays its semantics tree over it, made invisible as a whole with
// filter: opacity(0%): the <input> the user types into is transparent, but sits on the field the user sees. It
// counts as shown when every probe of a hit test lands on the field itself, so a click anywhere on it reaches
// it, and a canvas the user can see lies under the whole of it. A decoy faded out over the page has nothing
// painted under it, and one under something else that takes the clicks isn't where the user types. Without
// layout (jsdom) there is nothing to test against, and a faded field stays hidden.
const overCanvas = (field: Element): boolean => {
  if (!("checkVisibility" in field)) {
    return false;
  }
  const hits = probeHits(field);
  if (hits.length === 0 || hits.some((hit) => hit !== field)) {
    return false;
  }
  const box = field.getBoundingClientRect();
  return canvases(field.ownerDocument).some((canvas) => {
    const under = canvas.getBoundingClientRect();
    return (
      under.left <= box.left &&
      under.top <= box.top &&
      under.right >= box.right &&
      under.bottom >= box.bottom &&
      isVisible(canvas) &&
      inSight(canvas)
    );
  });
};

const walk = (scope: ParentNode): readonly HTMLInputElement[] =>
  [...scope.querySelectorAll("*")].flatMap((element) => [
    ...(element.localName === "input" ? [element as HTMLInputElement] : []),
    ...(element.shadowRoot === null ? [] : inputs(element.shadowRoot)),
  ]);

// Inputs in document order, including those inside open shadow roots (web-component login forms).
const inputs = (scope: ParentNode): readonly HTMLInputElement[] => {
  if (pass === null) {
    return walk(scope);
  }
  const found = pass.inputs.get(scope) ?? walk(scope);
  pass.inputs.set(scope, found);
  return found;
};

// The autofill field name from autocomplete: its last token, ignoring a trailing "webauthn".
const autofill = (input: HTMLInputElement): string =>
  (input.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== "" && token !== "webauthn")
    .at(-1) ?? "";

const autofillNames =
  /^(name|honorific-(prefix|suffix)|given-name|additional-name|family-name|nickname|username|new-password|current-password|one-time-code|organization(-title)?|street-address|address-line[1-3]|address-level[1-4]|country(-name)?|postal-code|cc-[a-z-]+|transaction-(currency|amount)|language|bday(-day|-month|-year)?|sex|url|photo|tel(-[a-z-]+)?|email|impp)$/;

// True when autocomplete names some field, so heuristics shouldn't second-guess it.
const hasAutofill = (input: HTMLInputElement): boolean => autofillNames.test(autofill(input));

// The innermost part of a framework name, so "user[first_name]" reads as "first_name".
const leafName = (name: string): string => /\[([^\]]*)\]$/.exec(name)?.[1] ?? name;

// Name, id, placeholder, aria-label and label text, with camelCase split so "totpPin" reads as "totp Pin".
const describes = (input: HTMLInputElement): string =>
  [
    leafName(input.name),
    input.id,
    input.placeholder,
    input.getAttribute("aria-label") ?? "",
    ...[...(input.labels ?? [])].map((label) => label.textContent ?? ""),
  ]
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");

const searchHint = /search|query|(^|[^a-z])q([^a-z]|$)/i;
// "user" alone counts, but not as the prefix of "user_first_name".
const loginHint = /(^|[^a-z])(user.?(name|id)|login(.?id)?|identifier)([^a-z]|$)|(^|[^a-z_-])user([^a-z_-]|$)/i;
const emailHint = /e.?mail/i;

const isSearch = (input: HTMLInputElement): boolean =>
  input.getAttribute("role") === "searchbox" ||
  input.closest('[role="search"]') !== null ||
  searchHint.test([input.name, input.id, input.placeholder, input.getAttribute("aria-label") ?? ""].join(" "));

// Spam honeypots: kept out of reach of keyboard and screen readers, but not display:none.
const isDecoy = (input: HTMLInputElement): boolean =>
  input.tabIndex < 0 || !everyAncestor(input, (node) => node.getAttribute("aria-hidden") !== "true", pass?.exposed);

const newsletterHint = /newsletter|subscri/i;

const isNewsletter = (input: HTMLInputElement): boolean =>
  newsletterHint.test(
    [input.name, input.id, input.placeholder, input.form?.id, input.form?.className, input.form?.getAttribute("action")].join(" "),
  );

// Whether a frame element is shown in its page: the field rules, less the honeypot marks (#141).
export const frameShown = (frame: Element): boolean =>
  isVisible(frame as HTMLElement) && inSight(frame) && !covered(frame) && documentShown(frame.ownerDocument);

// Whether a document is drawn where the user can see it: the top page, or a frame whose <iframe> is shown, up
// through every same-origin parent. A cross-origin parent hides frameElement; the worker asks that parent
// instead before it hands a subframe a login (src/background/frames.ts).
const documentShown = (doc: Document): boolean => {
  const known = pass?.frames.get(doc);
  if (known !== undefined) {
    return known;
  }
  let frame: Element | null = null;
  try {
    frame = doc.defaultView?.frameElement ?? null;
  } catch {
    // Cross-origin: the worker's probe covers it.
  }
  const shown = frame === null || frameShown(frame);
  pass?.frames.set(doc, shown);
  return shown;
};

// Whether a login field is under another element, answered once per pass: a hit test costs a layout.
const isCovered = perPass(covered);

const isOverCanvas = perPass(overCanvas);

// A field login fill may put a username or password in: shown, reachable, in sight, not buried under another
// element, still on the page, and in a frame that is itself shown.
export const isLoginField = (input: HTMLInputElement): boolean =>
  input.isConnected &&
  isVisible(input) &&
  !isDecoy(input) &&
  inSight(input, (field) => isOverCanvas(field as HTMLInputElement)) &&
  !isCovered(input) &&
  documentShown(input.ownerDocument);

const isPassword = (input: HTMLInputElement): boolean => input.type === "password" && isLoginField(input);

export const passwordFields = (doc: Document): readonly HTMLInputElement[] => inputs(doc).filter(isPassword);

// Whether every step from the field to the page could be read: false when the field is light DOM under a host
// whose closed shadow root the browser won't let this script open, so its slot's wrappers are unknown.
const flatTreeKnown = (field: Element): boolean =>
  ancestors(field).every((node) => slotting(node, node.parentElement).known);

// The closed-shadow policy (#139): a fill with no target the user chose (the popup's Fill, the shortcut, the
// context menu) takes a field whose flat tree can't be read only if a hit test at its centre finds it. Without
// layout (jsdom) there is nothing to test against.
const provablyShown = (field: HTMLInputElement): boolean => {
  if (flatTreeKnown(field) || !("checkVisibility" in field)) {
    return true;
  }
  const { left, top, width, height } = field.getBoundingClientRect();
  const root = field.getRootNode() as Partial<DocumentOrShadowRoot>;
  return root.elementFromPoint?.(left + width / 2, top + height / 2) === field;
};

const isUsernameCandidate = perPass(
  (input) =>
    usernameTypes.has(input.type) &&
    (!hasAutofill(input) || /^(username|email|nickname|tel.*)$/.test(autofill(input))) &&
    !isSearch(input) &&
    !isNewsletter(input) &&
    isLoginField(input),
);

// autocomplete outranks names: "username", then "email", then a name like "login", then any email field.
const usernameRank = (input: HTMLInputElement): number => {
  const field = autofill(input);
  if (field === "username") {
    return 4;
  }
  if (field === "email") {
    return 3;
  }
  if (hasAutofill(input)) {
    return 0;
  }
  if (loginHint.test(describes(input))) {
    return 2;
  }
  return input.type === "email" || emailHint.test(describes(input)) ? 1 : 0;
};

// For fields outside any <form>: keep the others sharing the closest container with `field`,
// so a page with sign-up and login panels side by side doesn't mix their fields.
const nearestGroup = (field: HTMLInputElement, others: readonly HTMLInputElement[]): readonly HTMLInputElement[] => {
  // How far up from `field` each node meets its ancestors; nodes off that line inherit from the first ancestor on it.
  const level = new Map<Element, number>(ancestors(field).map((node, index) => [node, index]));
  const meet = (other: Element): number | undefined => {
    const path: Element[] = [];
    let found: number | undefined;
    for (let node: Element | null = other; node !== null && found === undefined; node = parentOf(node)) {
      found = level.get(node);
      if (found === undefined) {
        path.push(node);
      }
    }
    path.forEach((node) => level.set(node, found ?? Infinity));
    return found === Infinity ? undefined : found;
  };
  const meets = others.map((other) => (other === field ? 0 : meet(other)));
  const shared = others
    .map((other, index) => (other === field ? undefined : meets[index]))
    .filter((found): found is number => found !== undefined)
    .map((found) => Math.max(1, found));
  if (shared.length === 0) {
    return others;
  }
  const holder = shared.reduce((low, found) => Math.min(low, found));
  return others.filter((_, index) => (meets[index] ?? Infinity) <= holder);
};

const fieldsBefore = (field: HTMLInputElement): readonly HTMLInputElement[] => {
  const page = inputs(field.ownerDocument);
  const all = page.includes(field) ? page : inputs(field.getRootNode() as ParentNode);
  return all.slice(0, Math.max(0, all.indexOf(field)));
};

export const usernameFieldFor = (password: HTMLInputElement): HTMLInputElement | null => {
  const before = fieldsBefore(password).filter((input) => input.form === password.form && isUsernameCandidate(input));
  const candidates = password.form === null ? nearestGroup(password, before) : before;
  const best = Math.max(0, ...candidates.map(usernameRank));
  return candidates.findLast((input) => usernameRank(input) === best) ?? null;
};

export const standaloneUsernameField = (doc: Document): HTMLInputElement | null => {
  const candidates = inputs(doc).filter((input) => isUsernameCandidate(input) && usernameRank(input) > 0);
  const best = Math.max(0, ...candidates.map(usernameRank));
  return candidates.find((input) => usernameRank(input) === best) ?? null;
};

// The identifier field on the first step of a two-step login: a page with a username or email field but no
// password or one-time code field yet. Null on single-step forms, which the password field covers.
export const identifierField = (doc: Document): HTMLInputElement | null => {
  if (passwordFields(doc).length > 0 || otpFields(doc).length > 0) {
    return null;
  }
  const field = standaloneUsernameField(doc);
  return field === null || field.readOnly ? null : field;
};

export const setValue = (input: HTMLInputElement, value: string): void => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value");
  input.focus();
  if (descriptor?.set === undefined) {
    input.value = value;
  } else {
    descriptor.set.call(input, value);
  }
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
};

export type FillOutcome = Readonly<{ filled: boolean; form: HTMLFormElement | null }>;

export const fillLogin = (
  doc: Document,
  credentials: Credentials,
  target: HTMLInputElement | null = null,
): FillOutcome => {
  // The page may have hidden the field since it was chosen: the picker stays open while the user decides.
  if (target !== null && !isLoginField(target)) {
    return { filled: false, form: null };
  }
  // A username target fills its password too once the page shows one; on the identifier step it fills alone.
  const paired =
    target === null || target.type === "password"
      ? target
      : passwordFields(doc).find((password) => usernameFieldFor(password) === target);
  if (target !== null && paired === undefined) {
    if (credentials.username === "") {
      return { filled: false, form: null };
    }
    setValue(target, credentials.username);
    return { filled: true, form: target.form };
  }
  const password = paired ?? passwordFields(doc).find(provablyShown) ?? null;
  if (password === null) {
    const username = standaloneUsernameField(doc);
    if (username === null || credentials.username === "" || !provablyShown(username)) {
      return { filled: false, form: null };
    }
    setValue(username, credentials.username);
    return { filled: true, form: username.form };
  }
  const username = usernameFieldFor(password);
  if (username !== null && !username.readOnly && credentials.username !== "" && (target !== null || provablyShown(username))) {
    setValue(username, credentials.username);
  }
  setValue(password, credentials.password);
  return { filled: true, form: password.form };
};

// Where submitting sends the form: the button's formaction, else the form's action, else the page itself. Read
// as attributes, because a field named "action" shadows form.action.
const destination = (form: HTMLFormElement, button: HTMLElement | null): string => {
  const doc = form.ownerDocument;
  const action = button?.getAttribute("formaction") ?? form.getAttribute("action") ?? "";
  try {
    return action === "" ? doc.URL : new URL(action, doc.baseURI).href;
  } catch {
    return "";
  }
};

// Submit after filling. A form that would send the login to another site is left for the user to submit (#130):
// markup injected into the login's own page, with no script at all, could point it anywhere.
export const submit = (form: HTMLFormElement | null): void => {
  if (form === null) {
    return;
  }
  const button = form.querySelector<HTMLElement>('button[type="submit"], input[type="submit"], button:not([type])');
  if (!sameSiteAction(destination(form, button), form.ownerDocument.URL)) {
    return;
  }
  if (button !== null) {
    button.click();
  } else {
    form.requestSubmit();
  }
};

const otpTypes = new Set(["text", "tel", "number", ""]);
const otpHint = /(^|[^a-z])(otp|totp|2fa|mfa)([^a-z]|$)|one.?time|verification.?code|auth(entication)?.?code|security.?code|two.?factor/i;

const cardHint = /cvc|cvv|csc|card/i;

const isDigitBox = (input: HTMLInputElement): boolean => input.maxLength === 1 && otpTypes.has(input.type);

const digitBoxesFrom = (first: HTMLInputElement): readonly HTMLInputElement[] => {
  const scope: ParentNode = first.form ?? first.parentElement?.parentElement ?? first.ownerDocument;
  const boxes = inputs(scope).filter((input) => isDigitBox(input) && isVisible(input));
  return boxes.slice(boxes.indexOf(first));
};

// autocomplete decides when present; names and digit boxes only count on fields it leaves unnamed.
export const isOtpField = (input: HTMLInputElement): boolean =>
  otpTypes.has(input.type) &&
  isVisible(input) &&
  (autofill(input) === "one-time-code" ||
    (!hasAutofill(input) &&
      ((otpHint.test(describes(input)) && !cardHint.test(describes(input))) ||
        (isDigitBox(input) && digitBoxesFrom(input).length >= 4))));

export const otpFields = (doc: Document): readonly HTMLInputElement[] => {
  const found = inputs(doc).filter(isOtpField);
  return found.filter((input, index) => !(isDigitBox(input) && found.slice(0, index).some(isDigitBox)));
};

export const fillOtp = (field: HTMLInputElement, code: string): void => {
  if (!isDigitBox(field)) {
    setValue(field, code);
    return;
  }
  digitBoxesFrom(field)
    .slice(0, code.length)
    .forEach((box, index) => setValue(box, code[index] ?? ""));
};

const passwordGroup = (field: HTMLInputElement): readonly HTMLInputElement[] => {
  const fields = inputs(field.form ?? field.ownerDocument).filter((input) => input.form === field.form);
  if (field.form !== null) {
    return fields.filter(isPassword);
  }
  return nearestGroup(field, fields.filter((input) => isPassword(input) || isUsernameCandidate(input))).filter(isPassword);
};

const currentHint = /(^|[^a-z])(current|old|existing)([^a-z]|$)/i;

const isCurrentPassword = (input: HTMLInputElement): boolean =>
  autofill(input) === "current-password" || (autofill(input) !== "new-password" && currentHint.test(describes(input)));

export const newPasswordGroup = (field: HTMLInputElement): readonly HTMLInputElement[] => {
  const group = passwordGroup(field);
  const marked = group.findIndex((input) => autofill(input) === "new-password");
  if (marked >= 0) {
    // A marked password plus the unmarked confirmation after it.
    return group.slice(marked).filter((input) => !isCurrentPassword(input));
  }
  if (group.some(isCurrentPassword)) {
    return group.filter((input) => !isCurrentPassword(input));
  }
  if (group.length === 2) {
    return group;
  }
  return group.length === 3 ? group.slice(1) : [];
};

export const isNewPasswordField = (field: HTMLInputElement): boolean => newPasswordGroup(field).includes(field);

export const fieldRules = (field: HTMLInputElement): FieldRules => ({
  maxLength: field.maxLength,
  minLength: field.minLength,
  pattern: field.pattern,
});

export const fillNewPassword = (field: HTMLInputElement, password: string): void =>
  newPasswordGroup(field).forEach((input) => setValue(input, password));

const filled = (fields: readonly HTMLInputElement[]): readonly HTMLInputElement[] =>
  fields.filter((field) => field.value !== "");

// The second step of a two-step login often keeps the identifier in a hidden autocomplete="username" field.
const rememberedUsername = (scope: ParentNode): string =>
  inputs(scope)
    .find((input) => autofill(input) === "username" && input.value.trim() !== "")
    ?.value.trim() ?? "";

export const capturedLogin = (doc: Document, form: HTMLFormElement | null): Credentials | null => {
  if (form !== null && !form.checkValidity()) {
    return null;
  }
  const scope: ParentNode = form ?? doc;
  const fields = filled(inputs(scope).filter(isPassword));
  const first = fields[0];
  if (first === undefined) {
    return null;
  }
  const fresh = filled(newPasswordGroup(first).length > 0 ? newPasswordGroup(first) : fields.filter(isNewPasswordField));
  if (new Set(fresh.map((field) => field.value)).size > 1) {
    return null;
  }
  const password = fresh[0]?.value ?? first.value;
  const username = usernameFieldFor(first)?.value.trim() ?? standaloneUsernameField(doc)?.value.trim() ?? "";
  return { username: username === "" ? rememberedUsername(scope) : username, password };
};

export const looksLikeSubmit = (element: Element): boolean => {
  const button = element.closest<HTMLElement>('button, input[type="submit"], input[type="button"], [role="button"]');
  if (button === null) {
    return false;
  }
  if (button instanceof HTMLInputElement) {
    return button.type === "submit" || /log ?in|sign ?in|continue|next|submit/i.test(button.value);
  }
  if (button instanceof HTMLButtonElement && button.type === "submit" && button.form !== null) {
    return true;
  }
  return /log ?in|sign ?in|sign ?up|register|create account|continue|next|submit|save/i.test(button.textContent ?? "");
};
