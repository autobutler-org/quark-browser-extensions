import type { SaveAction, SaveOffer } from "../background/save";
import type { SiteMatch } from "./host";
import type { OtpCode } from "./totp";
import type { Credentials, EntrySummary, Result, Settings, VaultState } from "./types";

export type Request =
  | Readonly<{ type: "state" }>
  | Readonly<{ type: "connect"; server: string; username: string; password: string; persist: boolean; allowInsecure: boolean }>
  | Readonly<{ type: "signOut" }>
  | Readonly<{ type: "unlock"; masterPassword: string }>
  | Readonly<{ type: "lock" }>
  | Readonly<{ type: "entries" }>
  | Readonly<{ type: "matches"; pageUrl?: string }>
  | Readonly<{ type: "fillFromPage"; entryId: number }>
  // A frame's answer to a probe: whether the <iframe> its child frame announced itself from is shown (#141).
  | Readonly<{ type: "frameReport"; nonce: string; shown: boolean }>
  | Readonly<{ type: "fillInTab"; entryId: number; tabId: number }>
  // The user confirmed filling an entry saved for another site into the page on `pageHost` (host and port).
  | Readonly<{ type: "fillAnyway"; entryId: number; tabId: number; pageHost: string }>
  | Readonly<{ type: "reveal"; entryId: number }>
  | Readonly<{ type: "generate" }>
  | Readonly<{ type: "settings" }>
  | Readonly<{ type: "saveSettings"; settings: Settings }>
  | Readonly<{ type: "hello" }>
  | Readonly<{ type: "fieldFocused" }>
  | Readonly<{ type: "otpFromPage"; entryId: number }>
  | Readonly<{ type: "otp"; entryId: number }>
  | Readonly<{ type: "generateForPage"; length: number }>
  | Readonly<{ type: "captured"; username: string; password: string }>
  | Readonly<{ type: "myOffer" }>
  | Readonly<{ type: "pendingOffer"; tabId: number }>
  | Readonly<{ type: "resolveSave"; action: SaveAction; tabId?: number }>
  | Readonly<{ type: "neverSaveList" }>
  | Readonly<{ type: "removeNeverSave"; host: string }>;

export type Hello = Readonly<{
  settings: Settings;
  matches: readonly SiteMatch[];
  connected: boolean;
}>;

export type Responses = {
  state: VaultState;
  connect: Result<VaultState>;
  signOut: Result<VaultState>;
  unlock: Result<VaultState>;
  lock: Result<VaultState>;
  entries: Result<readonly EntrySummary[]>;
  matches: Result<readonly SiteMatch[]>;
  fillFromPage: Result<Credentials & Readonly<{ autoSubmit: boolean }>>;
  frameReport: null;
  fillInTab: Result<null>;
  fillAnyway: Result<null>;
  reveal: Result<Credentials>;
  generate: Result<string>;
  settings: Settings;
  saveSettings: Settings;
  hello: Hello;
  fieldFocused: null;
  otpFromPage: Result<OtpCode>;
  otp: Result<OtpCode>;
  generateForPage: Result<string>;
  captured: SaveOffer | null;
  myOffer: SaveOffer | null;
  pendingOffer: SaveOffer | null;
  resolveSave: Result<null>;
  neverSaveList: readonly string[];
  removeNeverSave: readonly string[];
};

// Carries no secret: it goes to every frame in the tab. A frame that looks like the target asks for the
// credentials with fillFromPage, where the worker checks the frame's browser-reported URL before answering.
export type FillCommand = Readonly<{
  type: "fill";
  entryId: number;
  entryUrl: string;
  entryHost: string;
  // The top frame's URL, verified by the service worker with frame 0. Frames use it only where
  // location.ancestorOrigins is missing (Firefox).
  topUrl?: string;
}>;

export type PageCommand =
  | FillCommand
  | Readonly<{ type: "openPicker" }>
  | Readonly<{ type: "fillGenerated"; password: string }>
  // Posts the nonce to the parent window, whose content script reports on the frame element it came from.
  | Readonly<{ type: "announceFrame"; nonce: string }>
  | Readonly<{ type: "offerCheck" }>
  | Readonly<{ type: "whereAmI" }>;

export type PageReply = Result<null>;

export const ask = <R extends Request>(request: R): Promise<Responses[R["type"]]> =>
  chrome.runtime.sendMessage<R, Responses[R["type"]]>(request);
