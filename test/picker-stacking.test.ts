import { attachPicker } from "../src/content/picker";

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

// The z-index an anchor paints at. jsdom doesn't cascade shadow stylesheets, so the picker sets it inline.
const zIndex = (root: ShadowRoot): number => {
  const value = Number(root.querySelector<HTMLElement>(".anchor")?.style.zIndex);
  expect(value).toBeGreaterThan(0);
  return value;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("picker stacking", () => {
  // Sign-up pages have a password and a confirm field: the confirm field's button comes later in the DOM, so at
  // an equal z-index it paints over the first field's open panel (#107).
  const signUp = (): { roots: ShadowRoot[]; first: ReturnType<typeof attachPicker> } => {
    const roots = openShadows();
    const [password, confirm] = [document.createElement("input"), document.createElement("input")];
    document.body.append(password, confirm);
    const handlers = { onPick: () => Promise.resolve(null), onSuggest: () => Promise.resolve(null) };
    const first = attachPicker(password, [], "localhost", handlers);
    attachPicker(confirm, [], "localhost", handlers);
    return { roots, first };
  };

  it("raises the open picker above every other inline button", () => {
    const { roots, first } = signUp();
    const [own, other] = roots as [ShadowRoot, ShadowRoot];
    first.open();
    expect(own.querySelector(".panel")).not.toBeNull();
    expect(zIndex(own)).toBeGreaterThan(zIndex(other));
  });

  it("drops back to the shared level once the panel closes", () => {
    const { roots, first } = signUp();
    const [own, other] = roots as [ShadowRoot, ShadowRoot];
    first.open();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(own.querySelector(".panel")).toBeNull();
    expect(zIndex(own)).toBe(zIndex(other));
  });
});
