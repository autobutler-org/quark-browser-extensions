import type { Credentials } from "../shared/types";

const usernameTypes = new Set(["text", "email", "tel", ""]);

// The parent in the composed tree, so checks walk out of an open shadow root into its host.
const parentOf = (element: Element): Element | null =>
  element.parentElement ?? (element.getRootNode() as Partial<ShadowRoot>).host ?? null;

const ancestors = (element: Element): readonly Element[] => {
  const parent = parentOf(element);
  return parent === null ? [element] : [element, ...ancestors(parent)];
};

export const isVisible = (element: HTMLElement): boolean => {
  const view = element.ownerDocument.defaultView;
  return (
    !(element as HTMLInputElement).disabled &&
    ancestors(element).every((node) => {
      const style = view?.getComputedStyle(node);
      return !node.hasAttribute("hidden") && (style === undefined || (style.display !== "none" && style.visibility !== "hidden"));
    })
  );
};

// Inputs in document order, including those inside open shadow roots (web-component login forms).
const inputs = (scope: ParentNode): readonly HTMLInputElement[] =>
  [...scope.querySelectorAll("*")].flatMap((element) => [
    ...(element.localName === "input" ? [element as HTMLInputElement] : []),
    ...(element.shadowRoot === null ? [] : inputs(element.shadowRoot)),
  ]);

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
  input.tabIndex < 0 || ancestors(input).some((node) => node.getAttribute("aria-hidden") === "true");

const newsletterHint = /newsletter|subscri/i;

const isNewsletter = (input: HTMLInputElement): boolean =>
  newsletterHint.test(
    [input.name, input.id, input.placeholder, input.form?.id, input.form?.className, input.form?.getAttribute("action")].join(" "),
  );

export const passwordFields = (doc: Document): readonly HTMLInputElement[] =>
  inputs(doc).filter((input) => input.type === "password" && isVisible(input) && !isDecoy(input));

const isUsernameCandidate = (input: HTMLInputElement): boolean =>
  usernameTypes.has(input.type) &&
  (!hasAutofill(input) || /^(username|email|nickname|tel.*)$/.test(autofill(input))) &&
  isVisible(input) &&
  !isDecoy(input) &&
  !isSearch(input) &&
  !isNewsletter(input);

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
  const rest = others.filter((other) => other !== field);
  const holder = ancestors(field)
    .slice(1)
    .find((node) => rest.some((other) => ancestors(other).includes(node)));
  return holder === undefined ? others : others.filter((other) => ancestors(other).includes(holder));
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
  const password = target ?? passwordFields(doc)[0] ?? null;
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

export const submit = (form: HTMLFormElement | null): void => {
  if (form === null) {
    return;
  }
  const button = form.querySelector<HTMLElement>('button[type="submit"], input[type="submit"], button:not([type])');
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

const isPassword = (input: HTMLInputElement): boolean => input.type === "password" && isVisible(input) && !isDecoy(input);

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
