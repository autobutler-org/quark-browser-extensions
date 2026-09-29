import { base32Decode, parseOtpSecret, totp, type OtpParams } from "../src/shared/totp";

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

const rfc = (key: string, algorithm: OtpParams["algorithm"]): OtpParams => ({
  key: ascii(key),
  algorithm,
  digits: 8,
  period: 30,
});

const sha1 = rfc("12345678901234567890", "SHA-1");
const sha256 = rfc("12345678901234567890123456789012", "SHA-256");
const sha512 = rfc("1234567890123456789012345678901234567890123456789012345678901234", "SHA-512");

describe("totp matches the RFC 6238 test vectors", () => {
  it.each([
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ])("t=%i", async (seconds, one, two, five) => {
    expect((await totp(sha1, seconds * 1000)).code).toBe(one);
    expect((await totp(sha256, seconds * 1000)).code).toBe(two);
    expect((await totp(sha512, seconds * 1000)).code).toBe(five);
  });

  it("reports the seconds left in the period", async () => {
    expect((await totp(sha1, 59_000)).secondsLeft).toBe(1);
    expect((await totp(sha1, 60_000)).secondsLeft).toBe(30);
  });
});

describe("base32Decode", () => {
  it("decodes RFC 4648 base32, ignoring case, spaces and padding", () => {
    expect(new TextDecoder().decode(base32Decode("GEZDGNBVGY3TQOJQ") ?? new Uint8Array())).toBe("1234567890");
    expect(new TextDecoder().decode(base32Decode("gezd gnbv gy3t qojq====") ?? new Uint8Array())).toBe("1234567890");
  });

  it("rejects characters outside the alphabet", () => {
    expect(base32Decode("GEZD1")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });
});

describe("parseOtpSecret", () => {
  it("reads a bare secret with defaults", () => {
    expect(parseOtpSecret("GEZDGNBVGY3TQOJQ")).toMatchObject({ algorithm: "SHA-1", digits: 6, period: 30 });
  });

  it("reads an otpauth URI's parameters", () => {
    expect(
      parseOtpSecret("otpauth://totp/Quark:brandon?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60"),
    ).toMatchObject({ algorithm: "SHA-256", digits: 8, period: 60 });
  });

  it("falls back on out-of-range parameters and rejects HOTP or bad secrets", () => {
    expect(parseOtpSecret("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=12&algorithm=MD5")).toMatchObject({
      algorithm: "SHA-1",
      digits: 6,
    });
    expect(parseOtpSecret("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=1")).toBeNull();
    expect(parseOtpSecret("otpauth://totp/x?secret=not-base32!")).toBeNull();
    expect(parseOtpSecret("")).toBeNull();
  });
});
