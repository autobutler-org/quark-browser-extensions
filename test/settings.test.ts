import { idleAction, detectionIntervalSeconds } from "../src/background/idle";
import { decodeSettings } from "../src/shared/settings";
import { defaultSettings } from "../src/shared/types";

describe("decodeSettings", () => {
  it("falls back to defaults for missing or mistyped values", () => {
    expect(decodeSettings(undefined)).toEqual(defaultSettings);
    expect(decodeSettings({ badge: "yes", autoSubmit: true, idleMinutes: 7, stray: 1 })).toEqual({
      ...defaultSettings,
      autoSubmit: true,
    });
  });

  it("keeps an allowed idle time", () => {
    expect(decodeSettings({ idleMinutes: 30 }).idleMinutes).toBe(30);
  });
});

describe("idleAction", () => {
  const off = defaultSettings;
  const on = { ...defaultSettings, lockOnIdle: true };

  it("always locks when the screen locks", () => {
    expect(idleAction("locked", off)).toBe("lock");
    expect(idleAction("locked", on)).toBe("lock");
  });

  it("locks on idle only when opted in", () => {
    expect(idleAction("idle", off)).toBe("none");
    expect(idleAction("idle", on)).toBe("lock");
  });

  it("does nothing when active", () => {
    expect(idleAction("active", on)).toBe("none");
  });

  it("converts minutes to the detection interval", () => {
    expect(detectionIntervalSeconds({ ...defaultSettings, idleMinutes: 5 })).toBe(300);
  });
});
