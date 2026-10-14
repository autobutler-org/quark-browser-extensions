import { describe, expect, it } from "vitest";
import {
  charClasses,
  floorLength,
  generateFor,
  isShort,
  passwordFor,
  patternTest,
  plansFor,
  sanePlan,
  type CharClass,
  type FieldRules,
} from "../src/shared/password";
import { err, ok, type Result } from "../src/shared/types";

// A generated password fits the field it goes into and has a character of every class it asks for (#131).

// Quark's pool: lower, upper, digits and 26 symbols, minus the ambiguous 0O1lI. 83 characters in all.
const pools: Record<CharClass, string> = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digit: "23456789",
  symbol: "!@#$%^&*()-_=+[]{};:,.<>?/",
};

const uniform = (bound: number): number => {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const word = new Uint32Array(1);
  do {
    crypto.getRandomValues(word);
  } while ((word[0] ?? 0) >= limit);
  return (word[0] ?? 0) % bound;
};

// Like vaultutil.GeneratePassword: one uniform draw per character from the pool of the requested classes.
const server = (length: number, classes: readonly CharClass[]): Promise<Result<string>> => {
  const pool = classes.map((name) => pools[name]).join("");
  return Promise.resolve(ok(Array.from({ length }, () => pool[uniform(pool.length)]).join("")));
};

const classesIn = (password: string): ReadonlySet<CharClass> =>
  new Set([...password].map((char) => charClasses.find((name) => pools[name].includes(char)) ?? "symbol"));

const rules = (partial: Partial<FieldRules> = {}): FieldRules => ({ maxLength: -1, minLength: -1, pattern: "", ...partial });

const many = async <T>(count: number, make: () => Promise<T>): Promise<T[]> => {
  const out: T[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(await make());
  }
  return out;
};

const value = <T>(result: Result<T>): T => {
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
};

describe("plansFor", () => {
  it.each([
    [-1, -1, 20],
    [8, -1, 8],
    [16, -1, 16],
    [128, -1, 20],
    [-1, 24, 24],
    [-1, 100, 64],
    [10, 30, 10],
  ])("maxlength %i, minlength %i → %i characters", (maxLength, minLength, length) => {
    expect(plansFor(rules({ maxLength, minLength }))[0]).toEqual({ length, classes: charClasses });
  });

  it("never asks for more classes than there are characters", () => {
    expect(plansFor(rules({ maxLength: 2 }))[0]).toEqual({ length: 2, classes: ["lower", "upper"] });
  });

  it("drops the classes a pattern doesn't allow", () => {
    const accepts = patternTest("[A-Za-z0-9]{8,16}");
    expect(plansFor(rules({ pattern: "[A-Za-z0-9]{8,16}" }), accepts)[0]).toEqual({ length: 16, classes: ["lower", "upper", "digit"] });
  });

  it("keeps every class when the pattern requires them", () => {
    const pattern = "(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[^A-Za-z0-9]).{8,}";
    expect(plansFor(rules({ pattern }), patternTest(pattern))[0]).toEqual({ length: 20, classes: charClasses });
  });
});

describe("patternTest", () => {
  it("matches the whole value, as the browser does", () => {
    expect(patternTest("[a-z]+")("abc")).toBe(true);
    expect(patternTest("[a-z]+")("abc1")).toBe(false);
    expect(patternTest("a|b")("ab")).toBe(false);
  });

  it("ignores a pattern the browser would ignore", () => {
    expect(patternTest("(")("anything")).toBe(true);
    expect(patternTest("")("anything")).toBe(true);
  });
});

describe("sanePlan", () => {
  it("clamps what a content script asks for", () => {
    expect(sanePlan(0, ["lower"])).toEqual({ length: 1, classes: ["lower"] });
    expect(sanePlan(1000, charClasses)).toEqual({ length: 64, classes: charClasses });
    expect(sanePlan("8", ["nope", "digit", "digit"])).toEqual({ length: 20, classes: ["digit"] });
    expect(sanePlan(8, [])).toEqual({ length: 8, classes: charClasses });
    expect(sanePlan(3, charClasses)).toEqual({ length: 3, classes: ["lower", "upper", "digit"] });
  });
});

describe("generateFor", () => {
  it("has every class in every one of many passwords", async () => {
    const passwords = await many(2000, async () => value(await generateFor({ length: 20, classes: charClasses }, server)));
    expect(passwords.every((password) => password.length === 20)).toBe(true);
    expect(passwords.filter((password) => classesIn(password).size !== 4)).toEqual([]);
    expect(new Set(passwords).size).toBe(passwords.length);
  });

  it("fits a short field and still has every class", async () => {
    const passwords = await many(2000, async () => value(await generateFor({ length: 8, classes: charClasses }, server)));
    expect(passwords.filter((password) => password.length !== 8 || classesIn(password).size !== 4)).toEqual([]);
  });

  // Redrawing keeps every valid password equally likely. Placing one of each class first would not: the
  // first character would never be a digit, or always be one.
  it("keeps each position and character uniform", async () => {
    const passwords = await many(4000, async () => value(await generateFor({ length: 8, classes: charClasses }, server)));
    for (const position of [0, 7]) {
      const digits = passwords.filter((password) => pools.digit.includes(password[position] ?? "")).length / passwords.length;
      expect(digits).toBeGreaterThan(0.08);
      expect(digits).toBeLessThan(0.2);
    }
    const counts = new Map<string, number>();
    passwords.join("").split("").forEach((char) => counts.set(char, (counts.get(char) ?? 0) + 1));
    expect(counts.size).toBe(83);
    const lowers = [...pools.lower].map((char) => counts.get(char) ?? 0);
    expect(Math.min(...lowers) / Math.max(...lowers)).toBeGreaterThan(0.6);
  });

  it("uses only the classes it asks for", async () => {
    const passwords = await many(500, async () => value(await generateFor({ length: 12, classes: ["lower", "digit"] }, server)));
    expect(passwords.filter((password) => [...classesIn(password)].sort().join() !== "digit,lower")).toEqual([]);
  });

  it("cuts several candidates from one draw", async () => {
    const asked: number[] = [];
    const counting = (length: number, classes: readonly CharClass[]) => {
      asked.push(length);
      return server(length, classes);
    };
    value(await generateFor({ length: 8, classes: charClasses }, counting));
    expect(asked[0]).toBe(64);
  });

  it("passes on a failed draw", async () => {
    expect(await generateFor({ length: 20, classes: charClasses }, () => Promise.resolve(err({ kind: "rateLimited" })))).toEqual(
      err({ kind: "rateLimited" }),
    );
  });

  it("gives up rather than return a password without every class", async () => {
    const result = await generateFor({ length: 8, classes: charClasses }, (length) => Promise.resolve(ok("a".repeat(length))));
    expect(result.ok).toBe(false);
  });
});

describe("passwordFor", () => {
  const generator = (plan: { length: number; classes: readonly CharClass[] }) => generateFor(plan, server);

  it.each([
    ["[A-Za-z0-9]{8,16}", -1],
    ["(?=.*\\d)(?=.*[!@#]).{8,12}", -1],
    ["[a-z0-9]+", 10],
    ["\\S{6,}", 30],
  ])("fits pattern %s with maxlength %i", async (pattern, maxLength) => {
    const accepts = patternTest(pattern);
    const passwords = await many(200, async () => value(await passwordFor(rules({ pattern, maxLength }), generator)));
    expect(passwords.filter((password) => !accepts(password) || (maxLength > 0 && password.length > maxLength))).toEqual([]);
  });

  it("fills a field too short to be safe, and says so", async () => {
    const password = value(await passwordFor(rules({ maxLength: 8 }), generator));
    expect(password).toHaveLength(8);
    expect(classesIn(password).size).toBe(4);
    expect(isShort(password)).toBe(true);
    expect(isShort("x".repeat(floorLength))).toBe(false);
  });
});
