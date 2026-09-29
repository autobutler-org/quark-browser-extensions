type Attrs = Readonly<Record<string, string | number | boolean | EventListener | undefined>>;
type Child = Node | string | null | undefined | false;

const applyAttr = (element: HTMLElement, key: string, value: Attrs[string]): void => {
  if (value === undefined || value === false) {
    return;
  }
  if (typeof value === "function") {
    element.addEventListener(key.replace(/^on/, "").toLowerCase(), value);
    return;
  }
  if (key === "className") {
    element.className = String(value);
    return;
  }
  if (key in element && typeof value !== "string") {
    (element as unknown as Record<string, unknown>)[key] = value;
    return;
  }
  element.setAttribute(key, value === true ? "" : String(value));
};

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] => h$(document, tag, attrs, ...children);

export const h$ = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] => {
  const element = doc.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => applyAttr(element, key, value));
  children
    .filter((child): child is Node | string => child !== null && child !== undefined && child !== false)
    .forEach((child) => element.append(typeof child === "string" ? doc.createTextNode(child) : child));
  return element;
};

const svgNs = "http://www.w3.org/2000/svg";

export const icon = (doc: Document, paths: readonly string[], size = 16): SVGSVGElement => {
  const svg = doc.createElementNS(svgNs, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  paths.forEach((d) => {
    const path = doc.createElementNS(svgNs, "path");
    path.setAttribute("d", d);
    svg.append(path);
  });
  return svg;
};

export const icons = {
  quark: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"],
  lock: ["M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z", "M8 11V7a4 4 0 0 1 8 0v4"],
  key: ["M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M10.8 12.2 21 2", "m18 5 3 3", "m15 8 3 3"],
  copy: ["M11 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "m20 20-3.5-3.5"],
  settings: ["M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M12 2v3", "M12 19v3", "M4.9 4.9l2.1 2.1", "M17 17l2.1 2.1", "M2 12h3", "M19 12h3", "M4.9 19.1 7 17", "M17 7l2.1-2.1"],
} as const;
