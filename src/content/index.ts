import { errorText } from "../shared/errors";
import { ask, type FillCommand, type Hello, type PageCommand, type PageReply } from "../shared/messages";
import { err, ok, type ApiError, type Credentials, type EntrySummary } from "../shared/types";
import type { SaveAction, SaveOffer } from "../background/save";
import { showSaveBar } from "./savebar";
import {
  capturedLogin,
  fillLogin,
  fillNewPassword,
  fillOtp,
  generatedLength,
  identifierField,
  isNewPasswordField,
  looksLikeSubmit,
  otpFields,
  passwordFields,
  submit,
} from "./forms";
import { fillDecision, frameTopUrl } from "./frame";
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
      return failureText(result.error);
    }
    return fill(result.value, result.value.autoSubmit, field) ? null : "Couldn't find the login fields on this page.";
  };

const failureText = (error: ApiError): string =>
  error.kind === "locked" ? "The vault is locked. Unlock it from the Quark Vault toolbar button." : errorText(error);

const pickOtp =
  (field: HTMLInputElement) =>
  async (entry: EntrySummary): Promise<string | null> => {
    const result = await ask({ type: "otpFromPage", entryId: entry.id });
    if (!result.ok) {
      return failureText(result.error);
    }
    fillOtp(field, result.value.code);
    return null;
  };

const suggest = (field: HTMLInputElement) => async (): Promise<string | null> => {
  const result = await ask({ type: "generateForPage", length: generatedLength(field) });
  if (!result.ok) {
    return failureText(result.error);
  }
  fillNewPassword(field, result.value);
  return null;
};

const scan = async (): Promise<void> => {
  const passwords = passwordFields(document).filter((field) => !decorated.has(field));
  const codes = otpFields(document).filter((field) => !decorated.has(field));
  const identifier = identifierField(document);
  const identifiers = identifier === null || decorated.has(identifier) ? [] : [identifier];
  const fields = [...passwords, ...codes, ...identifiers];
  if (fields.length === 0) {
    return;
  }
  const greeting = await greet();
  if (greeting === null || !greeting.settings.inlineButton) {
    return;
  }
  const signups = passwords.filter(isNewPasswordField);
  if (greeting.connected) {
    signups.forEach((field) => {
      if (!decorated.has(field)) {
        decorated.set(field, attachPicker(field, [], location.host, { onPick: pick(field), onSuggest: suggest(field) }));
      }
    });
  }
  if (greeting.matches.length === 0) {
    return;
  }
  const attach = (onPick: (field: HTMLInputElement) => (entry: EntrySummary) => Promise<string | null>) =>
    (field: HTMLInputElement): void => {
      if (!decorated.has(field)) {
        decorated.set(field, attachPicker(field, greeting.matches, location.host, { onPick: onPick(field) }));
      }
    };
  passwords.filter((field) => !signups.includes(field)).forEach(attach(pick));
  codes.forEach(attach(pickOtp));
  // Only with matches: the button on an email field tells the user Quark can sign in here.
  identifiers.forEach(attach(pick));
};

const isTop = window === window.top;

const topUrl = (verifiedTopUrl: string | undefined): string =>
  frameTopUrl(isTop, location.href, location.ancestorOrigins, verifiedTopUrl);

const hasLoginFields = (): boolean =>
  passwordFields(document).length > 0 || otpFields(document).length > 0 || identifierField(document) !== null;

const openPicker = (): PageReply | null => {
  const active = document.activeElement;
  const focused = active instanceof HTMLInputElement ? decorated.get(active) : undefined;
  const handle =
    focused ??
    [...passwordFields(document), identifierField(document)]
      .map((field) => (field === null ? undefined : decorated.get(field)))
      .find((found) => found !== undefined);
  if (handle === undefined) {
    return null;
  }
  handle.open();
  return ok(null);
};

const fillFromWorker = async (entryId: number): Promise<PageReply> => {
  const result = await ask({ type: "fillFromPage", entryId }).catch(() => null);
  if (result === null) {
    return err({ kind: "refused", reason: "This page can't be filled. Reload it and try again." });
  }
  if (!result.ok) {
    return result;
  }
  return fill(result.value, result.value.autoSubmit, null)
    ? ok(null)
    : err({ kind: "refused", reason: "Couldn't find the login fields on this page." });
};

const handleFill = (command: FillCommand): PageReply | Promise<PageReply> | null => {
  const decision = fillDecision(
    isTop,
    hasLoginFields(),
    location.href,
    topUrl(command.topUrl),
    command.entryUrl,
    command.entryHost,
  );
  switch (decision.kind) {
    case "silent":
      return null;
    case "refuse":
      return err({ kind: "refused", reason: decision.reason });
    case "ask":
      return fillFromWorker(command.entryId);
  }
};

const fillGeneratedHere = (password: string): PageReply | null => {
  const active = document.activeElement;
  const target =
    active instanceof HTMLInputElement && active.type === "password"
      ? active
      : isTop
        ? passwordFields(document).find(isNewPasswordField) ?? null
        : null;
  if (target === null) {
    return null;
  }
  if (isNewPasswordField(target)) {
    fillNewPassword(target, password);
  } else {
    fillLogin(document, { username: "", password }, target);
  }
  return ok(null);
};

const resolveSave = async (action: SaveAction): Promise<string | null> => {
  const result = await ask({ type: "resolveSave", action });
  return result.ok ? null : failureText(result.error);
};

const offerSave = async (known: SaveOffer | null | undefined): Promise<void> => {
  const offer = known === undefined ? await ask({ type: "myOffer" }).catch(() => null) : known;
  if (offer !== null) {
    showSaveBar(document, offer, resolveSave);
  }
};

let lastCapture = "";

const capture = (form: HTMLFormElement | null): void => {
  if (window !== window.top) {
    return;
  }
  const credentials = capturedLogin(document, form);
  if (credentials === null) {
    return;
  }
  const key = `${credentials.username}\n${credentials.password}`;
  if (key === lastCapture) {
    return;
  }
  lastCapture = key;
  void ask({ type: "captured", ...credentials })
    .then((offer) => offerSave(offer))
    .catch(() => null);
};

const handleCommand = (command: PageCommand): PageReply | Promise<PageReply> | string | null => {
  switch (command.type) {
    case "whereAmI":
      return isTop ? location.href : null;
    case "offerCheck":
      void offerSave(undefined);
      return ok(null);
    case "fill":
      return handleFill(command);
    case "openPicker":
      return openPicker();
    case "fillGenerated":
      return fillGeneratedHere(command.password);
  }
};

let timer: ReturnType<typeof setTimeout> | undefined;
const scheduleScan = (): void => {
  clearTimeout(timer);
  timer = setTimeout(() => void scan(), 400);
};

export const main = (): void => {
  chrome.runtime.onMessage.addListener((message: PageCommand, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      return false;
    }
    const reply = handleCommand(message);
    if (reply instanceof Promise) {
      void reply.then(sendResponse);
      return true;
    }
    if (reply !== null) {
      sendResponse(reply);
    }
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

  document.addEventListener(
    "submit",
    (event) => {
      if (event.target instanceof HTMLFormElement) {
        capture(event.target);
      }
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Element && looksLikeSubmit(event.target)) {
        capture(event.target.closest("form"));
      }
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "password") {
        capture(event.target.form);
      }
    },
    true,
  );

  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  void scan();
};
