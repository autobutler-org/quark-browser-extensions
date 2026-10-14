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
    get: async (key: string) => (items.has(key) ? { [key]: structuredClone(items.get(key)) } : {}),
    set: async (values: Record<string, unknown>) => {
      Object.entries(values).forEach(([key, value]) => items.set(key, structuredClone(value)));
    },
    remove: async (key: string) => {
      items.delete(key);
    },
  };
};

export const extensionId = "quark-vault-id";
export const extensionUrl = `chrome-extension://${extensionId}/`;

export const fakeChrome = () => {
  const onMessage = event();
  const chrome = {
    storage: { local: area(), session: area() },
    runtime: { id: extensionId, getURL: (path: string) => `${extensionUrl}${path}`, onMessage },
    commands: { onCommand: event() },
    contextMenus: { onClicked: event(), removeAll: async () => undefined, create: () => undefined },
    tabs: { onUpdated: event(), onRemoved: event(), sendMessage: async () => undefined },
    idle: { onStateChanged: event(), setDetectionInterval: () => undefined },
    action: {
      setBadgeBackgroundColor: async () => undefined,
      setBadgeText: async () => undefined,
      openPopup: async () => undefined,
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
  return { chrome, send };
};
