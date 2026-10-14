import { h } from "../shared/dom";
import { t } from "../shared/i18n";
import { replaceKeepingFocus } from "../popup/focus";
import { builtInState, findCompetitors, type BuiltInState, type InstalledExtension } from "../shared/competitors";
import { browserCopy, currentBrowser } from "../shared/platform";

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
  const copy = browserCopy(currentBrowser());
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
      update({ error: t("othersBlocked", copy.settingsPage) });
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

  // Several rows share a button label, so the name says which row it acts on.
  const button = (label: string, onclick: () => Promise<void>, name = label): HTMLButtonElement =>
    h("button", { className: "secondary", type: "button", "aria-label": name, onclick: (() => void onclick()) as EventListener }, label);

  const builtInRow = (): HTMLElement => {
    const { builtIn } = model;
    const hint =
      builtIn === null
        ? t("othersBuiltInHint")
        : builtIn.kind === "on"
          ? copy.builtInOn
          : builtIn.kind === "managed"
            ? copy.builtInManaged
            : copy.builtInOff;
    const action =
      builtIn === null
        ? button(t("check"), checkBuiltIn, t("checkName", copy.builtInManager))
        : builtIn.kind === "on"
          ? button(t("turnOff"), turnOffBuiltIn, t("turnOffName", copy.builtInManager))
          : null;
    return h(
      "div",
      { className: "toggle" },
      h("div", { className: "grow" }, h("div", {}, copy.builtInManager), h("div", { className: "muted small" }, hint)),
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
            h("div", {}, t("othersExtensions")),
            h("div", { className: "muted small" }, t("othersExtensionsHint")),
          ),
          button(t("check"), checkExtensions, t("othersCheckExtensions")),
        ),
      ];
    }
    if (extensions.length === 0) {
      return [h("div", { className: "toggle" }, h("div", { className: "grow muted" }, t("othersNone")))];
    }
    return extensions.map((extension) =>
      h(
        "div",
        { className: "toggle" },
        h("div", { className: "grow" }, h("div", {}, extension.name), h("div", { className: "muted small" }, t("othersAlsoFills"))),
        !copy.canDisableOthers
          ? h("span", { className: "muted small" }, t("othersTurnOffIn", copy.extensionsPage))
          : extension.mayDisable
            ? button(t("turnOff"), () => turnOffExtension(extension), t("turnOffName", extension.name))
            : h("span", { className: "muted small" }, t("othersManaged")),
      ),
    );
  };

  const render = (): void => {
    replaceKeepingFocus(
      section,
      h("h2", {}, t("othersTitle")),
      h("p", { className: "muted small" }, t("othersIntro", copy.extensionsPage)),
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
