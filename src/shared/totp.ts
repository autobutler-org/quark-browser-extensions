export type OtpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export type OtpParams = Readonly<{
  key: Uint8Array;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
}>;

export type OtpCode = Readonly<{
  code: string;
  secondsLeft: number;
}>;

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const base32Decode = (input: string): Uint8Array | null => {
  const clean = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (clean === "" || [...clean].some((char) => !base32Alphabet.includes(char))) {
    return null;
  }
  const bits = [...clean].map((char) => base32Alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const bytes = Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  return Uint8Array.from(bytes);
};

const algorithms: Readonly<Record<string, OtpAlgorithm>> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

const inRange = (value: number, min: number, max: number, fallback: number): number =>
  Number.isInteger(value) && value >= min && value <= max ? value : fallback;

export const parseOtpSecret = (secret: string): OtpParams | null => {
  const trimmed = secret.trim();
  if (!trimmed.toLowerCase().startsWith("otpauth://")) {
    const key = base32Decode(trimmed);
    return key === null ? null : { key, algorithm: "SHA-1", digits: 6, period: 30 };
  }
  try {
    const url = new URL(trimmed);
    if (url.host.toLowerCase() !== "totp") {
      return null;
    }
    const key = base32Decode(url.searchParams.get("secret") ?? "");
    if (key === null) {
      return null;
    }
    return {
      key,
      algorithm: algorithms[(url.searchParams.get("algorithm") ?? "SHA1").toUpperCase()] ?? "SHA-1",
      digits: inRange(Number(url.searchParams.get("digits") ?? 6), 6, 8, 6),
      period: inRange(Number(url.searchParams.get("period") ?? 30), 1, 300, 30),
    };
  } catch {
    return null;
  }
};

const counterBytes = (counter: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(counter));
  return bytes;
};

export const hotp = async (params: OtpParams, counter: number): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    params.key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: params.algorithm },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes(counter) as Uint8Array<ArrayBuffer>));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** params.digits).padStart(params.digits, "0");
};

export const totp = async (params: OtpParams, nowMs: number): Promise<OtpCode> => {
  const seconds = Math.floor(nowMs / 1000);
  return {
    code: await hotp(params, Math.floor(seconds / params.period)),
    secondsLeft: params.period - (seconds % params.period),
  };
};
