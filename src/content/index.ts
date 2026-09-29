import { errorText } from "../shared/errors";
import { mayFill } from "../shared/host";
import { ask, type Hello, type PageCommand, type PageReply } from "../shared/messages";
import { err, ok, type Credentials, type EntrySummary } from "../shared/types";
import { fillLogin, passwordFields, submit } from "./forms";
import { attachPicker } from "./picker";

const decorated = new WeakMap<HTMLInputElement, () => void>();
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

const handleCommand = (command: PageCommand): PageReply => {
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

chrome.runtime.onMessage.addListener((message: PageCommand, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message.type !== "fill") {
    return false;
  }
  sendResponse(handleCommand(message));
  return false;
});

let timer: ReturnType<typeof setTimeout> | undefined;
const scheduleScan = (): void => {
  clearTimeout(timer);
  timer = setTimeout(() => void scan(), 400);
};

new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
void scan();
