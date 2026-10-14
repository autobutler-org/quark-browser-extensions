import type { Request } from "../shared/messages";

// Decides who may ask the service worker for what. Everything here is pure: the extension's own
// identity comes in as `Self`, and the work for each request comes in as handlers, so the checks
// can be tested without a browser.

export type Sender = chrome.runtime.MessageSender;

export type Self = Readonly<{
  id: string;
  // chrome.runtime.getURL(""): the origin the extension's own pages are served from.
  pagesUrl: string;
}>;

type Of<K extends Request["type"]> = Extract<Request, { type: K }>;

const fromExtensionOrigin = (sender: Sender, self: Self): boolean => (sender.url ?? "").startsWith(self.pagesUrl);

export const isExtensionPage = (sender: Sender, self: Self): boolean =>
  sender.id === self.id && fromExtensionOrigin(sender, self);

export const isContentScript = (sender: Sender, self: Self): boolean =>
  sender.id === self.id && !fromExtensionOrigin(sender, self) && sender.tab !== undefined;

export const isTopFrame = (sender: Sender): boolean => sender.frameId === 0;

export const topFrameOnly: ReadonlySet<Request["type"]> = new Set<Request["type"]>(["captured", "myOffer", "resolveSave"]);

export type ExtensionPageHandlers = Readonly<{
  state: () => Promise<unknown>;
  connect: (request: Of<"connect">) => Promise<unknown>;
  signOut: () => Promise<unknown>;
  unlock: (request: Of<"unlock">) => Promise<unknown>;
  lock: () => Promise<unknown>;
  entries: () => Promise<unknown>;
  matches: (request: Of<"matches">) => Promise<unknown>;
  fillInTab: (request: Of<"fillInTab">) => Promise<unknown>;
  reveal: (request: Of<"reveal">) => Promise<unknown>;
  generate: () => Promise<unknown>;
  otp: (request: Of<"otp">) => Promise<unknown>;
  pendingOffer: (request: Of<"pendingOffer">) => Promise<unknown>;
  resolveSave: (request: Of<"resolveSave">) => Promise<unknown>;
  neverSaveList: () => Promise<unknown>;
  removeNeverSave: (request: Of<"removeNeverSave">) => Promise<unknown>;
  settings: () => Promise<unknown>;
  saveSettings: (request: Of<"saveSettings">) => Promise<unknown>;
}>;

export type ContentScriptHandlers = Readonly<{
  hello: (sender: Sender) => Promise<unknown>;
  fieldFocused: (sender: Sender) => Promise<unknown>;
  otpFromPage: (request: Of<"otpFromPage">, sender: Sender) => Promise<unknown>;
  generateForPage: (request: Of<"generateForPage">) => Promise<unknown>;
  captured: (request: Of<"captured">, sender: Sender) => Promise<unknown>;
  myOffer: (sender: Sender) => Promise<unknown>;
  resolveSave: (request: Of<"resolveSave">, tabId: number) => Promise<unknown>;
  matches: (sender: Sender) => Promise<unknown>;
  fillFromPage: (request: Of<"fillFromPage">, sender: Sender) => Promise<unknown>;
}>;

export type Handlers = Readonly<{ pages: ExtensionPageHandlers; content: ContentScriptHandlers }>;

export const forExtensionPages = (
  request: Request,
  sender: Sender,
  self: Self,
  handlers: ExtensionPageHandlers,
): Promise<unknown> | null => {
  if (!isExtensionPage(sender, self)) {
    return null;
  }
  switch (request.type) {
    case "state":
      return handlers.state();
    case "connect":
      return handlers.connect(request);
    case "signOut":
      return handlers.signOut();
    case "unlock":
      return handlers.unlock(request);
    case "lock":
      return handlers.lock();
    case "entries":
      return handlers.entries();
    case "matches":
      return handlers.matches(request);
    case "fillInTab":
      return handlers.fillInTab(request);
    case "reveal":
      return handlers.reveal(request);
    case "generate":
      return handlers.generate();
    case "otp":
      return handlers.otp(request);
    case "pendingOffer":
      return handlers.pendingOffer(request);
    case "resolveSave":
      return handlers.resolveSave(request);
    case "neverSaveList":
      return handlers.neverSaveList();
    case "removeNeverSave":
      return handlers.removeNeverSave(request);
    case "settings":
      return handlers.settings();
    case "saveSettings":
      return handlers.saveSettings(request);
    default:
      return null;
  }
};

export const forContentScripts = (
  request: Request,
  sender: Sender,
  self: Self,
  handlers: ContentScriptHandlers,
): Promise<unknown> | null => {
  if (!isContentScript(sender, self) || (topFrameOnly.has(request.type) && !isTopFrame(sender))) {
    return null;
  }
  switch (request.type) {
    case "hello":
      return handlers.hello(sender);
    case "fieldFocused":
      return handlers.fieldFocused(sender);
    case "otpFromPage":
      return handlers.otpFromPage(request, sender);
    case "generateForPage":
      return handlers.generateForPage(request);
    case "captured":
      return handlers.captured(request, sender);
    case "myOffer":
      return handlers.myOffer(sender);
    case "resolveSave":
      return sender.tab?.id === undefined ? null : handlers.resolveSave(request, sender.tab.id);
    case "matches":
      return handlers.matches(sender);
    case "fillFromPage":
      return handlers.fillFromPage(request, sender);
    default:
      return null;
  }
};

export const route = (request: Request, sender: Sender, self: Self, handlers: Handlers): Promise<unknown> | null =>
  forExtensionPages(request, sender, self, handlers.pages) ?? forContentScripts(request, sender, self, handlers.content);
