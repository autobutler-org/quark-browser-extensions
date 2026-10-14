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

  it("remembers that the welcome was seen", () => {
    expect(decodeSettings({ welcomeSeen: true }).welcomeSeen).toBe(true);
    expect(decodeSettings({}).welcomeSeen).toBe(false);
  });

  it("keeps an allowed idle time", () => {
    expect(decodeSettings({ idleMinutes: 30 }).idleMinutes).toBe(30);
  });
});

describe("idleAction", () => {
  const off = defaultSettings;
  const on = { ...defaultSettings, lockOnIdle: true };

  it("always locks when the screen locks", () => {
    expect(idleAction("locked", off, "chrome")).toBe("lock");
    expect(idleAction("locked", on, "chrome")).toBe("lock");
  });

  it("on Chrome, locks on idle only when opted in", () => {
    expect(idleAction("idle", off, "chrome")).toBe("none");
    expect(idleAction("idle", on, "chrome")).toBe("lock");
  });

  it("does nothing when active", () => {
    expect(idleAction("active", on, "chrome")).toBe("none");
  });

  it("converts minutes to the detection interval", () => {
    expect(detectionIntervalSeconds({ ...defaultSettings, idleMinutes: 5 })).toBe(300);
  });
});
