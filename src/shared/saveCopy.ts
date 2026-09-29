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
        title: "Save this login to Quark Vault?",
        sub: `${offer.username} on ${offer.host}`,
        actions: [
          ["dismiss", "Not now"],
          ["never", "Never for this site"],
          ["save", "Save"],
        ],
      };
    case "update":
      return {
        title: "Update the password in Quark Vault?",
        sub: `${offer.entryName} · ${offer.username}`,
        actions: [
          ["dismiss", "Not now"],
          ["update", "Update"],
        ],
      };
    case "unlock":
      return {
        title: "Unlock Quark Vault to save this login",
        sub: offer.username === "" ? offer.host : `${offer.username} on ${offer.host}`,
        actions: [
          ["dismiss", "Not now"],
          ["unlock", "Unlock"],
        ],
      };
  }
};
