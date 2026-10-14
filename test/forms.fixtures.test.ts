import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capturedLogin,
  fillLogin,
  fillNewPassword,
  fillOtp,
  identifierField,
  isNewPasswordField,
  otpFields,
  passwordFields,
  standaloneUsernameField,
  usernameFieldFor,
} from "../src/content/forms";

// Each fixture under test/fixtures/forms tags its fields with data-fx; see the README there.
const fixtures = join(import.meta.dirname, "fixtures", "forms");

// jsdom doesn't parse declarative shadow DOM, so attach <template shadowrootmode> roots by hand.
const attachShadowRoots = (scope: ParentNode): void =>
  scope.querySelectorAll<HTMLTemplateElement>("template[shadowrootmode]").forEach((template) => {
    const host = template.parentElement as HTMLElement;
    const shadow = host.attachShadow({ mode: template.getAttribute("shadowrootmode") === "closed" ? "closed" : "open" });
    shadow.append(template.content);
    template.remove();
    attachShadowRoots(shadow);
  });

// jsdom has no layout, so give it a rough one from inline styles: every element starts at the page's top left,
// is moved by its own and its positioned ancestors' left and top, and takes its own width and height, else
// 200×30 for an input and 800×600 for anything else. Enough to tell a field moved off-screen or shrunk to 1px.
const px = (value: string): number | null => (/^-?[\d.]+px$/.test(value) ? Number.parseFloat(value) : null);

const parentOf = (element: Element): Element | null =>
  element.parentElement ?? (element.getRootNode() as Partial<ShadowRoot>).host ?? null;

const roughBox = (element: Element): DOMRect => {
  let left = 8;
  let top = 8;
  for (let node: Element | null = element; node !== null; node = parentOf(node)) {
    const { position, left: x, top: y } = (node as HTMLElement).style ?? {};
    if (position === "absolute" || position === "fixed") {
      left += px(x ?? "") ?? 0;
      top += px(y ?? "") ?? 0;
    }
  }
  const style = (element as HTMLElement).style as CSSStyleDeclaration | undefined;
  const input = element.localName === "input";
  const width = px(style?.width ?? "") ?? (input ? 200 : 800);
  const height = px(style?.height ?? "") ?? (input ? 30 : 600);
  return DOMRect.fromRect({ x: left, y: top, width, height });
};

beforeEach(() => {
  Object.defineProperty(Element.prototype, "checkVisibility", { value: () => true, configurable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return roughBox(this);
  });
});

afterEach(() => {
  delete (Element.prototype as Partial<Element>).checkVisibility;
  vi.restoreAllMocks();
});

const load = (name: string): Document => {
  document.body.innerHTML = readFileSync(join(fixtures, name), "utf8");
  attachShadowRoots(document.body);
  return document;
};

const allElements = (scope: ParentNode): readonly Element[] =>
  [...scope.querySelectorAll("*")].flatMap((element) => [
    element,
    ...(element.shadowRoot === null ? [] : allElements(element.shadowRoot)),
  ]);

const tag = (field: Element | null): string | null => (field === null ? null : (field as HTMLElement).dataset.fx ?? "?");

const field = (name: string): HTMLInputElement => {
  const found = allElements(document).find((element) => tag(element) === name);
  if (found === undefined) {
    throw new Error(`no field tagged ${name}`);
  }
  return found as HTMLInputElement;
};

const tags = (fields: readonly Element[]): readonly (string | null)[] => fields.map(tag);

type Expected = Readonly<{
  passwords: readonly string[];
  // usernameFieldFor, for each password field
  usernames: Readonly<Record<string, string | null>>;
  // standaloneUsernameField, the two-step fallback when there's no password field
  standalone: string | null;
  otp: readonly string[];
  // passwords that isNewPasswordField accepts
  newPasswords: readonly string[];
}>;

const corpus: Readonly<Record<string, Expected>> = {
  "login-basic.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-unmarked.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-domain.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-honeypot.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: null, otp: [], newPasswords: [] },
  "login-decoy-offscreen.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-decoy-opacity.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-decoy-tiny.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-floating-labels.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-visually-hidden-labels.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-webauthn.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "login-and-signup-forms.html": {
    passwords: ["login-pw", "signup-pw", "signup-confirm"],
    usernames: { "login-pw": "login-email", "signup-pw": "signup-email", "signup-confirm": "signup-email" },
    standalone: "login-email",
    otp: [],
    newPasswords: ["signup-pw", "signup-confirm"],
  },
  "spa-formless-login.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "spa-formless-panels.html": {
    passwords: ["signup-pw", "signup-confirm", "login-pw"],
    usernames: { "signup-pw": "signup-email", "signup-confirm": "signup-email", "login-pw": "login-user" },
    standalone: "login-user",
    otp: [],
    newPasswords: ["signup-pw", "signup-confirm"],
  },
  "shadow-dom-form.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "shadow-dom-inputs.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "two-step-identifier.html": { passwords: [], usernames: {}, standalone: "user", otp: [], newPasswords: [] },
  "two-step-identifier-unmarked.html": { passwords: [], usernames: {}, standalone: "user", otp: [], newPasswords: [] },
  "two-step-identifier-formless.html": { passwords: [], usernames: {}, standalone: "user", otp: [], newPasswords: [] },
  "two-step-identifier-hidden-password.html": { passwords: [], usernames: {}, standalone: "user", otp: [], newPasswords: [] },
  "two-step-password-hidden-username.html": { passwords: ["pw"], usernames: { pw: null }, standalone: null, otp: [], newPasswords: [] },
  "two-step-password-visually-hidden-username.html": { passwords: ["pw"], usernames: { pw: null }, standalone: null, otp: [], newPasswords: [] },
  "two-step-password-readonly.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: [] },
  "two-step-password-formless.html": { passwords: ["pw"], usernames: { pw: null }, standalone: null, otp: [], newPasswords: [] },
  "signup-marked.html": {
    passwords: ["pw", "confirm"],
    usernames: { pw: "user", confirm: "user" },
    standalone: "user",
    otp: [],
    newPasswords: ["pw", "confirm"],
  },
  "signup-single-password.html": { passwords: ["pw"], usernames: { pw: "user" }, standalone: "user", otp: [], newPasswords: ["pw"] },
  "signup-unmarked.html": {
    passwords: ["pw1", "pw2"],
    usernames: { pw1: "user", pw2: "user" },
    standalone: "user",
    otp: [],
    newPasswords: ["pw1", "pw2"],
  },
  "signup-rails-names.html": { passwords: ["pw"], usernames: { pw: "email" }, standalone: "email", otp: [], newPasswords: [] },
  "change-password-marked.html": {
    passwords: ["current", "new", "confirm"],
    usernames: { current: null, new: null, confirm: null },
    standalone: null,
    otp: [],
    newPasswords: ["new", "confirm"],
  },
  "change-password-current-last.html": {
    passwords: ["new", "confirm", "current"],
    usernames: { new: "email", confirm: "email", current: "email" },
    standalone: "email",
    otp: [],
    newPasswords: ["new", "confirm"],
  },
  "change-password-unmarked.html": {
    passwords: ["current", "new", "confirm"],
    usernames: { current: null, new: null, confirm: null },
    standalone: null,
    otp: [],
    newPasswords: ["new", "confirm"],
  },
  "change-password-positional.html": {
    passwords: ["current", "new", "confirm"],
    usernames: { current: null, new: null, confirm: null },
    standalone: null,
    otp: [],
    newPasswords: ["new", "confirm"],
  },
  "otp-autocomplete.html": { passwords: [], usernames: {}, standalone: null, otp: ["code"], newPasswords: [] },
  "otp-camelcase.html": { passwords: [], usernames: {}, standalone: null, otp: ["code"], newPasswords: [] },
  "otp-label-only.html": { passwords: [], usernames: {}, standalone: null, otp: ["code"], newPasswords: [] },
  "otp-digit-boxes.html": { passwords: [], usernames: {}, standalone: null, otp: ["d1"], newPasswords: [] },
  "otp-digit-boxes-form.html": { passwords: [], usernames: {}, standalone: null, otp: ["d1"], newPasswords: [] },
  "checkout-card.html": { passwords: [], usernames: {}, standalone: null, otp: [], newPasswords: [] },
  "precedence.html": {
    passwords: ["pw", "confirm"],
    usernames: { pw: "user", confirm: "user" },
    standalone: "user",
    otp: [],
    newPasswords: ["pw", "confirm"],
  },
};

// identifierField, the field that gets the inline button on the first step of a two-step login. Every other
// fixture has a password or code field (or nothing to sign in with), so it must find none there.
const identifierSteps: Readonly<Record<string, string>> = {
  "two-step-identifier.html": "user",
  "two-step-identifier-unmarked.html": "user",
  "two-step-identifier-formless.html": "user",
  "two-step-identifier-hidden-password.html": "user",
};

describe("login form fixture corpus", () => {
  it("has an expectation for every fixture", () => {
    const files = readdirSync(fixtures).filter((name) => name.endsWith(".html"));
    expect([...files].sort()).toEqual(Object.keys(corpus).sort());
  });

  describe.each(Object.entries(corpus))("%s", (name, expected) => {
    beforeEach(() => load(name));

    it("finds the visible password fields", () => {
      expect(tags(passwordFields(document))).toEqual(expected.passwords);
    });

    it("pairs each password with its username field", () => {
      const found = passwordFields(document).map((pw) => [tag(pw), tag(usernameFieldFor(pw))]);
      expect(found).toEqual(Object.entries(expected.usernames));
    });

    it("finds the username field a two-step login would fill", () => {
      expect(tag(standaloneUsernameField(document))).toBe(expected.standalone);
    });

    it("finds the identifier step of a two-step login, and only that", () => {
      expect(tag(identifierField(document))).toBe(identifierSteps[name] ?? null);
    });

    it("finds one-time code fields", () => {
      expect(tags(otpFields(document))).toEqual(expected.otp);
    });

    it("tells new passwords from current ones", () => {
      expect(tags(passwordFields(document).filter(isNewPasswordField))).toEqual(expected.newPasswords);
    });
  });
});

describe("filling and capturing fixtures", () => {
  const credentials = { username: "alice@example.com", password: "hunter2!" };

  it("fills a login rendered inside per-input shadow roots", () => {
    const doc = load("shadow-dom-inputs.html");
    expect(fillLogin(doc, credentials).filled).toBe(true);
    expect([field("user").value, field("pw").value]).toEqual(["alice@example.com", "hunter2!"]);
  });

  it("fills the identifier step of a two-step login, not the newsletter box", () => {
    const doc = load("two-step-identifier-unmarked.html");
    fillLogin(doc, credentials);
    expect([field("user").value, field("newsletter").value]).toEqual(["alice@example.com", ""]);
  });

  it("fills only the username when the picker on the identifier step is used", () => {
    const doc = load("two-step-identifier-hidden-password.html");
    expect(fillLogin(doc, credentials, field("user"))).toEqual({ filled: true, form: field("user").form });
    expect([field("user").value, field("pw").value]).toEqual(["alice@example.com", ""]);
  });

  it("fills nothing on the identifier step for an entry without a username", () => {
    load("two-step-identifier-formless.html");
    expect(fillLogin(document, { username: "", password: "pw" }, field("user")).filled).toBe(false);
    expect(field("user").value).toBe("");
  });

  it("fills the password too once the step reveals it next to the identifier", () => {
    load("two-step-identifier-hidden-password.html");
    (field("pw").parentElement as HTMLElement).style.display = "";
    fillLogin(document, credentials, field("user"));
    expect([field("user").value, field("pw").value]).toEqual(["alice@example.com", "hunter2!"]);
  });

  it("leaves honeypots and the read-only identifier alone", () => {
    const doc = load("login-honeypot.html");
    fillLogin(doc, credentials);
    expect([field("user").value, field("honeypot").value, field("pw").value, field("pw-trap").value]).toEqual([
      "alice@example.com",
      "",
      "hunter2!",
      "",
    ]);

    load("two-step-password-readonly.html");
    fillLogin(document, { username: "bob", password: "pw" });
    expect([field("user").value, field("pw").value]).toEqual(["alice@example.com", "pw"]);
  });

  it.each(["login-decoy-offscreen.html", "login-decoy-opacity.html", "login-decoy-tiny.html"])(
    "fills the real form, not the hidden decoys ahead of it, when no field is targeted (%s)",
    (name) => {
      const doc = load(name);
      expect(fillLogin(doc, credentials).filled).toBe(true);
      expect([field("user").value, field("pw").value]).toEqual(["alice@example.com", "hunter2!"]);
      const decoys = allElements(doc).filter((element) => element.localName === "input" && !["user", "pw"].includes(tag(element) ?? ""));
      expect(decoys.map((decoy) => (decoy as HTMLInputElement).value)).toEqual(decoys.map(() => ""));
    },
  );

  it("refuses a targeted field the page has hidden", () => {
    const doc = load("login-decoy-opacity.html");
    expect(fillLogin(doc, credentials, field("bait-pw")).filled).toBe(false);
    expect(field("bait-pw").value).toBe("");
  });

  it.each(["login-floating-labels.html", "login-visually-hidden-labels.html"])("fills a real form with styled labels (%s)", (name) => {
    const doc = load(name);
    expect(fillLogin(doc, credentials).filled).toBe(true);
    expect([field("user").value, field("pw").value]).toEqual(["alice@example.com", "hunter2!"]);
  });

  it("fills the password beside a visually hidden username, and captures that username", () => {
    const doc = load("two-step-password-visually-hidden-username.html");
    fillLogin(doc, { username: "bob", password: "hunter2!" });
    expect([field("user").value, field("pw").value]).toEqual(["alice@example.com", "hunter2!"]);
    expect(capturedLogin(doc, field("pw").form)).toEqual({ username: "alice@example.com", password: "hunter2!" });
  });

  it("captures the username kept in a hidden field on the password step", () => {
    const doc = load("two-step-password-hidden-username.html");
    field("pw").value = "hunter2!";
    expect(capturedLogin(doc, field("pw").form)).toEqual({ username: "alice@example.com", password: "hunter2!" });
  });

  it("captures the read-only identifier on the password step", () => {
    const doc = load("two-step-password-readonly.html");
    field("pw").value = "hunter2!";
    expect(capturedLogin(doc, field("pw").form)).toEqual({ username: "alice@example.com", password: "hunter2!" });
  });

  it("fills the unmarked confirmation along with the marked new password", () => {
    load("login-and-signup-forms.html");
    fillNewPassword(field("signup-pw"), "Gen3rated!");
    expect([field("signup-pw").value, field("signup-confirm").value, field("login-pw").value]).toEqual([
      "Gen3rated!",
      "Gen3rated!",
      "",
    ]);
  });

  it("captures the new password when the current one comes last", () => {
    const doc = load("change-password-current-last.html");
    field("new").value = "n3w";
    field("confirm").value = "n3w";
    field("current").value = "old";
    expect(capturedLogin(doc, field("new").form)).toEqual({ username: "alice@example.com", password: "n3w" });
  });

  it("captures the change-password form's hidden username", () => {
    const doc = load("change-password-marked.html");
    field("current").value = "old";
    field("new").value = "n3w";
    field("confirm").value = "n3w";
    expect(capturedLogin(doc, field("new").form)).toEqual({ username: "alice", password: "n3w" });
  });

  it("captures a formless SPA login without mixing in the sign-up panel", () => {
    const doc = load("spa-formless-panels.html");
    field("signup-email").value = "new@example.com";
    field("login-user").value = "alice";
    field("login-pw").value = "hunter2!";
    expect(capturedLogin(doc, null)).toEqual({ username: "alice", password: "hunter2!" });
  });

  it("spreads a code across digit boxes", () => {
    load("otp-digit-boxes.html");
    fillOtp(field("d1"), "424242");
    expect(["d1", "d2", "d3", "d4", "d5", "d6"].map((name) => field(name).value).join("")).toBe("424242");
  });
});
