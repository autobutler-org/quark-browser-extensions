import { currentBrowser, type Browser } from "../shared/platform";
import type { Settings } from "../shared/types";

export type IdleState = "active" | "idle" | "locked";

export type IdleAction = "lock" | "none";

// Firefox's idle API never reports "locked" (#132): a locked screen only shows up as "idle" once the detection
// interval passes with no input. So on Firefox "idle" stands in for the screen lock and always locks, which
// means the vault locks after the idle time whether or not lock-on-idle is on.
export const idleAction = (state: IdleState, settings: Settings, browser: Browser = currentBrowser()): IdleAction => {
  switch (state) {
    case "locked":
      return "lock";
    case "idle":
      return settings.lockOnIdle || browser === "firefox" ? "lock" : "none";
    case "active":
      return "none";
  }
};

export const detectionIntervalSeconds = (settings: Settings): number => settings.idleMinutes * 60;
