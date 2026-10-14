import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeIndexedDB } from "./fakeIndexedDB";

// A small in-memory stand-in for the parts of `chrome` the service worker uses.

type Listener = (...args: never[]) => unknown;

const event = () => {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: (listener: Listener) => {
      listeners.push(listener);
    },
  };
};

export type FakeArea = ReturnType<typeof area>;

const area = () => {
  const items = new Map<string, unknown>();
  return {
    items,
    get: (key: string) => Promise.resolve(items.has(key) ? { [key]: structuredClone(items.get(key)) } : {}),
    set: (values: Record<string, unknown>) => {
      Object.entries(values).forEach(([key, value]) => items.set(key, structuredClone(value)));
      return Promise.resolve();
    },
    remove: (key: string) => {
      items.delete(key);
      return Promise.resolve();
    },
  };
};

type Message = Readonly<{ message: string; placeholders?: Record<string, Readonly<{ content: string }>> }>;

export const enMessages = JSON.parse(
  readFileSync(join(import.meta.dirname, "../static/_locales/en/messages.json"), "utf8"),
) as Record<string, Message>;

// chrome.i18n read from the real English messages.json, so tests see the copy users do. Like the browser, it
// returns "" for an unknown key, matches keys and placeholder names in any case, and fills $1…$9 from the
// substitutions.
export const fakeI18n = (messages: Record<string, Message> = enMessages) => {
  const byKey = new Map(Object.entries(messages).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    getUILanguage: () => "en",
    getMessage: (key: string, substitutions: string | readonly string[] = []): string => {
      const found = byKey.get(key.toLowerCase());
      if (found === undefined) {
        return "";
      }
      const args = typeof substitutions === "string" ? [substitutions] : substitutions;
      const placeholders = new Map(Object.entries(found.placeholders ?? {}).map(([name, value]) => [name.toLowerCase(), value.content]));
      const substitute = (text: string): string => text.replace(/\$(\d)/g, (_, index: string) => args[Number(index) - 1] ?? "");
      return found.message
        .replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name: string) => {
          const content = placeholders.get(name.toLowerCase());
          return content === undefined ? whole : substitute(content);
        })
        .replaceAll("$$", "$");
    },
  };
};

export const extensionId = "quark-vault-id";
export const extensionUrl = `chrome-extension://${extensionId}/`;

export const fakeChrome = () => {
  const onMessage = event();
  // The worker seals a "stay signed in" token with a key kept in its own IndexedDB.
  const idb = fakeIndexedDB();
  const chrome = {
    storage: {
      local: area(),
      session: { ...area(), setAccessLevel: (_options: { accessLevel: string }) => Promise.resolve(undefined as unknown) },
    },
    runtime: { id: extensionId, getURL: (path: string) => `${extensionUrl}${path}`, onMessage },
    commands: { onCommand: event() },
    i18n: fakeI18n(),
    contextMenus: { onClicked: event(), removeAll: () => Promise.resolve(undefined), create: () => undefined },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      sendMessage: () => Promise.resolve(undefined),
      get: (id: number): Promise<chrome.tabs.Tab> => Promise.resolve({ id } as chrome.tabs.Tab),
    },
    idle: { onStateChanged: event(), setDetectionInterval: () => undefined },
    action: {
      setBadgeBackgroundColor: () => Promise.resolve(undefined),
      setBadgeText: () => Promise.resolve(undefined),
      openPopup: () => Promise.resolve(undefined),
    },
  };
  // Sends a message the way chrome.runtime.sendMessage would reach the worker's listener.
  const send = (request: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> | undefined => {
    const listener = onMessage.listeners[0] as
      | ((request: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean)
      | undefined;
    if (listener === undefined) {
      throw new Error("no onMessage listener");
    }
    let respond: (value: unknown) => void = () => undefined;
    const reply = new Promise<unknown>((resolve) => {
      respond = resolve;
    });
    return listener(request, sender, respond) ? reply : undefined;
  };
  return { chrome, send, idb };
};
