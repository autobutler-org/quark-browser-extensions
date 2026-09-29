import { h } from "../shared/dom";
import { builtInState, findCompetitors, type BuiltInState, type InstalledExtension } from "../shared/competitors";

type Model = Readonly<{
  builtIn: BuiltInState | null;
  extensions: readonly InstalledExtension[] | null;
  error: string;
}>;

const readBuiltIn = async (): Promise<BuiltInState> => {
  const setting = await chrome.privacy.services.passwordSavingEnabled.get({});
  return builtInState(setting.value === true, setting.levelOfControl);
};

const readExtensions = async (): Promise<readonly InstalledExtension[]> => {
  const all = await chrome.management.getAll();
  return findCompetitors(
    all.map((info) => ({
      id: info.id,
      name: info.name,
      enabled: info.enabled,
      type: info.type,
      mayDisable: info.mayDisable,
    })),
    chrome.runtime.id,
  );
};

const request = (permission: "privacy" | "management"): Promise<boolean> =>
  chrome.permissions.request({ permissions: [permission] });

const has = (permission: "privacy" | "management"): Promise<boolean> =>
  chrome.permissions.contains({ permissions: [permission] });

export const othersSection = (): HTMLElement => {
  const section = h("section", { className: "card", id: "others" });
  let model: Model = { builtIn: null, extensions: null, error: "" };

  const update = (patch: Partial<Model>): void => {
    model = { ...model, ...patch };
    render();
  };

  const guard = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch {
      update({ error: "Chrome didn't allow that change. Try it from chrome://settings instead." });
    }
  };

  const checkBuiltIn = () =>
    guard(async () => {
      if ((await has("privacy")) || (await request("privacy"))) {
        update({ builtIn: await readBuiltIn(), error: "" });
      }
    });

  const turnOffBuiltIn = () =>
    guard(async () => {
      await chrome.privacy.services.passwordSavingEnabled.set({ value: false });
      update({ builtIn: await readBuiltIn(), error: "" });
    });

  const checkExtensions = () =>
    guard(async () => {
      if ((await has("management")) || (await request("management"))) {
        update({ extensions: await readExtensions(), error: "" });
      }
    });

  const turnOffExtension = (extension: InstalledExtension) =>
    guard(async () => {
      await chrome.management.setEnabled(extension.id, false);
      update({ extensions: await readExtensions(), error: "" });
    });

  const button = (label: string, onclick: () => Promise<void>): HTMLButtonElement =>
    h("button", { className: "secondary", type: "button", onclick: (() => void onclick()) as EventListener }, label);

  const builtInRow = (): HTMLElement => {
    const { builtIn } = model;
    const hint =
      builtIn === null
        ? "Chrome can offer to save and fill passwords too."
        : builtIn.kind === "on"
          ? "Chrome is still offering to save passwords."
          : builtIn.kind === "managed"
            ? "Chrome's password saving is set by your organization or another extension."
            : "Chrome's password saving is off.";
    const action =
      builtIn === null ? button("Check", checkBuiltIn) : builtIn.kind === "on" ? button("Turn off", turnOffBuiltIn) : null;
    return h(
      "div",
      { className: "toggle" },
      h("div", { className: "grow" }, h("div", {}, "Google Password Manager"), h("div", { className: "muted small" }, hint)),
      action,
    );
  };

  const extensionRows = (): readonly HTMLElement[] => {
    const { extensions } = model;
    if (extensions === null) {
      return [
        h(
          "div",
          { className: "toggle" },
          h(
            "div",
            { className: "grow" },
            h("div", {}, "Password manager extensions"),
            h("div", { className: "muted small" }, "Proton Pass, Bitwarden, 1Password and others"),
          ),
          button("Check", checkExtensions),
        ),
      ];
    }
    if (extensions.length === 0) {
      return [h("div", { className: "toggle" }, h("div", { className: "grow muted" }, "No other password manager extensions are turned on."))];
    }
    return extensions.map((extension) =>
      h(
        "div",
        { className: "toggle" },
        h("div", { className: "grow" }, h("div", {}, extension.name), h("div", { className: "muted small" }, "Also fills logins")),
        extension.mayDisable ? button("Turn off", () => turnOffExtension(extension)) : h("span", { className: "muted small" }, "Managed by your organization"),
      ),
    );
  };

  const render = (): void => {
    section.replaceChildren(
      h("h2", {}, "Other password managers"),
      h("p", { className: "muted small" }, "More than one manager filling the same form gets confusing. Turning one off keeps its saved passwords; you can turn it back on from chrome://extensions."),
      builtInRow(),
      ...extensionRows(),
      ...(model.error === "" ? [] : [h("div", { className: "error-box", role: "alert" }, model.error)]),
    );
  };

  void Promise.all([has("privacy"), has("management")]).then(async ([privacy, management]) => {
    update({
      builtIn: privacy ? await readBuiltIn() : null,
      extensions: management ? await readExtensions() : null,
    });
  });
  render();
  return section;
};
