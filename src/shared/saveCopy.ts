import { t } from "./i18n";
import type { SaveAction, SaveOffer } from "../background/save";

export type SaveCopy = Readonly<{
  title: string;
  sub: string;
  actions: readonly (readonly [SaveAction, string])[];
}>;

export const saveBarCopy = (offer: SaveOffer): SaveCopy => {
  switch (offer.kind) {
    case "save":
      return {
        title: t("saveTitle"),
        sub: t("saveSub", offer.username, offer.host),
        actions: [
          ["dismiss", t("notNow")],
          ["never", t("saveNever")],
          ["save", t("saveSave")],
        ],
      };
    case "update":
      return {
        title: t("updateTitle"),
        sub: t("updateSub", offer.entryName, offer.username),
        actions: [
          ["dismiss", t("notNow")],
          ["update", t("updateUpdate")],
        ],
      };
    case "unlock":
      return {
        title: t("unlockToSaveTitle"),
        sub: offer.username === "" ? offer.host : t("saveSub", offer.username, offer.host),
        actions: [
          ["dismiss", t("notNow")],
          ["unlock", t("unlock")],
        ],
      };
  }
};
