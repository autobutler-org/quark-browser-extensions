import { errorText } from "../shared/errors";
import { t } from "../shared/i18n";
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
  onePass,
  otpFields,
  passwordFields,
  submit,
} from "./forms";
import { fillDecision, frameTopUrl } from "./frame";
import { attachPicker, type PickerHandle } from "./picker";

// A Map, not a WeakMap: each scan destroys the pickers whose field the page has removed.
const decorated = new Map<HTMLInputElement, PickerHandle>();
let hello: Promise<Hello | null> | null = null;

// Kept only while the worker is connected: a failed or locked reply is asked again on the next scan with fields,
// so a form shown after unlocking still gets its picker.
const greet = (): Promise<Hello | null> => {
  if (hello === null) {
    const asked = ask({ type: "hello" }).catch(() => null);
    hello = asked;
    void asked.then((reply) => {
      if ((reply === null || !reply.connected) && hello === asked) {
        hello = null;
      }
    });
  }
  return hello;
};

const forgetDetached = (): void => {
  decorated.forEach((handle, field) => {
    if (!field.isConnected) {
      handle.destroy();
      decorated.delete(field);
    }
  });
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
    return fill(result.value, result.value.autoSubmit, field) ? null : t("refuseNoFields");
  };

const failureText = (error: ApiError): string =>
  error.kind === "locked" ? t("pageLocked") : errorText(error);

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
  forgetDetached();
  const [passwords, codes, identifier] = onePass(
    () =>
      [
        passwordFields(document).filter((field) => !decorated.has(field)),
        otpFields(document).filter((field) => !decorated.has(field)),
        identifierField(document),
      ] as const,
  );
  const identifiers = identifier === null || decorated.has(identifier) ? [] : [identifier];
  const fields = [...passwords, ...codes, ...identifiers];
  if (fields.length === 0) {
    return;
  }
  const greeting = await greet();
  if (greeting === null || !greeting.settings.inlineButton) {
    return;
  }
  const signups = onePass(() => passwords.filter(isNewPasswordField));
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
    return err({ kind: "refused", reason: t("refuseReload") });
  }
  if (!result.ok) {
    return result;
  }
  return fill(result.value, result.value.autoSubmit, null)
    ? ok(null)
    : err({ kind: "refused", reason: t("refuseNoFields") });
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

// The focused element, looking inside open shadow roots.
const focusedElement = (): Element | null => {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
};

// Not moved out of the viewport, the trick that hides a field without display or visibility.
const onScreen = (field: HTMLElement): boolean => {
  const box = field.getBoundingClientRect();
  return box.right >= 0 && box.bottom >= 0 && box.left <= window.innerWidth && box.top <= window.innerHeight;
};

// Only the password field the user is on, and only one they can see and reach. Never another field: the
// page that embeds a sign-up iframe must not get the password through fields of its own.
const fillGeneratedHere = (password: string): PageReply | null => {
  const target = focusedElement();
  if (!(target instanceof HTMLInputElement) || !passwordFields(document).includes(target) || !onScreen(target)) {
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

// 400 ms after the first mutation, not the last: a page that changes more often than that (a clock, a ticker)
// would otherwise keep pushing the scan back forever.
let timer: ReturnType<typeof setTimeout> | undefined;
const scheduleScan = (): void => {
  timer ??= setTimeout(() => {
    timer = undefined;
    void scan();
  }, 400);
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
