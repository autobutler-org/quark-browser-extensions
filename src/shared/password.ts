import { err, ok, type Result } from "./types";

// A generated password that fits the field it goes into and has a character of every class it asks for
// (#131). The Quark draws each character uniformly from the pool of the requested classes but never promises
// one of each, so a draw without every class is thrown away and drawn again. Redrawing keeps every valid
// password equally likely, which placing one of each class first and shuffling would only approximate.

export type CharClass = "lower" | "upper" | "digit" | "symbol";

export const charClasses: readonly CharClass[] = ["lower", "upper", "digit", "symbol"];

// Quark's pool is 83 characters, 6.38 bits each: 20 characters is about 127 bits and 12 about 76. Below 12
// the password still fills the field, but the user is told the site keeps it short.
export const preferredLength = 20;
export const floorLength = 12;
export const longestLength = 64;

export type FieldRules = Readonly<{ maxLength: number; minLength: number; pattern: string }>;
export type PasswordPlan = Readonly<{ length: number; classes: readonly CharClass[] }>;

export const defaultPlan: PasswordPlan = { length: preferredLength, classes: charClasses };

export const isShort = (password: string): boolean => password.length < floorLength;

// Whether a password already passes the field's own checks.
export const fits = (password: string, rules: FieldRules): boolean =>
  (rules.maxLength <= 0 || password.length <= rules.maxLength) && password.length >= rules.minLength && patternTest(rules.pattern)(password);

const classOf = (char: string): CharClass =>
  /[a-z]/.test(char) ? "lower" : /[A-Z]/.test(char) ? "upper" : /[0-9]/.test(char) ? "digit" : "symbol";

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// A password can't hold more classes than characters; symbols go first, then digits.
const fitClasses = (classes: readonly CharClass[], length: number): readonly CharClass[] => classes.slice(0, length);

// What the worker will draw for a content script's request, whatever it sent.
export const sanePlan = (length: unknown, classes: unknown): PasswordPlan => {
  const wanted = Array.isArray(classes) ? charClasses.filter((name) => classes.includes(name)) : [];
  const size = typeof length === "number" && Number.isFinite(length) ? clamp(Math.floor(length), 1, longestLength) : preferredLength;
  return { length: size, classes: fitClasses(wanted.length === 0 ? charClasses : wanted, size) };
};

// The field's pattern as the browser checks it: the whole value, with the v flag. A pattern the browser
// can't compile is one it ignores.
export const patternTest = (pattern: string): ((value: string) => boolean) => {
  if (pattern === "") {
    return () => true;
  }
  for (const flags of ["v", "u"]) {
    try {
      const compiled = new RegExp(`^(?:${pattern})$`, flags);
      return (value) => compiled.test(value);
    } catch {
      // Try the next flags.
    }
  }
  return () => true;
};

// Every non-empty set of classes, richest first.
const classSets: readonly (readonly CharClass[])[] = Array.from({ length: 15 }, (_, index) =>
  charClasses.filter((_, bit) => ((15 - index) & (1 << (3 - bit))) !== 0),
).sort((a, b) => b.length - a.length);

const samples: Record<CharClass, readonly string[]> = {
  lower: ["a"],
  upper: ["A"],
  digit: ["2"],
  symbol: ["!", "#", "-", "_", "@", "*", "."],
};

// Could a password of this length and these classes pass the pattern? One stand-in per class, repeated.
const plausible = (length: number, classes: readonly CharClass[], accepts: (value: string) => boolean): boolean =>
  samples.symbol.some((symbol) => {
    const chars = classes.map((name) => (name === "symbol" ? symbol : (samples[name][0] ?? "")));
    return accepts(Array.from({ length }, (_, index) => chars[index % chars.length]).join(""));
  });

const plansTried = 6;

// The plans worth trying for a field, best first: the preferred length cut to fit maxlength and raised to
// minlength, with every class; then, only if the pattern rules that out, shorter or longer lengths and
// fewer classes.
export const plansFor = (rules: FieldRules, accepts: (value: string) => boolean = () => true): readonly PasswordPlan[] => {
  const longest = rules.maxLength > 0 ? Math.min(rules.maxLength, longestLength) : longestLength;
  const shortest = clamp(rules.minLength, 1, longest);
  const length = clamp(preferredLength, shortest, longest);
  const lengths = [
    ...Array.from({ length: length - shortest + 1 }, (_, index) => length - index),
    ...Array.from({ length: longest - length }, (_, index) => length + index + 1),
  ];
  const plans: PasswordPlan[] = [];
  for (const size of lengths) {
    for (const classes of classSets) {
      if (plans.length < plansTried && classes.length <= size && plausible(size, classes, accepts)) {
        plans.push({ length: size, classes });
      }
    }
  }
  return plans.length === 0 ? [{ length, classes: fitClasses(charClasses, length) }] : plans;
};

const meetsPlan = (password: string, plan: PasswordPlan): boolean => {
  const found = new Set([...password].map(classOf));
  return password.length === plan.length && plan.classes.every((name) => found.has(name)) && [...found].every((name) => plan.classes.includes(name));
};

export type Draw = (length: number, classes: readonly CharClass[]) => Promise<Result<string>>;

const draws = 8;

// One draw is cut into as many candidates as fit in the longest length, so a short password rarely costs a
// second request. Each candidate is uniform on its own; the first with every class is kept.
export const generateFor = async (plan: PasswordPlan, draw: Draw): Promise<Result<string>> => {
  const size = Math.floor(longestLength / plan.length) * plan.length;
  for (let attempt = 0; attempt < draws; attempt += 1) {
    const result = await draw(size, plan.classes);
    if (!result.ok) {
      return result;
    }
    for (let start = 0; start + plan.length <= result.value.length; start += plan.length) {
      const candidate = result.value.slice(start, start + plan.length);
      if (meetsPlan(candidate, plan)) {
        return ok(candidate);
      }
    }
  }
  return err({ kind: "server", status: 0, message: "The Quark didn't generate a password with every kind of character" });
};

const triesPerPlan = 4;

// A password for a field: plans in order, each tried a few times against the field's pattern. When none
// passes, the first plan's password still fills the field; the page will say what it wants.
export const passwordFor = async (rules: FieldRules, generate: (plan: PasswordPlan) => Promise<Result<string>>): Promise<Result<string>> => {
  const accepts = patternTest(rules.pattern);
  let first: Result<string> | null = null;
  for (const plan of plansFor(rules, accepts)) {
    for (let attempt = 0; attempt < triesPerPlan; attempt += 1) {
      const result = await generate(plan);
      if (!result.ok || accepts(result.value)) {
        return result;
      }
      first ??= result;
    }
  }
  return first ?? generate(plansFor(rules)[0] ?? { length: preferredLength, classes: charClasses });
};
