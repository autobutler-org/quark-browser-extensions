import { fakeI18n } from "./fakeChrome";
import type { Request } from "../src/shared/messages";
import { defaultSettings, type Settings } from "../src/shared/types";

// The options page talks to the worker only through ask(), so the tests answer for it.
const worker = vi.hoisted((): { settings: unknown; neverSave: string[] } => ({ settings: null, neverSave: [] }));
vi.mock("../src/shared/messages", () => ({
  ask: (request: Request) => Promise.resolve(answer(request)),
}));

const answer = (request: Request): unknown => {
  switch (request.type) {
    case "state":
      return { kind: "unlocked", server: "https://quark.local", autoLockSeconds: 0 };
    case "settings":
      return worker.settings;
    case "saveSettings":
      worker.settings = request.settings;
      return request.settings;
    case "neverSaveList":
      return worker.neverSave;
    case "removeNeverSave":
      worker.neverSave = worker.neverSave.filter((host) => host !== request.host);
      return undefined;
    default:
      return undefined;
  }
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const openOptions = async (hash = ""): Promise<HTMLElement> => {
  window.location.hash = hash;
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  await import("../src/options/index");
  await vi.waitFor(() => expect(document.querySelector("main")).not.toBeNull());
  await settle();
  return document.getElementById("app")!;
};

const named = (app: HTMLElement, name: string): HTMLButtonElement => {
  const found = [...app.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === name);
  expect(found, name).toBeDefined();
  return found!;
};

const passwordSaving = { value: true, levelOfControl: "controllable_by_this_extension" };

beforeEach(() => {
  worker.settings = { ...defaultSettings, othersReviewed: true } satisfies Settings;
  worker.neverSave = ["example.com", "bank.test"];
  vi.stubGlobal("chrome", {
    i18n: fakeI18n(),
    runtime: { id: "quark", getURL: (path: string) => `chrome-extension://quark/${path}` },
    tabs: { create: () => Promise.resolve() },
    commands: { getAll: () => Promise.resolve([]) },
    permissions: { contains: () => Promise.resolve(false), request: () => Promise.resolve(true) },
    privacy: { services: { passwordSavingEnabled: { get: () => Promise.resolve(passwordSaving), set: () => Promise.resolve() } } },
    management: { getAll: () => Promise.resolve([]), setEnabled: () => Promise.resolve() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.location.hash = "";
});

describe("the options page", () => {
  it("names each checkbox by its title and reads its hint as the description", async () => {
    const app = await openOptions();
    const box = app.querySelector<HTMLInputElement>("#autoSubmit")!;
    const text = (ids: string): string => ids.split(" ").map((id) => document.getElementById(id)?.textContent).join(" ");
    expect(text(box.getAttribute("aria-labelledby")!)).toBe("Submit the form after filling");
    expect(text(box.getAttribute("aria-describedby")!)).toBe("Off by default. Some sites need a second look first.");
    expect(app.querySelector("#badge")!.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps focus on a checkbox after the page re-renders with the saved setting", async () => {
    const app = await openOptions();
    const box = app.querySelector<HTMLInputElement>("#autoSubmit")!;
    box.focus();
    box.click();
    await vi.waitFor(() => expect(app.querySelector("#autoSubmit")).not.toBe(box));
    expect(document.activeElement).toBe(app.querySelector("#autoSubmit"));
    expect((document.activeElement as HTMLInputElement).checked).toBe(true);
  });

  it("says which site each Remove button acts on, and keeps focus in the list after one goes", async () => {
    const app = await openOptions();
    const remove = named(app, "Remove example.com");
    named(app, "Remove bank.test");
    remove.focus();
    remove.click();
    await vi.waitFor(() => expect(app.textContent).not.toContain("example.com"));
    expect(document.activeElement?.id).toBe("never-save");
  });

  it("says which manager each Check and Turn off button acts on, and keeps focus in the section", async () => {
    const app = await openOptions();
    named(app, "Check password manager extensions");
    const check = named(app, "Check Google Password Manager");
    check.focus();
    check.click();
    await vi.waitFor(() => named(app, "Turn off Google Password Manager"));
    expect(document.activeElement?.id).toBe("others");
  });

  it("lands on the linked section with focus there", async () => {
    Element.prototype.scrollIntoView = () => undefined;
    await openOptions("#shortcut");
    await vi.waitFor(() => expect(document.activeElement?.id).toBe("shortcut"));
  });
});
