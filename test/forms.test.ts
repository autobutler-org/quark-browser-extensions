import { fillLogin, fillOtp, otpFields, passwordFields, submit, usernameFieldFor } from "../src/content/forms";

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
