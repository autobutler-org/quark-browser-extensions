import { saveBarCopy } from "../src/shared/saveCopy";

describe("save bar copy", () => {
  it("explains how a new login can be handled", () => {
    expect(saveBarCopy({ kind: "save", host: "accounts.example", username: "alice" })).toEqual({
      title: "Save this login to Quark Vault?",
      sub: "alice on accounts.example",
      actions: [
        ["dismiss", "Not now"],
        ["never", "Never for this site"],
        ["save", "Save"],
      ],
    });
  });

  it("names the saved login whose password can be updated", () => {
    expect(
      saveBarCopy({ kind: "update", host: "accounts.example", username: "alice", entryId: 7, entryName: "Example" }),
    ).toEqual({
      title: "Update the password in Quark Vault?",
      sub: "Example · alice",
      actions: [
        ["dismiss", "Not now"],
        ["update", "Update"],
      ],
    });
  });

  it("asks the user to unlock before saving", () => {
    expect(saveBarCopy({ kind: "unlock", host: "accounts.example", username: "alice" })).toEqual({
      title: "Unlock Quark Vault to save this login",
      sub: "alice on accounts.example",
      actions: [
        ["dismiss", "Not now"],
        ["unlock", "Unlock"],
      ],
    });
  });

  it("uses only the site name when an unlock offer has no username", () => {
    expect(saveBarCopy({ kind: "unlock", host: "accounts.example", username: "" }).sub).toBe("accounts.example");
  });
});
