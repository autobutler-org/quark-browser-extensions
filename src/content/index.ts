import { errorText } from "../shared/errors";
import { mayFill } from "../shared/host";
import { ask, type FillCommand, type Hello, type PageCommand, type PageReply } from "../shared/messages";
import { err, ok, type Credentials, type EntrySummary } from "../shared/types";
import { fillLogin, passwordFields, submit } from "./forms";
import { attachPicker, type PickerHandle } from "./picker";

const decorated = new WeakMap<HTMLInputElement, PickerHandle>();
let hello: Promise<Hello | null> | null = null;

const greet = (): Promise<Hello | null> => {
  hello ??= ask({ type: "hello" }).catch(() => null);
  return hello;
};

const fill = (credentials: Credentials, autoSubmit: boolean, target: HTMLInputElement | null): boolean => {
  const outcome = fillLogin(document, credentials, target);
  if (outcome.filled && autoSubmit) {
    submit(outcome.form);
  }
  return outcome.filled;
};

const pick =
  (field: HTMLInputElement) =>
  async (entry: EntrySummary): Promise<string | null> => {
    const result = await ask({ type: "fillFromPage", entryId: entry.id });
    if (!result.ok) {
      return result.error.kind === "locked"
        ? "The vault is locked. Unlock it from the Quark Vault toolbar button."
        : errorText(result.error);
    }
    return fill(result.value, result.value.autoSubmit, field) ? null : "Couldn't find the login fields on this page.";
  };

const scan = async (): Promise<void> => {
  const fields = passwordFields(document).filter((field) => !decorated.has(field));
  if (fields.length === 0) {
    return;
  }
  const greeting = await greet();
  if (greeting === null || !greeting.settings.inlineButton || greeting.matches.length === 0) {
    return;
  }
  fields
    .filter((field) => !decorated.has(field))
    .forEach((field) =>
      decorated.set(field, attachPicker(field, greeting.matches, location.hostname, { onPick: pick(field) })),
    );
};

const openPicker = (): PageReply => {
  const active = document.activeElement;
  const focused = active instanceof HTMLInputElement ? decorated.get(active) : undefined;
  const handle = focused ?? passwordFields(document).map((field) => decorated.get(field)).find((found) => found !== undefined);
  if (handle === undefined) {
    return err({ kind: "refused", reason: "No login fields to fill on this page." });
  }
  handle.open();
  return ok(null);
};

const handleFill = (command: FillCommand): PageReply => {
  if (window !== window.top) {
    return err({ kind: "refused", reason: "Filling only happens in the top frame." });
  }
  if (!mayFill(location.href, command.entryUrl, command.entryHost)) {
    return err({ kind: "refused", reason: "This login doesn't belong to this site." });
  }
  return fill(command.credentials, command.autoSubmit, null)
    ? ok(null)
    : err({ kind: "refused", reason: "Couldn't find the login fields on this page." });
};

const handleCommand = (command: PageCommand): PageReply => {
  switch (command.type) {
    case "fill":
      return handleFill(command);
    case "openPicker":
      return openPicker();
  }
};

chrome.runtime.onMessage.addListener((message: PageCommand, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  sendResponse(handleCommand(message));
  return false;
});

document.addEventListener(
  "focusin",
  (event) => {
    if (event.target instanceof HTMLInputElement) {
      void ask({ type: "fieldFocused" }).catch(() => null);
    }
  },
  true,
);

let timer: ReturnType<typeof setTimeout> | undefined;
const scheduleScan = (): void => {
  clearTimeout(timer);
  timer = setTimeout(() => void scan(), 400);
};

new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
void scan();
