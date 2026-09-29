import { defaultSettings, idleMinuteChoices, type IdleMinutes, type Settings } from "./types";

const isIdleMinutes = (value: unknown): value is IdleMinutes =>
  idleMinuteChoices.some((choice) => choice === value);

const pick = <K extends keyof Settings>(stored: Record<string, unknown>, key: K): Settings[K] => {
  const value = stored[key];
  if (key === "idleMinutes") {
    return (isIdleMinutes(value) ? value : defaultSettings.idleMinutes) as Settings[K];
  }
  return (typeof value === typeof defaultSettings[key] ? value : defaultSettings[key]) as Settings[K];
};

export const decodeSettings = (value: unknown): Settings => {
  const stored = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    (Object.keys(defaultSettings) as (keyof Settings)[]).map((key) => [key, pick(stored, key)]),
  ) as Settings;
};
