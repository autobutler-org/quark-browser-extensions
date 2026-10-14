import {
  forContentScripts,
  forExtensionPages,
  isContentScript,
  isExtensionPage,
  isTopFrame,
  route,
  topFrameOnly,
  type ContentScriptHandlers,
  type ExtensionPageHandlers,
  type Handlers,
  type Self,
  type Sender,
} from "../src/background/gate";
import type { Request } from "../src/shared/messages";
import { defaultSettings } from "../src/shared/types";

const self: Self = { id: "quark-vault-id", pagesUrl: "chrome-extension://quark-vault-id/" };

const tab = (id?: number): chrome.tabs.Tab => ({ id }) as chrome.tabs.Tab;

const popup: Sender = { id: self.id, url: "chrome-extension://quark-vault-id/popup.html" };
const options: Sender = { id: self.id, url: "chrome-extension://quark-vault-id/options.html", tab: tab(7) };
const topFrame: Sender = { id: self.id, url: "https://github.com/login", tab: tab(7), frameId: 0 };
const subFrame: Sender = { id: self.id, url: "https://github.com/frame", tab: tab(7), frameId: 3 };

// Senders that must never reach either handler.
const strangers: Record<string, Sender> = {
  "another extension's page": { id: "other-id", url: "chrome-extension://other-id/popup.html" },
  "another extension's content script": { id: "other-id", url: "https://github.com/login", tab: tab(7), frameId: 0 },
  "a sender with no id": { url: "chrome-extension://quark-vault-id/popup.html" },
  "a web page with no tab": { id: self.id, url: "https://github.com/login", frameId: 0 },
  "a page with no url and no tab": { id: self.id },
  "a look-alike extension origin": { id: self.id, url: "chrome-extension://quark-vault-id.evil.io/popup.html" },
  "a web page whose path mentions the extension": {
    id: self.id,
    url: "https://evil.io/chrome-extension://quark-vault-id/",
    frameId: 0,
  },
};

// One request of every type. Typed as a Record so a new Request type fails to compile here until
// the tables below say who may send it.
const requests: { [K in Request["type"]]: Extract<Request, { type: K }> } = {
  state: { type: "state" },
  connect: { type: "connect", server: "quark.local", username: "u", password: "p", persist: false, allowInsecure: false },
  signOut: { type: "signOut" },
  unlock: { type: "unlock", masterPassword: "m" },
  lock: { type: "lock" },
  entries: { type: "entries" },
  matches: { type: "matches", pageUrl: "https://github.com/" },
  fillFromPage: { type: "fillFromPage", entryId: 1 },
  fillInTab: { type: "fillInTab", entryId: 1, tabId: 7 },
  reveal: { type: "reveal", entryId: 1 },
  generate: { type: "generate" },
  settings: { type: "settings" },
  saveSettings: { type: "saveSettings", settings: defaultSettings },
  hello: { type: "hello" },
  fieldFocused: { type: "fieldFocused" },
  otpFromPage: { type: "otpFromPage", entryId: 1 },
  otp: { type: "otp", entryId: 1 },
  generateForPage: { type: "generateForPage", length: 20 },
  captured: { type: "captured", username: "u", password: "p" },
  myOffer: { type: "myOffer" },
  pendingOffer: { type: "pendingOffer", tabId: 7 },
  resolveSave: { type: "resolveSave", action: "save" },
  neverSaveList: { type: "neverSaveList" },
  removeNeverSave: { type: "removeNeverSave", host: "github.com" },
};

const allTypes = Object.keys(requests) as Request["type"][];

type Audience = "pages" | "content" | "both" | "nobody";

// Who each request type is for. Anything that hands out a secret or changes the vault is "pages".
const audience: Record<Request["type"], Audience> = {
  state: "pages",
  connect: "pages",
  signOut: "pages",
  unlock: "pages",
  lock: "pages",
  entries: "pages",
  matches: "both",
  fillFromPage: "content",
  fillInTab: "pages",
  reveal: "pages",
  generate: "pages",
  settings: "pages",
  saveSettings: "pages",
  hello: "content",
  fieldFocused: "content",
  otpFromPage: "content",
  otp: "pages",
  generateForPage: "content",
  captured: "content",
  myOffer: "content",
  pendingOffer: "pages",
  resolveSave: "both",
  neverSaveList: "pages",
  removeNeverSave: "pages",
};

const pagesAccept = (type: Request["type"]): boolean => audience[type] === "pages" || audience[type] === "both";
const contentAccepts = (type: Request["type"]): boolean => audience[type] === "content" || audience[type] === "both";

type Call = Readonly<{ handler: string; args: readonly unknown[] }>;

// Handlers that record which one ran and with what, and resolve to their own name.
const recorder = <T extends object>(names: readonly (keyof T & string)[]) => {
  const calls: Call[] = [];
  const handlers = Object.fromEntries(
    names.map((name) => [
      name,
      (...args: unknown[]) => {
        calls.push({ handler: name, args });
        return Promise.resolve(name);
      },
    ]),
  ) as T;
  return { calls, handlers };
};

const pageHandlerNames = [
  "state",
  "connect",
  "signOut",
  "unlock",
  "lock",
  "entries",
  "matches",
  "fillInTab",
  "reveal",
  "generate",
  "otp",
  "pendingOffer",
  "resolveSave",
  "neverSaveList",
  "removeNeverSave",
  "settings",
  "saveSettings",
] as const satisfies readonly (keyof ExtensionPageHandlers)[];

const contentHandlerNames = [
  "hello",
  "fieldFocused",
  "otpFromPage",
  "generateForPage",
  "captured",
  "myOffer",
  "resolveSave",
  "matches",
  "fillFromPage",
] as const satisfies readonly (keyof ContentScriptHandlers)[];

const setup = () => {
  const pages = recorder<ExtensionPageHandlers>(pageHandlerNames);
  const content = recorder<ContentScriptHandlers>(contentHandlerNames);
  const handlers: Handlers = { pages: pages.handlers, content: content.handlers };
  return { pages: pages.calls, content: content.calls, handlers };
};

type SenderCase = readonly [string, Sender, boolean];

const strangerCases: readonly SenderCase[] = Object.entries(strangers).map(([name, sender]) => [name, sender, false]);

describe("isExtensionPage", () => {
  it.each<SenderCase>([
    ["the popup", popup, true],
    ["the options page in a tab", options, true],
    ["a content script", topFrame, false],
    ...strangerCases,
  ])("%s → %s", (_, sender, expected) => {
    expect(isExtensionPage(sender, self)).toBe(expected);
  });
});

describe("isContentScript", () => {
  it.each<SenderCase>([
    ["a top frame", topFrame, true],
    ["a sub frame", subFrame, true],
    ["a tab whose id is unknown", { ...topFrame, tab: tab() }, true],
    ["the popup", popup, false],
    ["the options page in a tab", options, false],
    ...strangerCases,
  ])("%s → %s", (_, sender, expected) => {
    expect(isContentScript(sender, self)).toBe(expected);
  });
});

describe("isTopFrame", () => {
  it.each<SenderCase>([
    ["frame 0", topFrame, true],
    ["a sub frame", subFrame, false],
    ["no frame id", popup, false],
  ])("%s → %s", (_, sender, expected) => {
    expect(isTopFrame(sender)).toBe(expected);
  });
});

describe("topFrameOnly", () => {
  it("covers the save flow", () => {
    expect([...topFrameOnly].toSorted()).toEqual(["captured", "myOffer", "resolveSave"]);
  });
});

describe("route", () => {
  describe("from the extension's own pages", () => {
    it.each(allTypes)("%s", (type) => {
      const { pages, content, handlers } = setup();
      const pending = route(requests[type], popup, self, handlers);
      expect(content).toEqual([]);
      if (pagesAccept(type)) {
        expect(pending).not.toBeNull();
        expect(pages.map((call) => call.handler)).toEqual([type]);
      } else {
        expect(pending).toBeNull();
        expect(pages).toEqual([]);
      }
    });

    it("hands each page handler the request", async () => {
      const { pages, handlers } = setup();
      await route(requests.unlock, popup, self, handlers);
      await route(requests.state, options, self, handlers);
      expect(pages).toEqual([
        { handler: "unlock", args: [requests.unlock] },
        { handler: "state", args: [] },
      ]);
    });

    it("resolves to the handler's answer", async () => {
      const { handlers } = setup();
      await expect(route(requests.reveal, popup, self, handlers)).resolves.toBe("reveal");
    });
  });

  describe("from a content script in the top frame", () => {
    it.each(allTypes)("%s", (type) => {
      const { pages, content, handlers } = setup();
      const pending = route(requests[type], topFrame, self, handlers);
      expect(pages).toEqual([]);
      if (contentAccepts(type)) {
        expect(pending).not.toBeNull();
        expect(content.map((call) => call.handler)).toEqual([type]);
      } else {
        expect(pending).toBeNull();
        expect(content).toEqual([]);
      }
    });

    it("passes the sender, not the request's own claims, to the handlers", async () => {
      const { content, handlers } = setup();
      await route({ type: "matches", pageUrl: "https://bank.example/" }, topFrame, self, handlers);
      await route(requests.fillFromPage, topFrame, self, handlers);
      await route(requests.otpFromPage, topFrame, self, handlers);
      await route(requests.captured, topFrame, self, handlers);
      await route(requests.hello, topFrame, self, handlers);
      await route(requests.fieldFocused, topFrame, self, handlers);
      await route(requests.myOffer, topFrame, self, handlers);
      await route(requests.generateForPage, topFrame, self, handlers);
      expect(content).toEqual([
        { handler: "matches", args: [topFrame] },
        { handler: "fillFromPage", args: [requests.fillFromPage, topFrame] },
        { handler: "otpFromPage", args: [requests.otpFromPage, topFrame] },
        { handler: "captured", args: [requests.captured, topFrame] },
        { handler: "hello", args: [topFrame] },
        { handler: "fieldFocused", args: [topFrame] },
        { handler: "myOffer", args: [topFrame] },
        { handler: "generateForPage", args: [requests.generateForPage] },
      ]);
    });

    it("saves for the sender's tab, ignoring a tab id in the request", async () => {
      const { content, handlers } = setup();
      await route({ type: "resolveSave", action: "never", tabId: 99 }, topFrame, self, handlers);
      expect(content).toEqual([{ handler: "resolveSave", args: [{ type: "resolveSave", action: "never", tabId: 99 }, 7] }]);
    });

    it("drops resolveSave from a tab whose id is unknown", () => {
      const { content, handlers } = setup();
      expect(route(requests.resolveSave, { ...topFrame, tab: tab() }, self, handlers)).toBeNull();
      expect(content).toEqual([]);
    });
  });

  describe("from a content script in a sub frame", () => {
    it.each(allTypes)("%s", (type) => {
      const { pages, content, handlers } = setup();
      const pending = route(requests[type], subFrame, self, handlers);
      expect(pages).toEqual([]);
      if (contentAccepts(type) && !topFrameOnly.has(type)) {
        expect(pending).not.toBeNull();
        expect(content.map((call) => call.handler)).toEqual([type]);
      } else {
        expect(pending).toBeNull();
        expect(content).toEqual([]);
      }
    });

    it("treats a sender with no frame id as a sub frame", () => {
      const { content, handlers } = setup();
      const { frameId: _, ...noFrame } = topFrame;
      expect(route(requests.captured, noFrame, self, handlers)).toBeNull();
      expect(content).toEqual([]);
    });
  });

  describe.each(Object.entries(strangers))("from %s", (_, sender) => {
    it.each(allTypes)("drops %s", (type) => {
      const { pages, content, handlers } = setup();
      expect(route(requests[type], sender, self, handlers)).toBeNull();
      expect(pages).toEqual([]);
      expect(content).toEqual([]);
    });
  });

  it("drops a request type it doesn't know", () => {
    const { pages, content, handlers } = setup();
    const unknown = { type: "dumpVault" } as unknown as Request;
    expect(route(unknown, popup, self, handlers)).toBeNull();
    expect(route(unknown, topFrame, self, handlers)).toBeNull();
    expect(pages).toEqual([]);
    expect(content).toEqual([]);
  });
});

describe("forExtensionPages and forContentScripts", () => {
  it("each check their own sender", () => {
    const { handlers } = setup();
    expect(forExtensionPages(requests.state, topFrame, self, handlers.pages)).toBeNull();
    expect(forContentScripts(requests.hello, popup, self, handlers.content)).toBeNull();
    expect(forExtensionPages(requests.state, popup, self, handlers.pages)).not.toBeNull();
    expect(forContentScripts(requests.hello, topFrame, self, handlers.content)).not.toBeNull();
  });
});
