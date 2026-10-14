// The popup and options page re-render by replacing their whole tree, which would drop keyboard focus
// to <body> after every click. These helpers find the replacement of whatever had focus and focus it.

const focusable = "button, input, select, textarea, a[href], [tabindex]";

// Controls are rebuilt from the same model, so an id, or else the tag, label and text, names one again.
const keyOf = (element: Element): string =>
  element.id === "" ? `${element.tagName}|${element.getAttribute("aria-label") ?? ""}|${element.textContent ?? ""}` : `#${element.id}`;

const usable = (element: HTMLElement): boolean => !(element as HTMLButtonElement).disabled && !element.closest("[hidden]");

const caretOf = (element: Element): readonly [number, number] | null =>
  element instanceof HTMLInputElement && element.selectionStart !== null && element.selectionEnd !== null
    ? [element.selectionStart, element.selectionEnd]
    : null;

const focusSection = (section: HTMLElement): void => {
  section.tabIndex = -1;
  section.focus();
};

// Replaces the container's children and puts focus back on the matching control, or, when that control
// is gone, on the rebuilt section (by id) that held it. "kept" when focus landed, "lost" when it was
// inside but has nowhere to go, and "none" when it wasn't inside, so the caller can choose where it goes.
export const replaceKeepingFocus = (container: HTMLElement, ...nodes: readonly Node[]): "kept" | "lost" | "none" => {
  const active = container.ownerDocument.activeElement;
  if (active === null || active === container || !container.contains(active)) {
    container.replaceChildren(...nodes);
    return "none";
  }
  const key = keyOf(active);
  const caret = caretOf(active);
  const section = active.closest("section[id]");
  const sectionId = section !== null && container.contains(section) && section !== container ? section.id : null;
  container.replaceChildren(...nodes);
  const match = [...container.querySelectorAll<HTMLElement>(focusable)].find((element) => keyOf(element) === key && usable(element));
  if (match !== undefined) {
    match.focus();
    if (caret !== null && match instanceof HTMLInputElement && match.selectionStart !== null) {
      match.setSelectionRange(...caret);
    }
    return "kept";
  }
  const holder = section === container ? container : sectionId === null ? null : container.querySelector<HTMLElement>(`section#${CSS.escape(sectionId)}`);
  if (holder === null) {
    return "lost";
  }
  focusSection(holder);
  return "kept";
};

// Where focus goes when the control that had it is gone: the view's chosen field, or else its heading,
// so a screen reader announces the new screen instead of falling silent on <body>.
export const focusFallback = (container: HTMLElement): void => {
  const target = container.querySelector<HTMLElement>("[data-autofocus]") ?? container.querySelector<HTMLElement>("h1");
  if (target === null) {
    return;
  }
  if (target.tagName === "H1") {
    target.tabIndex = -1;
  }
  target.focus();
};
