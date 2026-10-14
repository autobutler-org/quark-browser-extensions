import { isLoopbackHost, needsInsecureConfirmation, serverTransport } from "../src/shared/host";

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "localhost.", "quark.localhost", "127.0.0.1", "127.1.2.3", "[::1]"])(
    "treats %s as loopback",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );

  it.each(["", "quark.local", "192.168.1.10", "10.0.0.1", "128.0.0.1", "127.0.0.1.evil.io", "localhost.evil.io", "[::2]", "[::ffff:7f00:1]"])(
    "doesn't treat %s as loopback",
    (host) => expect(isLoopbackHost(host)).toBe(false),
  );
});

describe("serverTransport", () => {
  it.each([
    ["https://quark.local", "https"],
    ["https://192.168.1.10:8443", "https"],
    ["http://localhost:8080", "loopback"],
    ["http://127.0.0.1", "loopback"],
    ["http://127.0.0.42:3000", "loopback"],
    ["http://[::1]:8080", "loopback"],
    ["http://quark.local", "insecure"],
    ["http://192.168.1.10:8080", "insecure"],
    ["http://localhost.evil.io", "insecure"],
    ["ftp://quark.local", "insecure"],
    ["not a url", "insecure"],
  ])("calls %s %s", (server, transport) => expect(serverTransport(server)).toBe(transport));
});

describe("needsInsecureConfirmation", () => {
  it.each(["http://quark.local", " HTTP://192.168.1.10:8080/ ", "http://10.0.0.5"])("asks for %s", (input) =>
    expect(needsInsecureConfirmation(input)).toBe(true),
  );

  it.each(["", "   ", "quark.local", "https://quark.local", "http://localhost:8080", "http://127.0.0.1", "http://[::1]"])(
    "doesn't ask for %j",
    (input) => expect(needsInsecureConfirmation(input)).toBe(false),
  );
});
