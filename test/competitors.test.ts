import { builtInState, findCompetitors, isPasswordManager, type InstalledExtension } from "../src/shared/competitors";

const ext = (id: string, name: string, overrides: Partial<InstalledExtension> = {}): InstalledExtension => ({
  id,
  name,
  enabled: true,
  type: "extension",
  mayDisable: true,
  ...overrides,
});

describe("isPasswordManager", () => {
  it.each([
    ["Proton Pass: Free Password Manager", true],
    ["Bitwarden Password Manager", true],
    ["1Password – Password Manager", true],
    ["uBlock Origin", false],
    ["Google Docs Offline", false],
  ])("%s → %s", (name, expected) => {
    expect(isPasswordManager(name)).toBe(expected);
  });
});

describe("findCompetitors", () => {
  it("lists enabled password manager extensions other than this one", () => {
    const found = findCompetitors(
      [
        ext("self", "Quark Vault"),
        ext("p", "Proton Pass"),
        ext("b", "Bitwarden", { enabled: false }),
        ext("t", "LastPass theme", { type: "theme" }),
        ext("u", "uBlock Origin"),
        ext("o", "1Password"),
      ],
      "self",
    );
    expect(found.map((e) => e.id)).toEqual(["o", "p"]);
  });
});

describe("builtInState", () => {
  it("offers to turn it off only when this extension can", () => {
    expect(builtInState(true, "controllable_by_this_extension")).toEqual({ kind: "on" });
    expect(builtInState(true, "not_controllable")).toEqual({ kind: "managed" });
    expect(builtInState(true, "controlled_by_other_extensions")).toEqual({ kind: "managed" });
    expect(builtInState(false, "controllable_by_this_extension")).toEqual({ kind: "off" });
  });
});
