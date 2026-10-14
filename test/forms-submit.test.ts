// @vitest-environment-options { "url": "https://login.example.com/signin" }
import { submit } from "../src/content/forms";

// Submit after filling (#130): the form only goes where the page's own site would send it.

const submitted = (html: string): boolean => {
  document.body.innerHTML = html;
  const form = document.querySelector("form") as HTMLFormElement;
  let sent = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sent = true;
  });
  submit(form);
  return sent;
};

const login = (attributes: string, button = '<button type="submit">Sign in</button>'): string =>
  `<form ${attributes}><input name="user"><input type="password" name="pw">${button}</form>`;

describe("submit after filling", () => {
  it.each([
    ["no action", ""],
    ["an empty action", 'action=""'],
    ['"#"', 'action="#"'],
    ["a relative path", 'action="/session"'],
    ["the same origin", 'action="https://login.example.com/session"'],
    ["another host on the same site", 'action="https://auth.example.com/session"'],
    ["the site's bare domain", 'action="https://example.com/session"'],
  ])("submits a form posting to %s", (_, attributes) => {
    expect(submitted(login(attributes))).toBe(true);
  });

  it("submits a form without a button through requestSubmit", () => {
    expect(submitted(login('action="/session"', ""))).toBe(true);
  });

  it.each([
    ["another site", 'action="https://evil.test/collect"'],
    ["a look-alike under another registrable domain", 'action="https://example.com.evil.test/collect"'],
    ["another owner on a shared suffix", 'action="https://example.github.io/collect"'],
    ["the same site over plain http", 'action="http://login.example.com/session"'],
    ["a protocol-relative URL on another site", 'action="//evil.test/collect"'],
    ["an IP address", 'action="https://203.0.113.9/collect"'],
    ["a javascript: URL", 'action="javascript:void(0)"'],
    ["a data: URL", 'action="data:text/html,hi"'],
  ])("skips a form posting to %s", (_, attributes) => {
    expect(submitted(login(attributes))).toBe(false);
  });

  it("skips a form without a button posting to another site", () => {
    expect(submitted(login('action="https://evil.test/collect"', ""))).toBe(false);
  });

  it("follows the button's formaction over the form's action", () => {
    expect(submitted(login('action="/session"', '<button formaction="https://evil.test/collect">Sign in</button>'))).toBe(false);
    expect(submitted(login('action="https://evil.test/collect"', '<button formaction="/session">Sign in</button>'))).toBe(true);
  });

  it("isn't fooled by a field named action that shadows form.action", () => {
    expect(submitted(`<form action="https://evil.test/collect"><input name="action" value="/session"><input type="password"><button>Go</button></form>`)).toBe(false);
  });

  it("resolves a relative action against the page's <base> the way the browser does", () => {
    const base = document.createElement("base");
    base.href = "https://evil.test/";
    document.head.append(base);
    try {
      expect(submitted(login('action="collect"'))).toBe(false);
    } finally {
      base.remove();
    }
  });
});
