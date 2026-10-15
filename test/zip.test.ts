// @vitest-environment node
import { deflateRawSync } from "node:zlib";
import { checkExtension, checkSources, diffFiles, MAX_ZIP_BYTES, readZip, zipKind } from "../scripts/verify-zip.js";

// A PNG header claiming `size`×`size`: all checkExtension reads of an icon.
const png = (size: number): Buffer => {
  const data = Buffer.alloc(24);
  data.writeUInt32BE(0x89504e47, 0);
  data.writeUInt32BE(0x0d0a1a0a, 4);
  data.write("IHDR", 12);
  data.writeUInt32BE(size, 16);
  data.writeUInt32BE(size, 20);
  return data;
};

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

// The manifest keys these tests change.
type Manifest = {
  manifest_version: number;
  name: string;
  version: string;
  description?: string;
  default_locale?: string;
  icons: Record<string, string>;
  permissions: string[];
  host_permissions: string[];
  action: { default_icon: Record<string, string>; default_popup: string };
  background: { service_worker?: string; scripts?: string[] };
  options_page: string;
  options_ui?: { page: string };
  content_scripts: { matches: string[]; js: string[]; css?: string[] }[];
  web_accessible_resources: { resources: string[]; matches: string[] }[];
  content_security_policy: { extension_pages: string };
  browser_specific_settings?: {
    gecko: { id?: string; strict_min_version?: string };
    gecko_android?: { strict_min_version?: string };
  };
};

// A small extension shaped like the one `wxt zip` makes, before `change` edits its manifest.
const extension = (change: (manifest: Manifest) => void = () => {}): Map<string, Buffer> => {
  const manifest: Manifest = {
    manifest_version: 3,
    name: "__MSG_extName__",
    version: "1.2.3",
    default_locale: "en",
    icons: { "16": "icons/icon-16.png", "128": "icons/icon-128.png" },
    permissions: ["storage"],
    host_permissions: ["https://*/*"],
    action: { default_icon: { "16": "icons/icon-16.png" }, default_popup: "popup.html" },
    background: { service_worker: "background.js" },
    options_page: "options.html",
    content_scripts: [{ matches: ["https://*/*"], js: ["content-scripts/content.js"] }],
    web_accessible_resources: [{ resources: ["assets/*.css"], matches: ["https://*/*"] }],
    content_security_policy: { extension_pages: "script-src 'self'" },
    browser_specific_settings: {
      gecko: { id: "vault@example.org", strict_min_version: "140.0" },
      gecko_android: { strict_min_version: "142.0" },
    },
  };
  change(manifest);
  return new Map([
    ["manifest.json", json(manifest)],
    ["_locales/en/messages.json", json({ extName: { message: "Vault" } })],
    ["icons/icon-16.png", png(16)],
    ["icons/icon-128.png", png(128)],
    ["background.js", Buffer.from("console.log(1);\n")],
    ["content-scripts/content.js", Buffer.from("(()=>{})();\n")],
    ["popup.html", Buffer.from('<link rel="stylesheet" href="/popup.css"><script src="/chunks/popup.js"></script>')],
    ["popup.css", Buffer.from("")],
    ["chunks/popup.js", Buffer.from("")],
    ["options.html", Buffer.from('<a href="https://example.org">x</a>')],
    ["assets/frame.css", Buffer.from("")],
  ]);
};

const check = (files: Map<string, Buffer>, browser = "firefox", zipBytes = 1000) =>
  checkExtension(files, { version: "1.2.3", browser, zipBytes });

// Builds a zip from `files`, deflating the ones named in `deflate` and storing the rest.
const zip = (files: Record<string, string>, deflate: readonly string[] = []): Buffer => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const method = deflate.includes(name) ? 8 : 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

describe("verify-zip", () => {
  it("reads stored and deflated files and skips directories", () => {
    const files = readZip(zip({ "a/": "", "a/b.txt": "stored", "c.json": "deflated ".repeat(50) }, ["c.json"]));
    expect([...files.keys()]).toEqual(["a/b.txt", "c.json"]);
    expect(files.get("a/b.txt")?.toString()).toBe("stored");
    expect(files.get("c.json")?.toString()).toBe("deflated ".repeat(50));
    expect(() => readZip(Buffer.from("not a zip"))).toThrow("not a zip");
  });

  it("tells each store's zip apart by WXT's artifact name", () => {
    expect(zipKind(".output/quark-vault-chrome.zip")).toBe("chrome");
    expect(zipKind(".output/quark-vault-firefox.zip")).toBe("firefox");
    expect(zipKind(".output/quark-vault-edge.zip")).toBe("edge");
    expect(zipKind(".output/quark-vault-sources.zip")).toBe("sources");
  });

  it("passes a complete extension", () => {
    expect(check(extension())).toEqual([]);
    expect(check(extension((m) => delete m.browser_specific_settings), "chrome")).toEqual([]);
  });

  it("wants MV3 at package.json's version", () => {
    expect(check(extension((m) => (m.manifest_version = 2)))).toEqual(["manifest_version is 2, not 3"]);
    expect(check(extension((m) => (m.version = "1.2.2")))).toEqual(["manifest version 1.2.2 is not package.json's 1.2.3"]);
    expect(check(new Map())).toEqual(["has no manifest.json at its root"]);
  });

  it("refuses sourcemaps and test files", () => {
    const files = extension();
    files.set("background.js.map", Buffer.from("{}"));
    files.set("chunks/popup.js", Buffer.from("x();\n//# sourceMappingURL=popup.js.map\n"));
    files.set("test/setup.js", Buffer.from(""));
    files.set("chunks/forms.spec.js", Buffer.from(""));
    expect(check(files)).toEqual([
      "chunks/popup.js links a sourcemap",
      "ships the sourcemap background.js.map",
      "ships the test file test/setup.js",
      "ships the test file chunks/forms.spec.js",
    ]);
  });

  it("refuses the localhost access a dev build adds", () => {
    const files = extension((m) => {
      m.host_permissions.push("http://localhost/*");
      m.permissions.push("http://127.0.0.1/*");
      m.content_scripts[0]?.matches.push("ws://example.org/*");
      m.content_security_policy.extension_pages = "script-src 'self' http://localhost:3000";
    });
    expect(check(files)).toEqual([
      "host_permissions has the dev-only http://localhost/*",
      "permissions has the dev-only http://127.0.0.1/*",
      "content_scripts[0].matches has the dev-only ws://example.org/*",
      "content_security_policy allows a dev server: script-src 'self' http://localhost:3000",
    ]);
  });

  it("wants every declared icon, at its declared size", () => {
    const files = extension((m) => (m.icons["48"] = "icons/icon-48.png"));
    files.set("icons/icon-128.png", png(64));
    files.set("icons/icon-16.png", Buffer.from("GIF89a"));
    expect(check(files)).toEqual([
      "icons 16: icons/icon-16.png is not a PNG",
      "icons 48: icons/icon-48.png is missing",
      "icons 128: icons/icon-128.png is 64x64",
      "action.default_icon 16: icons/icon-16.png is not a PNG",
    ]);
  });

  it("wants every file the manifest and its pages name", () => {
    const files = extension((m) => {
      m.background = { scripts: ["background.js", "gone.js"] };
      m.options_ui = { page: "settings.html" };
      m.content_scripts[0]!.css = ["content.css"];
      m.web_accessible_resources[0]?.resources.push("fonts/*.woff2");
    });
    files.delete("chunks/popup.js");
    expect(check(files)).toEqual([
      "background.scripts names gone.js, which is missing",
      "options_ui.page names settings.html, which is missing",
      "content_scripts[0] names content.css, which is missing",
      "web_accessible_resources[0] names fonts/*.woff2, which matches no file",
      "popup.html loads /chunks/popup.js, which is missing",
    ]);
  });

  it("wants the default locale's messages for every __MSG_x__", () => {
    const missingKey = extension((m) => (m.description = "__MSG_extDescription__"));
    expect(check(missingKey)).toEqual(["the manifest uses __MSG_extDescription__, which _locales/en lacks"]);

    const noLocaleFile = extension();
    noLocaleFile.delete("_locales/en/messages.json");
    expect(check(noLocaleFile)).toEqual(["default_locale is en but _locales/en/messages.json is missing"]);

    expect(check(extension((m) => delete m.default_locale))).toEqual([
      "has _locales but no default_locale",
      "uses __MSG_extName__ but has no default_locale",
    ]);

    const broken = extension();
    broken.set("_locales/de/messages.json", Buffer.from("{"));
    expect(check(broken)).toHaveLength(1);
    expect(check(broken)[0]).toMatch(/^_locales\/de\/messages\.json is not JSON/);
  });

  it("flags a zip over 5 MB", () => {
    expect(check(extension(), "chrome", MAX_ZIP_BYTES + 1)).toEqual(["is 5.0 MB, over the 5 MB we allow"]);
    expect(check(extension(), "chrome", MAX_ZIP_BYTES)).toEqual([]);
  });

  it("wants the gecko id and strict_min_version in the Firefox zip alone", () => {
    const noGecko = extension((m) => (m.browser_specific_settings = { gecko: {} }));
    expect(check(noGecko, "firefox")).toEqual([
      "has no browser_specific_settings.gecko.id",
      "has no browser_specific_settings.gecko.strict_min_version",
      "has no browser_specific_settings.gecko_android.strict_min_version",
    ]);
    expect(check(noGecko, "chrome")).toEqual([]);
  });

  it("wants Firefox 140 or later, the first that reads data_collection_permissions", () => {
    const at = (version: string) =>
      extension((m) => {
        m.browser_specific_settings = {
          gecko: { id: "vault@example.org", strict_min_version: version },
          gecko_android: { strict_min_version: "142.0" },
        };
      });
    expect(check(at("128.0"), "firefox")).toEqual([
      "has browser_specific_settings.gecko.strict_min_version 128.0; Firefox before 140 ignores data_collection_permissions",
    ]);
    expect(check(at("139.0a1"), "firefox")).toHaveLength(1);
    expect(check(at("140.0"), "firefox")).toEqual([]);
    expect(check(at("141"), "firefox")).toEqual([]);
  });

  it("wants Firefox for Android 142 or later, the first that reads data_collection_permissions", () => {
    const at = (version: string | undefined) =>
      extension((m) => {
        m.browser_specific_settings = {
          gecko: { id: "vault@example.org", strict_min_version: "140.0" },
          ...(version === undefined
            ? {}
            : { gecko_android: { strict_min_version: version } }),
        };
      });
    expect(check(at(undefined), "firefox")).toEqual([
      "has no browser_specific_settings.gecko_android.strict_min_version",
    ]);
    expect(check(at("141.0"), "firefox")).toEqual([
      "has browser_specific_settings.gecko_android.strict_min_version 141.0; Firefox for Android before 142 ignores data_collection_permissions",
    ]);
    expect(check(at("142.0"), "firefox")).toEqual([]);
    expect(check(at("143"), "firefox")).toEqual([]);
  });

  it("wants the sources zip to hold what the AMO build needs and no build output", () => {
    const sources = new Map(
      ["package.json", "package-lock.json", "wxt.config.ts", "docs/store/amo-notes.md"].map((name) => [name, Buffer.from("")]),
    );
    expect(checkSources(sources, { zipBytes: 1000 })).toEqual([]);
    sources.delete("package-lock.json");
    sources.set("node_modules/wxt/index.js", Buffer.from(""));
    sources.set(".env.local", Buffer.from(""));
    expect(checkSources(sources)).toEqual([
      "has no package-lock.json, which the AMO build steps need",
      "ships the build directory file node_modules/wxt/index.js",
      "ships the env file .env.local",
    ]);
  });

  it("lists every file a rebuild adds, drops or changes", () => {
    const submitted = new Map([
      ["a.js", Buffer.from("a")],
      ["b.js", Buffer.from("b")],
      ["c.js", Buffer.from("c")],
    ]);
    const rebuilt = new Map([
      ["a.js", Buffer.from("a")],
      ["b.js", Buffer.from("B")],
      ["d.js", Buffer.from("d")],
    ]);
    expect(diffFiles(submitted, submitted)).toEqual([]);
    expect(diffFiles(submitted, rebuilt)).toEqual([
      "b.js differs in the rebuild",
      "c.js is missing from the rebuild",
      "d.js is only in the rebuild",
    ]);
  });
});
