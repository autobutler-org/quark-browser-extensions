import { attachPicker } from "../src/content/picker";
import type { MatchKind, SiteMatch } from "../src/shared/host";

const match = (id: number, name: string, kind: MatchKind, where: string, note = ""): SiteMatch => ({
  id,
  name,
  urlHost: "localhost",
  folderId: null,
  createdAt: "",
  updatedAt: "",
  kind,
  where,
  note,
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
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("attachPicker", () => {
  it("lists this origin's logins first and fallbacks under their own label, with where each was saved", () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(
      field,
      [
        match(1, "NAS", "exact", "localhost:8087/login"),
        match(2, "Router", "otherPort", "localhost:8099/basic.html", "Different port"),
        match(3, "Quark", "otherScheme", "https://localhost:8087", "Saved for https"),
      ],
      "localhost:8087",
      { onPick: () => Promise.resolve(null) },
    );
    picker.open();
    const panel = roots[0]?.querySelector(".panel");
    expect(panel?.querySelector(".host")?.textContent).toBe("localhost:8087");
    const children = [...(panel?.children ?? [])].map((child) => child.textContent);
    expect(children.slice(1)).toEqual([
      "NNASlocalhost:8087/login",
      "Saved for another port or scheme",
      "RRouterlocalhost:8099/basic.html · Different port",
      "QQuarkhttps://localhost:8087 · Saved for https",
    ]);
    picker.destroy();
  });

  it("shows no fallback label when every match is for this origin", () => {
    const roots = openShadows();
    const field = document.createElement("input");
    document.body.append(field);
    const picker = attachPicker(field, [match(1, "NAS", "exact", "localhost:8087")], "localhost:8087", { onPick: () => Promise.resolve(null) });
    picker.open();
    expect(roots[0]?.querySelector(".subhead")).toBeNull();
    picker.destroy();
  });
});
