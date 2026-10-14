import { sameSiteAction } from "../shared/hostMatch";
import type { Credentials } from "../shared/types";

const usernameTypes = new Set(["text", "email", "tel", ""]);

// The parent in the composed tree, so checks walk out of an open shadow root into its host.
const parentOf = (element: Element): Element | null =>
  element.parentElement ?? (element.getRootNode() as Partial<ShadowRoot>).host ?? null;

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
  checks: Map<object, Map<HTMLInputElement, boolean>>;
}>;
let pass: Pass | null = null;

// Runs `detect` as one pass over the page. It must not change the page.
export const onePass = <T>(detect: () => T): T => {
  if (pass !== null) {
    return detect();
  }
  pass = { inputs: new Map(), styles: new Map(), opacity: new Map(), shown: new Map(), unclipped: new Map(), exposed: new Map(), checks: new Map() };
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
  return !node.hasAttribute("hidden") && (style === undefined || (style.display !== "none" && style.visibility !== "hidden"));
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

// The opacity the element is drawn with: its own times every ancestor's.
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
    const own = Number.parseFloat(styleOf(node)?.opacity ?? "");
    product *= Number.isNaN(own) ? 1 : own;
    known?.set(node, product);
  }
  return product;
};

// clip or clip-path that leaves nothing of the element to see: the screen-reader-only rect(0 0 0 0), inset(50%),
// a circle of radius 0.
const clipsAway = (style: CSSStyleDeclaration): boolean => {
  const rect = /^rect\((.*)\)$/.exec(style.clip)?.[1]?.split(/[\s,]+/).map(Number.parseFloat) ?? [];
  const [top = NaN, right = NaN, bottom = NaN, left = NaN] = rect;
  if (rect.length === 4 && !rect.some(Number.isNaN) && (right - left < minSize || bottom - top < minSize)) {
    return true;
  }
  const inset = Number.parseFloat(/^inset\(\s*([\d.]+)%/.exec(style.clipPath)?.[1] ?? "");
  return inset >= 50 || /^(circle|ellipse)\(\s*0(px|%)?[\s)]/.test(style.clipPath);
};

const isUnclipped = (node: Element): boolean => {
  const style = styleOf(node);
  return style === undefined || !clipsAway(style);
};

const clips = (overflow: string): boolean => overflow === "hidden" || overflow === "clip";

type Box = { left: number; top: number; right: number; bottom: number };

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
  const box: Box = { left, top, right, bottom };
  // What clips an element is its containing block's chain: an absolute one skips static ancestors, a fixed one
  // all of them. <html> and <body> hand their overflow to the viewport, which scrolls.
  let skip: "none" | "static" | "all" = "none";
  let fixed = false;
  for (const node of ancestors(element)) {
    const style = styleOf(node);
    if (style === undefined) {
      continue;
    }
    if (skip === "all" || (skip === "static" && style.position === "static")) {
      continue;
    }
    const [clipsX, clipsY] = [clips(style.overflowX), clips(style.overflowY)];
    if (node !== element && node !== doc.documentElement && node !== doc.body && (clipsX || clipsY)) {
      const edge = node.getBoundingClientRect();
      if (clipsX) {
        box.left = Math.max(box.left, edge.left);
        box.right = Math.min(box.right, edge.right);
      }
      if (clipsY) {
        box.top = Math.max(box.top, edge.top);
        box.bottom = Math.min(box.bottom, edge.bottom);
      }
    }
    fixed ||= style.position === "fixed";
    skip = style.position === "fixed" ? "all" : style.position === "absolute" ? "static" : "none";
  }
  if (box.right - box.left < minSize || box.bottom - box.top < minSize) {
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

// A login field the user can see (#129). Pages hide fields with opacity, a 1px size, clipping or an off-screen
// position, none of which display, visibility or [hidden] catch, to get a fill the user never sees.
const inSight = (element: Element): boolean =>
  opacityOf(element) >= minOpacity && everyAncestor(element, isUnclipped, pass?.unclipped) && !outOfSight(element);

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

// A field login fill may put a username or password in: shown, reachable, in sight, and still on the page.
export const isLoginField = (input: HTMLInputElement): boolean =>
  input.isConnected && isVisible(input) && !isDecoy(input) && inSight(input);

const isPassword = (input: HTMLInputElement): boolean => input.type === "password" && isLoginField(input);

export const passwordFields = (doc: Document): readonly HTMLInputElement[] => inputs(doc).filter(isPassword);

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
  const password = paired ?? passwordFields(doc)[0] ?? null;
  if (password === null) {
    const username = standaloneUsernameField(doc);
    if (username === null || credentials.username === "") {
      return { filled: false, form: null };
    }
    setValue(username, credentials.username);
    return { filled: true, form: username.form };
  }
  const username = usernameFieldFor(password);
  if (username !== null && !username.readOnly && credentials.username !== "") {
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

export const generatedLength = (field: HTMLInputElement): number =>
  field.maxLength > 0 ? Math.max(12, Math.min(20, field.maxLength)) : 20;

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
