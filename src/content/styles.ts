export const adoptStyles = (shadow: ShadowRoot, css: string): void => {
  const view = shadow.ownerDocument.defaultView;
  try {
    if (view === null) {
      throw new Error("no window");
    }
    const sheet = new view.CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = shadow.ownerDocument.createElement("style");
    style.textContent = css;
    shadow.append(style);
  }
};
