import type { Credentials } from "../shared/types";

const usernameTypes = new Set(["text", "email", "tel", ""]);

const ancestors = (element: Element): readonly Element[] =>
  element.parentElement === null ? [element] : [element, ...ancestors(element.parentElement)];

export const isVisible = (element: HTMLElement): boolean => {
  const view = element.ownerDocument.defaultView;
  return (
    !(element as HTMLInputElement).disabled &&
    element.closest("[hidden]") === null &&
    ancestors(element).every((node) => {
      const style = view?.getComputedStyle(node);
      return style === undefined || (style.display !== "none" && style.visibility !== "hidden");
    })
  );
};

const inputs = (scope: ParentNode): readonly HTMLInputElement[] => [...scope.querySelectorAll("input")];

export const passwordFields = (doc: Document): readonly HTMLInputElement[] =>
  inputs(doc).filter((input) => input.type === "password" && isVisible(input));

const precedes = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

const looksLikeUsername = (input: HTMLInputElement): boolean =>
  /username|email/i.test(input.autocomplete) || input.type === "email";

export const usernameFieldFor = (password: HTMLInputElement): HTMLInputElement | null => {
  const scope: ParentNode = password.form ?? password.ownerDocument;
  const candidates = inputs(scope).filter(
    (input) => usernameTypes.has(input.type) && isVisible(input) && precedes(input, password),
  );
  return candidates.find(looksLikeUsername) ?? candidates.at(-1) ?? null;
};

export const standaloneUsernameField = (doc: Document): HTMLInputElement | null =>
  inputs(doc).find((input) => usernameTypes.has(input.type) && looksLikeUsername(input) && isVisible(input)) ?? null;

export const setValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set;
  input.focus();
  if (setter === undefined) {
    input.value = value;
  } else {
    setter.call(input, value);
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
  if (username !== null && credentials.username !== "") {
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
