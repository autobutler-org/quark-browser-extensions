import { attachPicker } from "../src/content/picker";
import type { SiteMatch } from "../src/shared/host";

// jsdom can't make a trusted event, so the test decides what counts as one.
const trust = vi.hoisted(() => ({ value: true }));
vi.mock("../src/content/trusted", () => ({ trusted: () => trust.value }));

const match = (id: number, name: string): SiteMatch => ({
  id,
  name,
  urlHost: "localhost",
  folderId: null,
  createdAt: "",
  updatedAt: "",
  kind: "exact",
  where: "localhost",
  note: "",
});

// The picker's shadow root is closed; open it so the test can look inside.
const openShadows = (): ShadowRoot[] => {
  const roots: ShadowRoot[] = [];
  // Kept unbound on purpose: the mock calls it with each element as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init: ShadowRootInit) {
    const root = original.call(this, { ...init, mode: "open" });
    roots.push(root);
    return root;
  });
  return roots;
};

afterEach(() => {
  trust.value = true;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

// The field with a picker, laid out so the button is shown.
const setup = () => {
  const roots = openShadows();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 10, y: 10, width: 200, height: 30 }));
  const field = document.createElement("input");
  field.type = "password";
  const next = document.createElement("button");
  document.body.append(field, next);
  const picker = attachPicker(field, [match(1, "NAS"), match(2, "Router")], "localhost", { onPick: () => Promise.resolve(null) });
  const root = roots[0] as ShadowRoot;
  const trigger = root.querySelector<HTMLButtonElement>(".trigger") as HTMLButtonElement;
  const press = (target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const focusedName = (): string | null => root.activeElement?.querySelector(".name")?.textContent ?? null;
  return { field, next, picker, root, trigger, press, focusedName };
};

// The button lives at the end of <body>, so the browser's own Tab order skipped it (#116).
describe("reaching the inline picker from the keyboard", () => {
  it("puts the button right after its field in the Tab order", () => {
    const { field, picker, root, trigger, press } = setup();
    field.focus();
    expect(press(field, "Tab").defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(trigger);
    picker.destroy();
  });

  it("goes back to the field on Shift+Tab from the button", () => {
    const { field, picker, trigger, press } = setup();
    trigger.focus();
    expect(press(trigger, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
    picker.destroy();
  });

  it("hands Tab from the button to the browser from the field, so it moves on past it", () => {
    const { field, picker, trigger, press } = setup();
    trigger.focus();
    expect(press(trigger, "Tab").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);
    picker.destroy();
  });

  // Drawn at the end of <body>, the button was also a stop in the page's own Tab order, so Tab from whatever
  // follows the field came back to it, and from it to the field, in a loop the user couldn't Tab out of (#171).
  it("keeps the button out of the page's own Tab order, reachable only from its field", () => {
    const { field, picker, root, trigger, press } = setup();
    expect(trigger.tabIndex).toBe(-1);
    field.focus();
    press(field, "Tab");
    expect(root.activeElement).toBe(trigger);
    picker.destroy();
  });

  it("leaves Shift+Tab and modified Tab in the field alone", () => {
    const { field, picker, press } = setup();
    field.focus();
    expect(press(field, "Tab", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(field, "Tab", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);
    picker.destroy();
  });

  it("leaves Tab alone when the page already handled it", () => {
    const { field, picker, press } = setup();
    field.addEventListener("keydown", (event) => event.preventDefault());
    field.focus();
    press(field, "Tab");
    expect(document.activeElement).toBe(field);
    picker.destroy();
  });

  it("opens with Enter, Space and ArrowDown on the button and Escape returns to the field", () => {
    const { field, picker, root, trigger, press, focusedName } = setup();
    for (const open of [() => trigger.click(), () => press(trigger, "ArrowDown")]) {
      trigger.focus();
      open();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(focusedName()).toBe("NAS");
      expect(press(root.activeElement as Element, "Escape").defaultPrevented).toBe(true);
      expect(root.querySelector(".panel")).toBeNull();
      expect(document.activeElement).toBe(field);
    }
    picker.destroy();
  });

  it("opens from the field with Alt+ArrowDown, as native autocomplete does", () => {
    const { field, picker, root, press, focusedName } = setup();
    field.focus();
    expect(press(field, "ArrowDown", { altKey: true }).defaultPrevented).toBe(true);
    expect(root.querySelector(".panel")).not.toBeNull();
    expect(focusedName()).toBe("NAS");
    picker.destroy();
  });

  it("leaves a plain ArrowDown in the field to the page", () => {
    const { field, picker, root, press } = setup();
    field.focus();
    expect(press(field, "ArrowDown").defaultPrevented).toBe(false);
    expect(root.querySelector(".panel")).toBeNull();
    picker.destroy();
  });

  it("ignores keys the page makes up", () => {
    const { field, picker, root, press } = setup();
    trust.value = false;
    field.focus();
    press(field, "ArrowDown", { altKey: true });
    press(field, "Tab");
    expect(root.querySelector(".panel")).toBeNull();
    expect(document.activeElement).toBe(field);
    picker.destroy();
  });

  it("stops listening to the field once destroyed", () => {
    const { field, picker, press } = setup();
    picker.destroy();
    field.focus();
    expect(press(field, "Tab").defaultPrevented).toBe(false);
    expect(press(field, "ArrowDown", { altKey: true }).defaultPrevented).toBe(false);
  });

  it("doesn't take Tab to a hidden button", () => {
    const { field, picker, press } = setup();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 }));
    field.dispatchEvent(new FocusEvent("focus"));
    field.focus();
    expect(press(field, "Tab").defaultPrevented).toBe(false);
    picker.destroy();
  });
});
