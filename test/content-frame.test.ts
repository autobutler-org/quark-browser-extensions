import { frameTopUrl } from "../src/content/frame";

const origins = (...values: string[]) => ({ length: values.length, item: (index: number) => values[index] ?? null });

describe("frameTopUrl", () => {
  it("is the page itself in the top frame", () => {
    expect(frameTopUrl(true, "https://bank.example/login", undefined, "https://evil.example/")).toBe(
      "https://bank.example/login",
    );
  });

  it("uses the outermost ancestor origin where the browser has them", () => {
    expect(
      frameTopUrl(false, "https://login.bank.example/", origins("https://mid.example", "https://bank.example"), undefined),
    ).toBe("https://bank.example");
  });

  it("prefers ancestorOrigins over the worker's top URL", () => {
    expect(
      frameTopUrl(false, "https://login.bank.example/", origins("https://evil.example"), "https://bank.example/"),
    ).toBe("https://evil.example");
  });

  it("falls back to the worker's verified top URL without ancestorOrigins (Firefox)", () => {
    expect(frameTopUrl(false, "https://login.bank.example/", undefined, "https://bank.example/home")).toBe(
      "https://bank.example/home",
    );
  });

  it("refuses with no top URL from either source", () => {
    expect(frameTopUrl(false, "https://login.bank.example/", undefined, undefined)).toBe("");
    expect(frameTopUrl(false, "https://login.bank.example/", origins(), "https://bank.example/")).toBe("");
  });
});
