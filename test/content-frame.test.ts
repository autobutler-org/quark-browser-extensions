import { fillDecision, frameTopUrl } from "../src/content/frame";

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

describe("fillDecision", () => {
  const entryUrl = "https://github.com/login";
  const entryHost = "github.com";
  const decide = (isTop: boolean, href: string, topUrl: string, hasFields = true) =>
    fillDecision(isTop, hasFields, href, topUrl, entryUrl, entryHost);

  it("asks the worker from a top frame of the entry's site", () => {
    expect(decide(true, "https://github.com/login", "https://github.com/login")).toEqual({ kind: "ask" });
  });

  it("asks the worker from a same-site iframe", () => {
    expect(decide(false, "https://auth.github.com/frame", "https://github.com/")).toEqual({ kind: "ask" });
  });

  it("stays quiet without login fields, so the frame that has them answers", () => {
    expect(decide(true, "https://github.com/", "https://github.com/", false)).toEqual({ kind: "silent" });
    expect(decide(false, "https://github.com/frame", "https://github.com/", false)).toEqual({ kind: "silent" });
  });

  it("stays quiet in another site's iframe", () => {
    expect(decide(false, "https://ads.example/frame", "https://github.com/")).toEqual({ kind: "silent" });
  });

  it("refuses in a top frame of another site", () => {
    expect(decide(true, "https://evil.example/login", "https://evil.example/login")).toEqual({
      kind: "refuse",
      reason: "This login doesn't belong to this site.",
    });
  });

  it("refuses the entry's site embedded in another site", () => {
    expect(decide(false, "https://github.com/login", "https://evil.example/")).toMatchObject({ kind: "refuse" });
    expect(decide(false, "https://github.com/login", "")).toMatchObject({ kind: "refuse" });
  });
});
