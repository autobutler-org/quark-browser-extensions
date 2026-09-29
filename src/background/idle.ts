import type { Settings } from "../shared/types";

export type IdleState = "active" | "idle" | "locked";

export type IdleAction = "lock" | "none";

export const idleAction = (state: IdleState, settings: Settings): IdleAction => {
  switch (state) {
    case "locked":
      return "lock";
    case "idle":
      return settings.lockOnIdle ? "lock" : "none";
    case "active":
      return "none";
  }
};

export const detectionIntervalSeconds = (settings: Settings): number => settings.idleMinutes * 60;
