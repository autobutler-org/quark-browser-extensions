import { replacementBody } from "../src/shared/api";
import { decideOffer, isFresh, isNeverSaved, newEntryFor, pendingTtlMs, type OfferInput } from "../src/background/save";
import { saveBarCopy } from "../src/shared/saveCopy";
import type { EntryDetail, EntrySummary, Result } from "../src/shared/types";

const summary = (id: number): EntrySummary => ({ id, name: `E${id}`, urlHost: "example.com", folderId: null, createdAt: "", updatedAt: "" });
const detail = (id: number, username: string, password: string): EntryDetail => ({
  id,
  name: `E${id}`,
  url: "https://example.com",
  urlHost: "example.com",
  username,
  password,
  totpSecret: "",
});

const input = (overrides: Partial<OfferInput> & { details?: readonly EntryDetail[] }): OfferInput => {
  const details = overrides.details ?? [];
  return {
    pageUrl: "https://www.example.com/login",
    credentials: { username: "alice", password: "new-pass" },
    matches: details.map((d) => summary(d.id)),
    locked: false,
    loadDetail: async (id): Promise<Result<EntryDetail>> => {
      const found = details.find((d) => d.id === id);
      return found === undefined ? { ok: false, error: { kind: "notFound" } } : { ok: true, value: found };
    },
    ...overrides,
  };
};

describe("decideOffer", () => {
  it("offers to save a login the vault doesn't have", async () => {
    expect(await decideOffer(input({}))).toEqual({ kind: "save", host: "example.com", username: "alice" });
  });

  it("offers to update when the same user's password changed", async () => {
    expect(await decideOffer(input({ details: [detail(4, "bob", "x"), detail(7, "Alice", "old-pass")] }))).toEqual({
      kind: "update",
      host: "example.com",
      username: "Alice",
      entryId: 7,
      entryName: "E7",
    });
  });

  it("stays quiet when the password is already saved", async () => {
    expect(await decideOffer(input({ details: [detail(7, "alice", "new-pass")] }))).toBeNull();
  });

  it("updates the only entry when a change-password form has no username", async () => {
    const offer = await decideOffer(input({ credentials: { username: "", password: "p2" }, details: [detail(9, "carol", "p1")] }));
    expect(offer).toMatchObject({ kind: "update", entryId: 9 });
  });

  it("asks to unlock when locked", async () => {
    expect(await decideOffer(input({ locked: true }))).toEqual({ kind: "unlock", host: "example.com", username: "alice" });
  });

  it("never offers a new save on plain http, but still offers updates there", async () => {
    expect(await decideOffer(input({ pageUrl: "http://example.com/login" }))).toBeNull();
    expect(await decideOffer(input({ pageUrl: "http://example.com/login", details: [detail(2, "alice", "old")] }))).toMatchObject({ kind: "update" });
  });

  it("ignores a capture without a username or password", async () => {
    expect(await decideOffer(input({ credentials: { username: "", password: "x" } }))).toBeNull();
    expect(await decideOffer(input({ credentials: { username: "alice", password: "" } }))).toBeNull();
  });
});

describe("helpers", () => {
  it("expires pending captures", () => {
    const pending = { pageUrl: "", credentials: { username: "", password: "" }, at: 1000 };
    expect(isFresh(pending, 1000 + pendingTtlMs - 1)).toBe(true);
    expect(isFresh(pending, 1000 + pendingTtlMs)).toBe(false);
  });

  it("matches never-save hosts including subdomains", () => {
    expect(isNeverSaved(["example.com"], "https://login.example.com/")).toBe(true);
    expect(isNeverSaved(["example.com"], "https://other.com/")).toBe(false);
  });

  it("names a new entry after the host and stores the origin", () => {
    expect(newEntryFor("https://www.example.com/a/login?x=1", { username: "a", password: "b" })).toEqual({
      name: "example.com",
      url: "https://www.example.com",
      username: "a",
      password: "b",
    });
  });

  it("keeps every other field when replacing a password", () => {
    const current = {
      id: 3,
      name: "Bank",
      url: "https://bank.example",
      urlHost: "bank.example",
      username: "me",
      password: "old",
      notes: "keep",
      totpSecret: "GEZDGNBV",
      customFields: [{ name: "pin", value: "1234", hidden: true }],
      folderId: 5,
    };
    expect(replacementBody(current, "new")).toEqual({
      name: "Bank",
      url: "https://bank.example",
      username: "me",
      password: "new",
      notes: "keep",
      totpSecret: "GEZDGNBV",
      customFields: [{ name: "pin", value: "1234", hidden: true }],
      folderId: 5,
    });
  });

  it("words each offer", () => {
    expect(saveBarCopy({ kind: "save", host: "example.com", username: "a" }).actions.map(([action]) => action)).toEqual(["dismiss", "never", "save"]);
    expect(saveBarCopy({ kind: "update", host: "h", username: "a", entryId: 1, entryName: "Bank" }).sub).toBe("Bank · a");
  });
});
