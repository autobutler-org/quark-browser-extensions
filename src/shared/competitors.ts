export type InstalledExtension = Readonly<{
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  mayDisable: boolean;
}>;

const knownManagers: readonly RegExp[] = [
  /proton\s*pass/i,
  /bitwarden/i,
  /1password/i,
  /lastpass/i,
  /dashlane/i,
  /keeper/i,
  /nordpass/i,
  /roboform/i,
  /enpass/i,
  /keepassxc/i,
  /norton password/i,
  /mcafee true key/i,
];

export const isPasswordManager = (name: string): boolean => knownManagers.some((pattern) => pattern.test(name));

export const findCompetitors = (
  extensions: readonly InstalledExtension[],
  selfId: string,
): readonly InstalledExtension[] =>
  extensions
    .filter((extension) => extension.id !== selfId && extension.type === "extension" && extension.enabled)
    .filter((extension) => isPasswordManager(extension.name))
    .toSorted((a, b) => a.name.localeCompare(b.name));

export type BuiltInState =
  | Readonly<{ kind: "on" }>
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "managed" }>;

export const builtInState = (value: boolean, levelOfControl: string): BuiltInState => {
  if (!value) {
    return { kind: "off" };
  }
  return levelOfControl === "controllable_by_this_extension" || levelOfControl === "controlled_by_this_extension"
    ? { kind: "on" }
    : { kind: "managed" };
};
