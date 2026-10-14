import { deriveAuthKey, fromBase64 } from "../src/shared/authKey";

describe("deriveAuthKey", () => {
  // The Quark app's own vector (quark test/services/chat_crypto_test.dart) at
  // the shipped cost: accounts depend on this never changing.
  it("matches the Quark app's pinned vector", async () => {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(await deriveAuthKey("correct horse battery staple", salt)).toBe(
      "zNR6rA8kTcAq8wwj0fjQh9lSZ0A3+VNjah0pZEMf7XU=",
    );
  }, 60_000);
});

describe("fromBase64", () => {
  it("decodes standard base64 and rejects anything else", () => {
    expect(fromBase64("AAEC")).toEqual(Uint8Array.from([0, 1, 2]));
    expect(fromBase64("<!doctype html>")).toBeNull();
  });
});
