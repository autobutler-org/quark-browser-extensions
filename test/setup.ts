import { fakeI18n } from "./fakeChrome";

// Every module reads its copy through chrome.i18n, so even a test that never stubs `chrome` gets the English text.
globalThis.chrome = { i18n: fakeI18n() } as unknown as typeof chrome;
