import { unreachableHint } from "../src/popup/address";

describe("unreachableHint", () => {
  it("suggests http when https failed", () => {
    expect(unreachableHint("https://quark.local")).toBe(
      "Tried https://quark.local. If your Quark serves plain http, edit the address to http://quark.local.",
    );
    expect(unreachableHint("https://192.168.1.20:8080")).toContain("http://192.168.1.20:8080");
  });

  it("asks to check the address and port when http failed", () => {
    expect(unreachableHint("http://192.168.1.20:8080")).toBe(
      "Tried http://192.168.1.20:8080. Check the address and port, and that your Quark is online.",
    );
  });

  it("copes with an address that isn't a URL", () => {
    expect(unreachableHint("")).toBe("Check the address, then try again.");
  });
});
