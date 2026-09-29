import type { SaveAction, SaveOffer } from "../background/save";
import type { OtpCode } from "./totp";
import type { Credentials, EntrySummary, Result, Settings, VaultState } from "./types";

export type Request =
  | Readonly<{ type: "state" }>
  | Readonly<{ type: "connect"; server: string; username: string; password: string; persist: boolean }>
  | Readonly<{ type: "signOut" }>
  | Readonly<{ type: "unlock"; masterPassword: string }>
  | Readonly<{ type: "lock" }>
  | Readonly<{ type: "entries" }>
  | Readonly<{ type: "matches"; pageUrl?: string }>
  | Readonly<{ type: "fillFromPage"; entryId: number }>
  | Readonly<{ type: "fillInTab"; entryId: number; tabId: number }>
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
  matches: readonly EntrySummary[];
  connected: boolean;
}>;

export type Responses = {
  state: VaultState;
  connect: Result<VaultState>;
  signOut: Result<VaultState>;
  unlock: Result<VaultState>;
  lock: Result<VaultState>;
  entries: Result<readonly EntrySummary[]>;
  matches: Result<readonly EntrySummary[]>;
  fillFromPage: Result<Credentials & Readonly<{ autoSubmit: boolean }>>;
  fillInTab: Result<null>;
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

export type FillCommand = Readonly<{
  type: "fill";
  credentials: Credentials;
  entryUrl: string;
  entryHost: string;
  autoSubmit: boolean;
}>;

export type PageCommand =
  | FillCommand
  | Readonly<{ type: "openPicker" }>
  | Readonly<{ type: "fillGenerated"; password: string }>
  | Readonly<{ type: "offerCheck" }>
  | Readonly<{ type: "whereAmI" }>;

export type PageReply = Result<null>;

export const ask = <R extends Request>(request: R): Promise<Responses[R["type"]]> =>
  chrome.runtime.sendMessage(request) as Promise<Responses[R["type"]]>;
