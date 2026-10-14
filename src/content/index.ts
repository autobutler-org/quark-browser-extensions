import { errorText } from "../shared/errors";
import { t } from "../shared/i18n";
import { ask, type FillCommand, type Hello, type PageCommand, type PageReply } from "../shared/messages";
import { fits, isShort, passwordFor } from "../shared/password";
import { err, ok, type ApiError, type Credentials, type EntrySummary } from "../shared/types";
import type { SaveAction, SaveOffer } from "../background/save";
import { showSaveBar } from "./savebar";
import {
  capturedLogin,
  fillLogin,
  fillNewPassword,
  fillOtp,
  frameShown,
  fieldRules,
  identifierField,
  isLoginField,
  isNewPasswordField,
  looksLikeSubmit,
  markOwn,
  onePass,
  otpFields,
  passwordFields,
  submit,
} from "./forms";
import { fillDecision, frameTopUrl } from "./frame";
import { attachPicker, type PickerHandle } from "./picker";

// Draws some of the extension's own UI, which appends its host to <body>, and tells the hit test to look past it.
const drawOwn = <T>(draw: () => T): T => {
  const before = document.body.lastElementChild;
  const drawn = draw();
  const host = document.body.lastElementChild;
  if (host !== null && host !== before) {
    markOwn(host);
  }
  return drawn;
};

// Which picker a field has: Suggest strong password on a new password, the site's logins on a login field, codes
// on a one-time code field.
type Kind = "signup" | "login" | "otp";

// A Map, not a WeakMap: each scan destroys the pickers whose field the page has removed.
const decorated = new Map<HTMLInputElement, Readonly<{ kind: Kind; handle: PickerHandle }>>();
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
  decorated.forEach(({ handle }, field) => {
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

// The picker stays open while the user chooses, so the page may hide the field meanwhile (#129): check it before
// asking for the login, and fillLogin checks it again once the login arrives.
const pick =
  (field: HTMLInputElement) =>
  async (entry: EntrySummary): Promise<string | null> => {
    if (!isLoginField(field)) {
      return t("refuseNoFields");
    }
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

// A password that fits the field's maxlength, minlength and pattern (#131). The pattern is checked here, in
// the page's own frame, so a page's pattern never runs in the worker.
const passwordForField = (field: HTMLInputElement) =>
  passwordFor(fieldRules(field), (plan) => ask({ type: "generateForPage", length: plan.length, classes: plan.classes }));

const suggest = (field: HTMLInputElement) => async (): Promise<string | null> => {
  const result = await passwordForField(field);
  if (!result.ok) {
    return failureText(result.error);
  }
  fillNewPassword(field, result.value);
  return isShort(result.value) ? t("pickerFilledShort", String(result.value.length)) : null;
};

// Every scan classifies the fields afresh, so a field the page changes after load gets the picker it now needs
// (#152): a sign-up tab revealed beside the login, or a confirmation shown that makes a password a new one.
const scan = async (): Promise<void> => {
  forgetDetached();
  awaitAnimations();
  const wanted = onePass((): readonly (readonly [HTMLInputElement, Kind])[] => {
    const passwords = passwordFields(document);
    const signups = passwords.filter(isNewPasswordField);
    const identifier = identifierField(document);
    return [
      ...signups.map((field) => [field, "signup"] as const),
      ...passwords.filter((field) => !signups.includes(field)).map((field) => [field, "login"] as const),
      ...otpFields(document).map((field) => [field, "otp"] as const),
      ...(identifier === null ? [] : [[identifier, "login"] as const]),
    ];
  });
  const changed = wanted.filter(([field, kind]) => decorated.get(field)?.kind !== kind);
  if (changed.length === 0) {
    return;
  }
  const greeting = await greet();
  if (greeting === null || !greeting.settings.inlineButton) {
    return;
  }
  changed.forEach(([field, kind]) => {
    const known = decorated.get(field);
    // Another scan may have got here first while this one waited for the worker.
    if (known?.kind === kind) {
      return;
    }
    known?.handle.destroy();
    decorated.delete(field);
    // Suggest needs only the worker; logins and codes only where the site has some. The button on an email
    // field tells the user Quark can sign in here.
    if (kind === "signup" ? !greeting.connected : greeting.matches.length === 0) {
      return;
    }
    const handle = drawOwn(() =>
      kind === "signup"
        ? attachPicker(field, [], location.host, { onPick: pick(field), onSuggest: suggest(field) })
        : attachPicker(field, greeting.matches, location.host, { onPick: (kind === "otp" ? pickOtp : pick)(field) }),
    );
    decorated.set(field, { kind, handle });
  });
};

const isTop = window === window.top;

const topUrl = (verifiedTopUrl: string | undefined): string =>
  frameTopUrl(isTop, location.href, location.ancestorOrigins, verifiedTopUrl);

const hasLoginFields = (): boolean =>
  passwordFields(document).length > 0 || otpFields(document).length > 0 || identifierField(document) !== null;

const openPicker = (): PageReply | null => {
  const active = document.activeElement;
  const focused = active instanceof HTMLInputElement ? decorated.get(active)?.handle : undefined;
  const handle =
    focused ??
    [...passwordFields(document), identifierField(document)]
      .map((field) => (field === null ? undefined : decorated.get(field)?.handle))
      .find((found) => found !== undefined);
  if (handle === undefined) {
    return null;
  }
  handle.open();
  return ok(null);
};

// How long a subframe the worker refused waits before saying so, so that a frame that did fill answers the
// broadcast fill command first.
export const subframeRefusalDelayMs = 500;

const fillFromWorker = async (entryId: number): Promise<PageReply> => {
  const result = await ask({ type: "fillFromPage", entryId }).catch(() => null);
  if (result === null) {
    return err({ kind: "refused", reason: t("refuseReload") });
  }
  if (!result.ok) {
    if (!isTop) {
      await new Promise((resolve) => setTimeout(resolve, subframeRefusalDelayMs));
    }
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

// The frame elements in this document, inside open shadow roots too.
const frameElements = (scope: ParentNode): readonly Element[] =>
  [...scope.querySelectorAll("*")].flatMap((element) => [
    ...(["iframe", "frame", "object"].includes(element.localName) ? [element] : []),
    ...(element.shadowRoot === null ? [] : frameElements(element.shadowRoot)),
  ]);

// The worker's probe of a child frame (#141): the child posts its nonce here, and this frame reports whether the
// element that frame is drawn in is shown. The page sees the nonce too, but event.source can't be forged: it is
// the window that posted. A message from no child frame of ours is ignored.
const reported = new Set<string>();

const onProbe = (event: MessageEvent): void => {
  const nonce: unknown = (event.data as Partial<{ quarkFrameProbe: unknown }> | null)?.quarkFrameProbe;
  if (typeof nonce !== "string" || event.source === null || reported.has(nonce)) {
    return;
  }
  const frame = frameElements(document).find(
    (element) => (element as HTMLIFrameElement | HTMLObjectElement).contentWindow === event.source,
  );
  if (frame === undefined) {
    return;
  }
  reported.add(nonce);
  void ask({ type: "frameReport", nonce, shown: onePass(() => frameShown(frame)) }).catch(() => null);
};

const announceFrame = (nonce: string): PageReply => {
  if (!isTop) {
    window.parent.postMessage({ quarkFrameProbe: nonce }, "*");
  }
  return ok(null);
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
const fillGeneratedHere = (generated: string): Promise<PageReply> | null => {
  const target = focusedElement();
  if (!(target instanceof HTMLInputElement) || !passwordFields(document).includes(target) || !onScreen(target)) {
    return null;
  }
  return (fits(generated, fieldRules(target)) ? Promise.resolve(ok(generated)) : passwordForField(target)).then((fitting) => {
    if (!fitting.ok) {
      return fitting;
    }
    if (isNewPasswordField(target)) {
      fillNewPassword(target, fitting.value);
    } else {
      fillLogin(document, { username: "", password: fitting.value }, target);
    }
    return ok(null);
  });
};

const resolveSave = async (action: SaveAction): Promise<string | null> => {
  const result = await ask({ type: "resolveSave", action });
  return result.ok ? null : failureText(result.error);
};

const offerSave = async (known: SaveOffer | null | undefined): Promise<void> => {
  const offer = known === undefined ? await ask({ type: "myOffer" }).catch(() => null) : known;
  if (offer !== null) {
    drawOwn(() => showSaveBar(document, offer, resolveSave));
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
    case "announceFrame":
      return announceFrame(command.nonce);
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

// The attributes that show, hide or reclassify a field without adding or removing a node: a tab's hidden, a
// modal's class, a script's opacity (#150, #152).
const shownBy = ["hidden", "class", "style", "open", "inert", "aria-hidden", "disabled", "type", "autocomplete"];

// Web Animations fade elements in from script and fire no event when they finish; each is awaited once (#150).
const awaited = new WeakSet<Animation>();
const awaitAnimations = (): void => {
  const running = (document as Partial<Pick<Document, "getAnimations">>).getAnimations?.() ?? [];
  running
    .filter((animation) => !awaited.has(animation))
    .forEach((animation) => {
      awaited.add(animation);
      animation.finished.then(scheduleScan, () => undefined);
    });
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

  window.addEventListener("message", onProbe, true);

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: shownBy,
  });
  // A fade or slide runs in the stylesheet and ends without a DOM change, so its end is a change too (#150).
  ["transitionend", "animationend"].forEach((type) => document.addEventListener(type, scheduleScan, true));
  void scan();
};
