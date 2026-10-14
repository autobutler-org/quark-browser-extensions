// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatDuration, formatNumber, messagePlaceholders, t, type MessageKey } from "../src/shared/i18n";
import { enMessages, fakeI18n } from "./fakeChrome";

const root = join(import.meta.dirname, "..");
const declared = Object.keys(messagePlaceholders);
const defined = Object.keys(enMessages);

// The code and the manifest name keys only as t("key", …) and __MSG_key__, so a scan finds every one in use.
const sources = [
  "wxt.config.ts",
  ...readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && file !== join("shared", "i18n.ts"))
    .map((file) => join("src", file)),
];
const used = new Set(
  sources.flatMap((file) => {
    const text = readFileSync(join(root, file), "utf8");
    return [...text.matchAll(/\bt\("(\w+)"/g), ...text.matchAll(/__MSG_(\w+)__/g)].map((found) => found[1] ?? "");
  }),
);

describe("messages.json", () => {
  it("defines exactly the keys the code declares", () => {
    expect(defined.toSorted()).toEqual(declared.toSorted());
  });

  it("uses every key it defines, and defines every key in use", () => {
    expect(defined.filter((key) => !used.has(key))).toEqual([]);
    expect([...used].filter((key) => !defined.includes(key))).toEqual([]);
  });

  it("keeps keys the browser can tell apart: letters, digits and _, unique in any case", () => {
    expect(defined.every((key) => /^\w+$/.test(key))).toBe(true);
    expect(new Set(defined.map((key) => key.toLowerCase())).size).toBe(defined.length);
  });

  it.each(declared as MessageKey[])("gives %s the placeholders the code passes, in order", (key) => {
    const { message, placeholders = {} } = enMessages[key] ?? { message: "" };
    const names = Object.entries(placeholders)
      .toSorted(([, a], [, b]) => a.content.localeCompare(b.content))
      .map(([name]) => name);
    expect(names).toEqual(messagePlaceholders[key]);
    expect(Object.values(placeholders).map((placeholder) => placeholder.content).toSorted()).toEqual(names.map((_, index) => `$${index + 1}`));
    const inMessage = new Set([...message.matchAll(/\$(\w+)\$/g)].map((found) => (found[1] ?? "").toLowerCase()));
    expect([...inMessage].toSorted()).toEqual(names.toSorted());
  });

  it("names a browser only in copy kept for that browser", () => {
    for (const [key, { message }] of Object.entries(enMessages)) {
      if (/Chrome|Google/.test(message)) expect(key, message).toMatch(/Chrome$/);
      if (/Firefox/.test(message)) expect(key, message).toMatch(/Firefox/);
    }
  });
});

describe("t", () => {
  it("reads the English copy, filling in placeholders", () => {
    expect(t("popupPersist")).toBe("Stay signed in after the browser closes");
    expect(t("popupFillAnywaySavedFor", "Bank", "bank.test", "evil.test")).toBe(
      "Bank is saved for bank.test, not evil.test. Filling it here gives its username and password to evil.test.",
    );
  });

  it("falls back to the key when the browser has no message for it", () => {
    vi.stubGlobal("chrome", { i18n: fakeI18n({}) });
    expect(t("popupPersist")).toBe("popupPersist");
    vi.unstubAllGlobals();
  });

  it("falls back to the key without chrome.i18n at all", () => {
    vi.stubGlobal("chrome", undefined);
    expect(t("extName")).toBe("extName");
    vi.unstubAllGlobals();
  });
});

describe("number and time formatting", () => {
  it("formats numbers and durations in the browser's language", () => {
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatDuration(15, "minute", "long")).toBe("15 minutes");
    expect(formatDuration(15, "minute", "short")).toBe("15 min");
    expect(formatDuration(20, "second", "narrow")).toBe("20s");
  });

  it("follows the UI language over English", () => {
    vi.stubGlobal("chrome", { i18n: { ...fakeI18n(), getUILanguage: () => "de" } });
    expect(formatNumber(1234)).toBe("1.234");
    vi.unstubAllGlobals();
  });
});
