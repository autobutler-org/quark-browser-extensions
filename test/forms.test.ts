import {
  capturedLogin,
  fillLogin,
  fillNewPassword,
  fillOtp,
  generatedLength,
  isNewPasswordField,
  looksLikeSubmit,
  newPasswordGroup,
  otpFields,
  passwordFields,
  submit,
  usernameFieldFor,
} from "../src/content/forms";

const mount = (html: string): Document => {
  document.body.innerHTML = html;
  return document;
};

const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;

const credentials = { username: "brandon", password: "s3cret" };

describe("passwordFields", () => {
  it("skips hidden and disabled fields", () => {
    const doc = mount(`
      <input id="a" type="password">
      <input id="b" type="password" disabled>
      <div style="display: none"><input id="c" type="password"></div>
      <div hidden><input id="d" type="password"></div>
      <input id="e" type="password" style="visibility: hidden">
    `);
    expect(passwordFields(doc).map((field) => field.id)).toEqual(["a"]);
  });
});

describe("usernameFieldFor", () => {
  it("prefers the field marked as a username", () => {
    mount(`
      <form>
        <input id="search" type="text">
        <input id="user" type="text" autocomplete="username">
        <input id="note" type="text">
        <input id="pw" type="password">
      </form>
    `);
    expect(usernameFieldFor(input("pw"))?.id).toBe("user");
  });

  it("falls back to the nearest text field before the password", () => {
    mount(`
      <form>
        <input id="first" type="text">
        <input id="second" type="text">
        <input id="pw" type="password">
        <input id="after" type="text">
      </form>
    `);
    expect(usernameFieldFor(input("pw"))?.id).toBe("second");
  });

  it("stays inside the password's form", () => {
    mount(`
      <form><input id="newsletter" type="email"></form>
      <form><input id="pw" type="password"></form>
    `);
    expect(usernameFieldFor(input("pw"))).toBeNull();
  });
});

describe("fillLogin", () => {
  it("fills both fields and fires the events frameworks listen for", () => {
    const doc = mount(`<form><input id="user" type="email"><input id="pw" type="password"></form>`);
    const seen: string[] = [];
    ["input", "change"].forEach((type) =>
      doc.addEventListener(type, (event) => seen.push(`${type}:${(event.target as HTMLInputElement).id}`)),
    );

    const outcome = fillLogin(doc, credentials);

    expect(outcome.filled).toBe(true);
    expect(input("user").value).toBe("brandon");
    expect(input("pw").value).toBe("s3cret");
    expect(seen).toEqual(["input:user", "change:user", "input:pw", "change:pw"]);
  });

  it("fills the targeted password field when there are several", () => {
    const doc = mount(`
      <form><input id="u1" type="text"><input id="p1" type="password"></form>
      <form><input id="u2" type="text"><input id="p2" type="password"></form>
    `);
    fillLogin(doc, credentials, input("p2"));
    expect([input("u1").value, input("p1").value]).toEqual(["", ""]);
    expect([input("u2").value, input("p2").value]).toEqual(["brandon", "s3cret"]);
  });

  it("fills the username alone on a two-step login", () => {
    const doc = mount(`<form><input id="user" type="text" autocomplete="username"></form>`);
    expect(fillLogin(doc, credentials).filled).toBe(true);
    expect(input("user").value).toBe("brandon");
  });

  it("reports nothing to fill", () => {
    const doc = mount(`<p>no form here</p>`);
    expect(fillLogin(doc, credentials).filled).toBe(false);
  });
});

describe("submit", () => {
  it("clicks the submit button so the page's handlers run", () => {
    mount(`<form id="f"><input type="password"><button id="go" type="submit">Sign in</button></form>`);
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.getElementById("go")?.addEventListener("click", clicked);
    submit(document.getElementById("f") as HTMLFormElement);
    expect(clicked).toHaveBeenCalledOnce();
  });
});

describe("one-time code fields", () => {
  it("finds fields by autocomplete or name, not ordinary text fields", () => {
    const doc = mount(`
      <input id="search" type="text" name="q">
      <input id="a" type="text" autocomplete="one-time-code">
      <input id="b" type="tel" name="totp_code">
      <input id="c" type="text" placeholder="Enter verification code">
      <input id="d" type="password" name="otp">
    `);
    expect(otpFields(doc).map((field) => field.id)).toEqual(["a", "b", "c"]);
  });

  it("treats a run of single-digit boxes as one field starting at the first box", () => {
    const doc = mount(`<form>${[1, 2, 3, 4, 5, 6].map((n) => `<input id="d${n}" type="text" maxlength="1" inputmode="numeric">`).join("")}</form>`);
    expect(otpFields(doc).map((field) => field.id)).toEqual(["d1"]);
    fillOtp(input("d1"), "123456");
    expect([1, 2, 3, 4, 5, 6].map((n) => input(`d${n}`).value).join("")).toBe("123456");
  });

  it("fills a single code field", () => {
    mount(`<input id="code" type="text" autocomplete="one-time-code">`);
    fillOtp(input("code"), "987654");
    expect(input("code").value).toBe("987654");
  });
});

describe("new-password fields", () => {
  const ids = (fields: readonly HTMLInputElement[]) => fields.map((field) => field.id);

  it("uses the autocomplete hint when present", () => {
    mount(`<form><input id="cur" type="password" autocomplete="current-password"><input id="new" type="password" autocomplete="new-password"><input id="again" type="password" autocomplete="new-password"></form>`);
    expect(ids(newPasswordGroup(input("new")))).toEqual(["new", "again"]);
    expect(isNewPasswordField(input("cur"))).toBe(false);
  });

  it("treats two unmarked fields as password plus confirmation", () => {
    mount(`<form><input id="p1" type="password"><input id="p2" type="password"></form>`);
    expect(ids(newPasswordGroup(input("p1")))).toEqual(["p1", "p2"]);
  });

  it("treats three unmarked fields as current, new, confirm", () => {
    mount(`<form><input id="cur" type="password"><input id="new" type="password"><input id="again" type="password"></form>`);
    expect(ids(newPasswordGroup(input("new")))).toEqual(["new", "again"]);
    expect(isNewPasswordField(input("cur"))).toBe(false);
  });

  it("leaves a plain login alone", () => {
    mount(`<form><input id="user" type="text"><input id="pw" type="password"></form>`);
    expect(isNewPasswordField(input("pw"))).toBe(false);
  });

  it("keeps separate forms apart", () => {
    mount(`<form><input id="login" type="password"></form><form><input id="a" type="password"><input id="b" type="password"></form>`);
    expect(isNewPasswordField(input("login"))).toBe(false);
    expect(ids(newPasswordGroup(input("a")))).toEqual(["a", "b"]);
  });

  it("fills the whole group", () => {
    mount(`<form><input id="p1" type="password" autocomplete="new-password"><input id="p2" type="password" autocomplete="new-password"></form>`);
    fillNewPassword(input("p1"), "Gen3rated!");
    expect([input("p1").value, input("p2").value]).toEqual(["Gen3rated!", "Gen3rated!"]);
  });

  it.each([
    [-1, 20],
    [8, 12],
    [16, 16],
    [128, 20],
  ])("maxlength %i → %i characters", (maxLength, expected) => {
    mount(`<input id="pw" type="password">`);
    if (maxLength > 0) {
      input("pw").maxLength = maxLength;
    }
    expect(generatedLength(input("pw"))).toBe(expected);
  });
});

describe("capturedLogin", () => {
  it("reads the username and password of a submitted login", () => {
    const doc = mount(`<form id="f"><input id="u" type="email" value="alice@example.com"><input id="p" type="password" value="pw"></form>`);
    expect(capturedLogin(doc, document.getElementById("f") as HTMLFormElement)).toEqual({ username: "alice@example.com", password: "pw" });
  });

  it("takes the new password from a change-password form", () => {
    const doc = mount(`<form id="f"><input type="password" autocomplete="current-password" value="old"><input type="password" autocomplete="new-password" value="new"><input type="password" autocomplete="new-password" value="new"></form>`);
    expect(capturedLogin(doc, document.getElementById("f") as HTMLFormElement)).toEqual({ username: "", password: "new" });
  });

  it("skips a sign-up whose confirmation doesn't match", () => {
    const doc = mount(`<form id="f"><input type="text" value="bob"><input type="password" value="a"><input type="password" value="b"></form>`);
    expect(capturedLogin(doc, document.getElementById("f") as HTMLFormElement)).toBeNull();
  });

  it("skips a form the browser won't submit", () => {
    const doc = mount(`<form id="f"><input type="email" value="not-an-email"><input type="password" value="pw"></form>`);
    expect(capturedLogin(doc, document.getElementById("f") as HTMLFormElement)).toBeNull();
  });

  it("skips empty password fields", () => {
    const doc = mount(`<form id="f"><input type="text" value="bob"><input type="password"></form>`);
    expect(capturedLogin(doc, document.getElementById("f") as HTMLFormElement)).toBeNull();
  });
});

describe("looksLikeSubmit", () => {
  it.each([
    [`<form><button id="t" type="submit">Go</button></form>`, true],
    [`<div><button id="t" type="button"><span>Sign in</span></button></div>`, true],
    [`<input id="t" type="submit" value="Log in">`, true],
    [`<div role="button" id="t">Continue</div>`, true],
    [`<button id="t" type="button">Show password</button>`, false],
    [`<a id="t" href="#">Sign in</a>`, false],
  ])("%s → %s", (html, expected) => {
    mount(html);
    const target = document.getElementById("t") as Element;
    expect(looksLikeSubmit(target.firstElementChild ?? target)).toBe(expected);
  });
});
