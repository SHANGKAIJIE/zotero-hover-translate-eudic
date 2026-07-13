/**
 * Hover translate module.
 *
 * Responsibilities:
 *  - Attach mousemove listeners to each PDF reader's inner (pdf.js) window.
 *  - After the configured delay, extract the English word under the cursor.
 *  - Reuse `Zotero.PDFTranslate.api.translate` for translation (engine + keys).
 *  - Show a lightweight popup styled to follow Translate for Zotero.
 *  - Optionally highlight the matched word (non-destructive overlay).
 *  - Inject a "+生词本" button when the source is a single English word.
 *
 * Conflict handling:
 *  - If text is selected in the reader (disableOnSelection), hover is paused
 *    and any open hover popup + highlight is cleared. This naturally yields
 *    to Translate for Zotero's native selection popup.
 */
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { waitFor } from "../utils/wait";
import {
  getAllReaders,
  getReaderByTabID,
  getReaderInnerWindow,
} from "../utils/window";
import { wordRangeAtOffset, isSingleEnglishWord } from "./util";
import { createEudicClientFromPrefs } from "./eudic";

const HIGHLIGHT_OVERLAY_ID = `${config.addonRef}-highlight-overlay`;
const POPUP_ID = `${config.addonRef}-hover-popup`;
const STYLE_INJECTED_FLAG = `${config.addonRef}-style-injected`;

// Track attached readers so we can detach cleanly.
const attached: Map<
  _ZoteroTypes.ReaderInstance,
  { innerWin: Window; cleanup: () => void }
> = new Map();

// --- D2: promise-based translation cache ---
// key = word|service|langfrom|langto; value = pending or resolved promise
const translateCache: Map<
  string,
  Promise<{ ok: boolean; result: string; error?: string; task?: any }>
> = new Map();

function makeCacheKey(
  word: string,
  service: string,
  langfrom: string,
  langto: string,
): string {
  return `${word}|${service}|${langfrom}|${langto}`;
}

// --- D4: explicit language helpers ---
function getPdfTranslateSource(): string {
  try {
    return (Zotero.Prefs.get(
      "extensions.zotero.ZoteroPDFTranslate.translateSource",
      true,
    ) as string) || "";
  } catch {
    return "";
  }
}

function getPdfTranslateTargetLang(): string {
  try {
    return (Zotero.Prefs.get(
      "extensions.zotero.ZoteroPDFTranslate.targetLanguage",
      true,
    ) as string) || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

// --- D5: cached dark-mode detection ---
let _cachedDark: boolean | null = null;

function initThemeWatcher() {
  try {
    const mainWin = Zotero.getMainWindow();
    const mql = mainWin.matchMedia("(prefers-color-scheme: dark)");
    if (mql) {
      mql.addEventListener("change", () => {
        _cachedDark = null;
      });
    }
  } catch {
    /* ignore */
  }
}

let pollTimer: number | null = null;

/* ----------------------------- public API ----------------------------- */

export function initHoverTranslate() {
  dbg("initHoverTranslate called");
  initThemeWatcher();
  // Attach to any readers already open at startup.
  attachToAllReaders();
  // Poll every 2s for newly opened readers (reliable fallback that does not
  // depend on notifier timing, which can miss restored tabs on startup).
  try {
    pollTimer = Zotero.getMainWindow().setInterval(attachToAllReaders, 2000);
    dbg("poll timer started");
  } catch (e) {
    dbg(`poll timer failed: ${e}`);
  }
}

function attachToAllReaders() {
  const readers = getAllReaders();
  if (readers.length > 0) {
    dbg(`attachToAllReaders: ${readers.length} reader(s), attached=${attached.size}`);
  }
  for (const reader of readers) {
    if (attached.has(reader)) continue;
    attachToReader(reader).catch((e) =>
      dbg(`attach failed: ${e}`),
    );
  }
}

export function onTabNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (type !== "tab") return;
  if (event !== "select" && event !== "add") return;
  // Immediate attempt (the poll will also catch it as a fallback).
  attachToAllReaders();
}

export function cleanupAll() {
  if (pollTimer != null) {
    try {
      Zotero.getMainWindow().clearInterval(pollTimer);
    } catch {
      /* ignore */
    }
    pollTimer = null;
  }
  for (const [, info] of attached) {
    try {
      info.cleanup();
    } catch (e) {
      /* ignore */
    }
  }
  attached.clear();
}

/* ----------------------------- attach logic ----------------------------- */

async function attachToReader(reader: _ZoteroTypes.ReaderInstance) {
  const r = reader as any;
  if (r._initPromise) {
    try {
      await r._initPromise;
    } catch {
      /* ignore */
    }
  }
  // Wait for the inner window + document body to be ready.
  const innerWin = await waitFor<Window>(
    () => {
      const w = getReaderInnerWindow(reader);
      return w && w.document && w.document.body ? w : false;
    },
    20000,
    200,
  );

  // Collect the reader inner window AND any nested iframes (pdf.js viewer
  // may live in a nested iframe, whose events won't bubble across the
  // iframe boundary to the outer window).
  const targets = collectWindows(innerWin);
  dbg(
    `attached reader tabID=${r.tabID}, windows=${targets.length}, urls=` +
      targets.map((t) => safeHref(t)).join(" | "),
  );

  // --- D3: dual-timer decoupling ---
  let hoverTimer: number | null = null; // popup gate (hoverDelay ms)
  let preheatTimer: number | null = null; // preheat request (shorter debounce)
  let lastWord = "";
  const lastWordRef = { get: () => lastWord, set: (v: string) => (lastWord = v) };
  // Track the last hit (word + range) so the keydown handler can trigger
  // translation when the user presses modifier keys while hovering.
  let lastHit: { word: string; range: Range } | null = null;
  const lastHitRef = {
    get: () => lastHit,
    set: (v: { word: string; range: Range } | null) => (lastHit = v),
  };
  let moveCount = 0;
  // Track the window the mouse is currently over. The popup/highlight MUST
  // be created in THIS window (not the outer reader window), otherwise an
  // inner pdf.js iframe would render the popup invisible/occluded.
  const activeWinRef = { win: innerWin };

  // D3 preheat: shorter debounce starts a background translation that
  // writes into D2 cache. The popup gate (hoverDelay) fires later and
  // reads from cache — so the popup shows the translation immediately.
  const PREHEAT_DELAY = 300; // ms, enough to filter quick sweeps
  const schedule = (word: string) => {
    const win = activeWinRef.win;

    // Cancel both timers on every new word / re-schedule.
    if (hoverTimer) win.clearTimeout(hoverTimer);
    if (preheatTimer) win.clearTimeout(preheatTimer);

    // Short-debounce background preheat (D3: no popup, just cache fill).
    preheatTimer = win.setTimeout(() => {
      preheatTimer = null;
      translateWord(word, reader).then(() => {
        dbg(`preheat done for "${word}"`);
      }).catch(() => { /* ignore */ });
    }, PREHEAT_DELAY);

    // Popup gate — the user's familiar hoverDelay (default 900 ms).
    // doTranslate will first check D2 cache; if preheat already finished,
    // the popup shows the translation instantly.
    hoverTimer = win.setTimeout(() => {
      hoverTimer = null;
      doTranslate(activeWinRef.win, reader, word, lastWordRef);
    }, Math.max(0, getPref("hoverDelay") | 0));
  };

  const onMouseMove = (ev: MouseEvent) => {
    // The window that actually generated the event (may be a nested iframe).
    const win = (ev.view as Window) || activeWinRef.win;
    activeWinRef.win = win;
    // D6: update last pointer pos here (merged from injectPopupStyle's
    // extra mousemove listener — one listener instead of two per window).
    (win as any).__hoverLastPos = { x: ev.clientX, y: ev.clientY };
    onReaderMouseMove(ev, win, reader, lastWordRef, lastHitRef, schedule);
    if (++moveCount % 50 === 0) {
      dbg(`mousemove#${moveCount} on ${safeHref(win)}`);
    }
  };
  const onMouseDown = (ev: MouseEvent) => {
    // Capture-phase listener: MUST NOT throw or it breaks reader selection.
    try {
      // If the click lands inside our popup, keep the popup (let the button
      // click proceed). Otherwise clear hover so selection can start fresh.
      const target = ev.target as HTMLElement | null;
      const popup = activeWinRef.win.document.getElementById(POPUP_ID);
      if (popup && target && popup.contains(target)) {
        return;
      }
      clearHover(activeWinRef.win);
      lastWord = "";
    } catch {
      /* suppress */
    }
  };
  // click trigger mode: translate the word under the pointer on left-click.
  const onMouseUp = (ev: MouseEvent) => {
    try {
      if (ev.button !== 0) return; // left button only
      if (!getPref("enableHoverTranslate")) return;
      if (getPref("triggerMode") !== "click") return;
      // If the click lands inside our popup, keep the popup (let the button
      // click proceed). This prevents the +生词本 button from dismissing
      // the popup before its click handler can fire.
      const target = ev.target as HTMLElement | null;
      const popup = activeWinRef.win.document.getElementById(POPUP_ID);
      if (popup && target && popup.contains(target)) {
        return;
      }
      // Yield if there is a real selection (let Translate handle it).
      if (getPref("disableOnSelection")) {
        const sel = activeWinRef.win.getSelection();
        if (sel && sel.toString().trim().length > 0) return;
      }
      const win = (ev.view as Window) || activeWinRef.win;
      activeWinRef.win = win;
      const hit = getWordAtPoint(win.document, ev.clientX, ev.clientY);
      if (!hit) {
        clearHover(win);
        return;
      }
      lastWord = hit.word;
      if (getPref("enableHighlight")) {
        applyHighlight(win, hit.range);
      }
      // Translate immediately (no debounce for click mode).
      void doTranslate(win, reader, hit.word, lastWordRef);
    } catch {
      /* suppress */
    }
  };
  // modifier mode: allow pressing modifier keys AFTER hovering to trigger
  // translation (not just while holding them during hover).
  const onKeyDown = (ev: KeyboardEvent) => {
    try {
      if (!getPref("enableHoverTranslate")) return;
      if (getPref("triggerMode") !== "modifier") return;
      const needCtrl = getPref("modifierCtrl");
      const needAlt = getPref("modifierAlt");
      const needShift = getPref("modifierShift");
      // Check if all required modifiers are now pressed.
      if (
        (needCtrl && !ev.ctrlKey) ||
        (needAlt && !ev.altKey) ||
        (needShift && !ev.shiftKey)
      ) {
        return;
      }
      // At least one modifier must be required; if none are checked, skip.
      if (!needCtrl && !needAlt && !needShift) return;
      // Check if a word is currently being hovered.
      const hit = lastHitRef.get();
      if (!hit || !hit.word) return;
      // If popup is already shown for this word, don't re-trigger.
      if (popupShown(activeWinRef.win, hit.word)) return;
      lastWordRef.set(hit.word);
      if (getPref("enableHighlight")) {
        applyHighlight(activeWinRef.win, hit.range);
      }
      void doTranslate(activeWinRef.win, reader, hit.word, lastWordRef);
    } catch {
      /* suppress */
    }
  };
  const onMouseLeave = () => {
    try {
      // Only cancel a pending translation; do NOT close the popup here —
      // otherwise moving the pointer off the word instantly hides it and the
      // user cannot click "+生词本". The popup auto-closes via timer or on
      // the next word / selection.
      if (hoverTimer) {
        activeWinRef.win.clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      if (preheatTimer) {
        activeWinRef.win.clearTimeout(preheatTimer);
        preheatTimer = null;
      }
      clearHighlight(activeWinRef.win);
    } catch {
      /* suppress */
    }
  };
  const onSelectionChange = () => {
    try {
      const sel = activeWinRef.win.getSelection();
      if (sel && sel.toString().trim().length > 0) {
        // A real selection exists — yield to selection translate.
        clearHover(activeWinRef.win);
        lastWord = "";
      }
    } catch {
      /* suppress */
    }
  };

  // Inject the last-pointer tracking + popup base style into every target.
  for (const win of targets) {
    injectPopupStyle(win);
  }

  // Register on every collected window (capture phase).
  for (const win of targets) {
    try {
      win.addEventListener("mousemove", onMouseMove as any, true);
      win.addEventListener("mousedown", onMouseDown as any, true);
      win.addEventListener("mouseup", onMouseUp as any, true);
      win.addEventListener("keydown", onKeyDown as any, true);
      win.addEventListener("mouseout", onMouseLeave as any, true);
      win.document.addEventListener("selectionchange", onSelectionChange as any);
    } catch (e) {
      dbg(`register failed on ${safeHref(win)}: ${e}`);
    }
  }

  const cleanup = () => {
    try {
      if (hoverTimer) activeWinRef.win.clearTimeout(hoverTimer);
    } catch {
      /* ignore */
    }
    try {
      if (preheatTimer) activeWinRef.win.clearTimeout(preheatTimer);
    } catch {
      /* ignore */
    }
    hoverTimer = null;
    preheatTimer = null;
    for (const win of targets) {
      try {
        win.removeEventListener("mousemove", onMouseMove as any, true);
        win.removeEventListener("mousedown", onMouseDown as any, true);
        win.removeEventListener("mouseup", onMouseUp as any, true);
        win.removeEventListener("keydown", onKeyDown as any, true);
        win.removeEventListener("mouseout", onMouseLeave as any, true);
        win.document.removeEventListener(
          "selectionchange",
          onSelectionChange as any,
        );
      } catch {
        /* ignore */
      }
      // Clear any popup/highlight left in every window.
      clearHover(win);
    }
  };

  attached.set(reader, { innerWin, cleanup });
}

/** Recursively collect a window and all its nested iframe contentWindows. */
function collectWindows(rootWin: Window): Window[] {
  const seen = new Set<Window>();
  const out: Window[] = [];
  const walk = (win: Window) => {
    if (!win || seen.has(win)) return;
    seen.add(win);
    out.push(win);
    try {
      const iframes = win.document.querySelectorAll("iframe");
      for (const iframe of Array.from(iframes)) {
        try {
          const cw = (iframe as HTMLIFrameElement).contentWindow;
          if (cw && cw.document) walk(cw);
        } catch {
          /* cross-origin or detached */
        }
      }
    } catch {
      /* ignore */
    }
  };
  walk(rootWin);
  return out;
}

function safeHref(win: any): string {
  try {
    return win?.document?.location?.href || win?.location?.href || "?";
  } catch {
    return "?";
  }
}

/** Diagnostic logger that bypasses ztoolkit's production console disable. */
function dbg(msg: string) {
  try {
    Zotero.debug(`[hover-translate-eudic] ${msg}`);
  } catch {
    /* ignore */
  }
}

/* ----------------------------- mouse handling ----------------------------- */

function onReaderMouseMove(
  ev: MouseEvent,
  innerWin: Window,
  reader: _ZoteroTypes.ReaderInstance,
  lastWordRef: { get: () => string; set: (v: string) => void },
  lastHitRef: { get: () => { word: string; range: Range } | null; set: (v: { word: string; range: Range } | null) => void },
  schedule: (word: string) => void,
) {
  // Never let an error in hover handling propagate to the reader's event
  // pipeline (could affect other listeners / pdf.js internals).
  try {
    const hoverEnabled = getPref("enableHoverTranslate");
    const highlightEnabled = getPref("enableHighlight");
    // Both disabled → nothing to do.
    if (!hoverEnabled && !highlightEnabled) {
      clearHover(innerWin);
      return;
    }

    // Pause while a selection exists (yields to Translate's selection popup).
    if (getPref("disableOnSelection")) {
      const sel = innerWin.getSelection();
      if (sel && sel.toString().trim().length > 0) {
        clearHover(innerWin);
        return;
      }
    }

    const hit = getWordAtPoint(innerWin.document, ev.clientX, ev.clientY);
    if (!hit) {
      // Moved off a word — clear highlight but keep popup (timer closes it).
      clearHighlight(innerWin);
      // Clear last hit so keydown doesn't trigger on empty space.
      lastHitRef.set(null);
      return;
    }

    // Always track the last hit for keydown-based triggering.
    lastHitRef.set(hit);

    // Highlight is INDEPENDENT of the hover-translate master switch.
    if (highlightEnabled) {
      applyHighlight(innerWin, hit.range);
    } else {
      clearHighlight(innerWin);
    }

    // Translation requires the master switch + trigger mode.
    if (!hoverEnabled) {
      // Only highlighting; ensure no stale popup.
      clearPopup(innerWin);
      return;
    }
    const mode = getPref("triggerMode");
    // click mode: do not translate on hover — wait for a click instead.
    // IMPORTANT: do NOT clear popup here; click-mode popups should survive
    // mouse movement. The popup is cleared on next click or via auto-close.
    if (mode === "click") {
      return;
    }
    if (mode === "modifier") {
      const needCtrl = getPref("modifierCtrl");
      const needAlt = getPref("modifierAlt");
      const needShift = getPref("modifierShift");
      if (
        (needCtrl && !ev.ctrlKey) ||
        (needAlt && !ev.altKey) ||
        (needShift && !ev.shiftKey)
      ) {
        // Modifiers not pressed — track the word (already done above) but
        // don't translate. The keydown listener will trigger translation
        // when the user presses the modifier while hovering.
        return;
      }
    }

    // If still on the same word and popup is already shown, do nothing.
    if (hit.word === lastWordRef.get() && popupShown(innerWin, hit.word)) {
      return;
    }
    lastWordRef.set(hit.word);

    schedule(hit.word);
  } catch (e) {
    ztoolkit.log("hover: mousemove handler error (suppressed)", e);
  }
}

function popupShown(innerWin: Window, word: string): boolean {
  const existing = innerWin.document.getElementById(POPUP_ID) as
    | HTMLElement
    | null;
  return !!existing && existing.dataset.word === word;
}

/* ----------------------------- word extraction ----------------------------- */

function getWordAtPoint(
  doc: Document,
  x: number,
  y: number,
): { word: string; range: Range } | null {
  // Gecko exposes caretPositionFromPoint.
  const cp: any = (doc as any).caretPositionFromPoint
    ? (doc as any).caretPositionFromPoint(x, y)
    : null;
  if (!cp || !cp.offsetNode) return null;
  const node = cp.offsetNode;
  if (node.nodeType !== 3 /* TEXT_NODE */) return null;
  const text = node.data;
  if (!text) return null;
  const wr = wordRangeAtOffset(text, cp.offset);
  if (!wr) return null;
  try {
    const range = doc.createRange();
    range.setStart(node, wr.start);
    range.setEnd(node, wr.end);
    return { word: wr.word, range };
  } catch {
    return null;
  }
}

/* ----------------------------- highlight ----------------------------- */

function applyHighlight(innerWin: Window, range: Range) {
  clearHighlight(innerWin);
  const doc = innerWin.document;
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;
  const overlay = doc.createElement("div");
  overlay.id = HIGHLIGHT_OVERLAY_ID;
  const color = getPref("highlightColor") || "rgba(255,213,79,0.45)";
  overlay.style.cssText = [
    "position:fixed",
    `left:${rect.left}px`,
    `top:${rect.top}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    `background:${color}`,
    "border-radius:2px",
    "pointer-events:none",
    "z-index:2147483646",
    "mix-blend-mode:multiply",
  ].join(";");
  doc.body?.appendChild(overlay);
}

function clearHighlight(innerWin: Window) {
  const doc = innerWin.document;
  const el = doc.getElementById(HIGHLIGHT_OVERLAY_ID);
  if (el) el.remove();
}

/* ----------------------------- translate + popup ----------------------------- */

async function doTranslate(
  innerWin: Window,
  reader: _ZoteroTypes.ReaderInstance,
  word: string,
  lastWordRef: { get: () => string; set: (v: string) => void },
) {
  if (word !== lastWordRef.get()) return; // user already moved away
  dbg(`translating word="${word}"`);

  const { fontSize, lineHeight } = getTranslateFontPrefs();
  const tc = getThemeColors(innerWin);
  const doc = innerWin.document;

  // Build popup shell.
  clearPopup(innerWin);
  const popup = doc.createElement("div");
  popup.id = POPUP_ID;
  popup.dataset.word = word;
  popup.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "min-width:180px",
    "max-width:380px",
    `background:${tc.bg}`,
    `border:1px solid ${tc.border}`,
    "border-radius:8px",
    `box-shadow:${tc.shadow}`,
    "padding:6px 8px",
    "font-family:inherit",
  ].join(";");

  const raw = doc.createElement("div");
  raw.textContent = word;
  raw.style.cssText =
    `color:${tc.raw};font-size:12px;margin-bottom:2px;word-break:break-word;`;

  const status = doc.createElement("div");
  status.textContent = getString("hover-popup-translating");
  status.style.cssText =
    `color:${tc.status};font-size:12px;font-style:italic;`;

  const result = doc.createElement("div");
  result.style.cssText = `color:${tc.primary};white-space:pre-wrap;word-break:break-word;font-size:${fontSize}px;line-height:${lineHeight};`;

  popup.appendChild(raw);
  popup.appendChild(status);
  popup.appendChild(result);

  // Position near cursor (use last known mouse pos stored on dataset via window).
  positionPopup(innerWin, popup);

  doc.body?.appendChild(popup);

  // Perform translation via Translate for Zotero.
  const tr = await translateWord(word, reader);
  if (word !== lastWordRef.get()) return; // moved away during request

  if (!tr.ok) {
    status.textContent = tr.error === "no-engine"
      ? getString("hover-popup-no-engine")
      : tr.result || getString("hover-popup-empty");
    schedulePopupAutoClose(innerWin);
    return;
  }
  status.textContent = "";
  result.textContent = tr.result || getString("hover-popup-empty");

  // Append any extra tasks the engine already returned.
  const extraTasks: any[] = tr.task?.extraTasks || [];
  for (const et of extraTasks) {
    if (et && et.result) {
      appendExtraResult(doc, popup, et.result, fontSize, lineHeight);
    }
  }

  // Full mode: also query Translate for Zotero's dictionary service for a
  // richer, dictionary-style result (matches the selection popup output).
  if (getPref("translateDisplayMode") === "full") {
    void fillDictionaryResult(word, reader, doc, popup, fontSize, lineHeight);
  }

  // +生词本 button (hover scene, single word only). Keep a ref so auto-add
  // can drive the same button state as a manual click.
  const wordBtn = maybeAddWordButton(innerWin, popup, word, "hover");

  // Start the auto-close timer BEFORE auto-add so that the async
  // autoAddWordWithButton can cancel it.  Otherwise the timer is set
  // after the auto-add kicks off and auto-add's _cancelAutoClose runs
  // before any timer exists — the popup closes mid-request.
  schedulePopupAutoClose(innerWin);

  // Auto-add mode: drive the button through the same states as a click.
  if (
    getPref("enableEudicSync") &&
    getPref("addWordMode") === "auto" &&
    isSingleEnglishWord(word) &&
    wordBtn
  ) {
    void autoAddWordWithButton(word, wordBtn);
  }
}

/** Run an auto-add and reflect the result on the button (mirrors manual click). */
async function autoAddWordWithButton(
  word: string,
  btn: HTMLButtonElement,
) {
  try {
    const win = btn.ownerDocument?.defaultView as Window | null;
    if (win) _cancelAutoClose(win);
    btn.textContent = getString("wordbtn-adding");
    btn.setAttribute("disabled", "true");
    const ok = await addWordToEudic(word);
    btn.textContent = ok
      ? getString("wordbtn-added")
      : getString("wordbtn-failed");
    // Resume the paused auto-close timer (original expiry).
    if (win) _resumeAutoClose(win);
    setTimeout(() => {
      btn.textContent = getString("wordbtn-add");
      btn.removeAttribute("disabled");
    }, 1000);
  } catch {
    /* ignore */
  }
}

/** Auto-close the hover popup after a delay (keeps it clickable meanwhile).
 *  Stores the expiry timestamp so the timer can be paused & resumed
 *  later (e.g. while a button feedback cycle is in progress). */
function schedulePopupAutoClose(innerWin: Window) {
  const win = innerWin;
  const delay = Number(getPref("popupAutoCloseDelay")) || 0;
  if (delay <= 0) return; // 0 = never auto-close
  const expiry = Date.now() + delay * 1000;
  (win as any).__hoverCloseExpiry = expiry;
  try {
    win.clearTimeout((win as any).__hoverCloseTimer);
  } catch {
    /* ignore */
  }
  _armCloseTimer(win, expiry);
}

/** Internal: arm a setTimeout that fires at `expiry` (absolute ms).
 *  Before closing the popup it checks whether the word-button is still
 *  in a feedback cycle (\"添加中\" / \"已加/失败\").  If so it re-arms
 *  instead of closing — this guarantees the popup survives the full
 *  button cycle regardless of timer-cancellation timing edge cases. */
function _armCloseTimer(win: Window, expiry: number) {
  const remaining = Math.max(0, expiry - Date.now());
  (win as any).__hoverCloseTimer = win.setTimeout(() => {
    const popup = win.document.getElementById(POPUP_ID);
    if (!popup) return;
    const btn = popup.querySelector("button") as HTMLButtonElement | null;
    // If a word-button exists and is NOT in its default state, the
    // button cycle is still in progress — re-arm instead of closing.
    if (btn && btn.textContent !== getString("wordbtn-add")) {
      // Button cycle still in progress — keep popup alive 1 more
      // second, then close regardless to prevent a runaway loop.
      (win as any).__hoverCloseTimer = win.setTimeout(() => {
        clearPopup(win);
      }, 1000);
      return;
    }
    clearPopup(win);
  }, remaining);
}

/** Pause the auto-close timer (clear the timeout but keep the expiry
 *  so it can be resumed later). */
function _cancelAutoClose(innerWin: Window) {
  try {
    innerWin.clearTimeout((innerWin as any).__hoverCloseTimer);
  } catch {
    /* ignore */
  }
}

/** Resume a paused auto-close timer. Uses the original expiry; the
 *  button-state guard inside _armCloseTimer may keep the popup alive
 *  even if the original deadline has passed. */
function _resumeAutoClose(innerWin: Window) {
  const win = innerWin;
  const expiry = (win as any).__hoverCloseExpiry as number | undefined;
  if (expiry == null) return;
  try {
    win.clearTimeout((win as any).__hoverCloseTimer);
  } catch {
    /* ignore */
  }
  // Always re-arm — the button-state guard inside _armCloseTimer
  // will handle the case where the timer has already expired.
  _armCloseTimer(win, expiry);
}

/** Append an extra result block (dictionary entry, etc.) to the popup. */
function appendExtraResult(
  doc: Document,
  popup: HTMLElement,
  text: string,
  fontSize: string,
  lineHeight: string,
) {
  const tc = getThemeColors(doc.defaultView || undefined);
  const ex = doc.createElement("div");
  ex.textContent = text;
  ex.style.cssText = `color:${tc.secondary};white-space:pre-wrap;word-break:break-word;font-size:${fontSize}px;line-height:${lineHeight};margin-top:4px;border-top:1px solid ${tc.divider};padding-top:4px;`;
  popup.appendChild(ex);
}

/** Full mode: query Translate for Zotero's dictionary service and append. */
async function fillDictionaryResult(
  word: string,
  reader: _ZoteroTypes.ReaderInstance,
  doc: Document,
  popup: HTMLElement,
  fontSize: string,
  lineHeight: string,
) {
  const pdf = (Zotero as any).PDFTranslate;
  if (!pdf || !pdf.api || typeof pdf.api.translate !== "function") return;
  // Read pdf-translate's configured dictionary service.
  let dictSource: string | undefined;
  try {
    dictSource = Zotero.Prefs.get(
      "extensions.zotero.ZoteroPDFTranslate.dictSource",
      true,
    ) as string;
  } catch {
    /* ignore */
  }
  if (!dictSource) return;
  try {
    const task = await pdf.api.translate(word, {
      pluginID: config.addonID,
      service: dictSource,
      itemID: reader.itemID,
    });
    if (task && task.status === "success" && task.result) {
      appendExtraResult(doc, popup, task.result, fontSize, lineHeight);
    }
  } catch (e: any) {
    dbg(`dict query failed: ${e?.message || e}`);
  }
}

async function translateWord(
  word: string,
  reader: _ZoteroTypes.ReaderInstance,
): Promise<{
  ok: boolean;
  result: string;
  error?: string;
  task?: any;
}> {
  const pdf = (Zotero as any).PDFTranslate;
  if (!pdf || !pdf.api || typeof pdf.api.translate !== "function") {
    dbg("translate: PDFTranslate.api not available");
    return { ok: false, result: "", error: "no-engine" };
  }

  // D4: explicitly set langfrom/langto. Hover targets are always
  // single English words, so langfrom is deterministic. This skips
  // auto-detect and stabilises the cache key.
  const langfrom = "en";
  const langto = getPdfTranslateTargetLang();
  // D1/D2: use pdf-translate's current translateSource (the engine
  // the user selected). This is already the default in api.translate;
  // we pass it explicitly so the cache key is deterministic.
  const service = getPdfTranslateSource() || "";
  const cacheKey = makeCacheKey(word, service, langfrom, langto);

  // D2: dedup concurrent requests by caching the promise itself.
  const cached = translateCache.get(cacheKey);
  if (cached) {
    dbg(`translate cache hit for "${word}"`);
    return cached;
  }

  const promise = (async () => {
    try {
      const task = await pdf.api.translate(word, {
        pluginID: config.addonID,
        itemID: reader.itemID,
        service: service || undefined,
        langfrom,
        langto,
      });
      dbg(
        `translate result status=${task.status} len=${(task.result || "").length} extra=${(task.extraTasks || []).length}`,
      );
      return {
        ok: task.status === "success",
        result: task.result || "",
        task,
      };
    } catch (e: any) {
      dbg(`translate error: ${e?.message || e}`);
      // Remove failed entry so retries go fresh.
      translateCache.delete(cacheKey);
      return { ok: false, result: "", error: String(e?.message || e) };
    }
  })();

  translateCache.set(cacheKey, promise);
  return promise;
}

function positionPopup(innerWin: Window, popup: HTMLElement) {
  // Use last pointer position stored on the inner window by mousemove handler.
  const last = (innerWin as any).__hoverLastPos as
    | { x: number; y: number }
    | undefined;
  const vw = innerWin.innerWidth;
  const vh = innerWin.innerHeight;
  const EST_W = 240;
  const EST_H = 120;
  let x = (last?.x ?? vw / 2) + 14;
  let y = (last?.y ?? vh / 2) + 18;
  if (x + EST_W > vw) x = (last?.x ?? vw / 2) - EST_W - 14;
  if (x < 4) x = 4;
  if (y + EST_H > vh) y = (last?.y ?? vh / 2) - EST_H - 10;
  if (y < 4) y = 4;
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
}

/* ----------------------------- wordbook button ----------------------------- */

function maybeAddWordButton(
  innerWin: Window,
  popup: HTMLElement,
  word: string,
  scene: "hover" | "selection",
): HTMLButtonElement | null {
  if (!getPref("enableEudicSync")) return null;
  const scenePref = getPref("buttonShowScene");
  if (scenePref !== "both" && scenePref !== scene) return null;
  if (!isSingleEnglishWord(word)) return null;
  if (!getPref("eudicToken")) return null;

  const doc = popup.ownerDocument!;
  const toolbar = doc.createElement("div");
  toolbar.style.cssText = "margin-top:6px;";

  const btn = doc.createElement("button");
  btn.textContent = getString("wordbtn-add");
  // Style adapted from llm-for-zotero's "Add Text" button:
  // full-width block, rounded, translucent, theme-adaptive.
  const tc = getThemeColors(innerWin);
  btn.style.cssText = [
    "display:block",
    "width:100%",
    "margin:0",
    "padding:6px 8px",
    "box-sizing:border-box",
    `border:1px solid ${tc.btnBorder}`,
    "border-radius:6px",
    `background:${tc.btnBg}`,
    "color:inherit",
    "font-size:12px",
    "line-height:1.25",
    "text-align:center",
    "cursor:pointer",
  ].join(";");

  btn.addEventListener("click", async () => {
    // Cancel auto-close while API runs so the popup doesn't vanish
    // before the user sees the outcome.
    _cancelAutoClose(innerWin);
    btn.textContent = getString("wordbtn-adding");
    btn.setAttribute("disabled", "true");
    const ok = await addWordToEudic(word);
    btn.textContent = ok
      ? getString("wordbtn-added")
      : getString("wordbtn-failed");
    // Resume the paused auto-close timer (original expiry).
    // If the timer already expired while the API was running,
    // the popup closes immediately.
    _resumeAutoClose(innerWin);
    setTimeout(() => {
      btn.textContent = getString("wordbtn-add");
      btn.removeAttribute("disabled");
    }, 1000);
  });

  toolbar.appendChild(btn);
  popup.appendChild(toolbar);
  return btn;
}

async function addWordToEudic(word: string): Promise<boolean> {
  const client = createEudicClientFromPrefs();
  if (!client) return false;
  const categoryId = getPref("eudicCategoryId");
  const res = await client.addWord(word, categoryId);
  return res.success;
}

/* ----------------------------- helpers ----------------------------- */

/** Detect if Zotero is in dark mode using multiple strategies. */
function isDarkMode(innerWin?: Window): boolean {
  // Strategy 1: Check the inner window's matchMedia (most reliable for iframe).
  if (innerWin) {
    try {
      const mql = innerWin.matchMedia("(prefers-color-scheme: dark)");
      if (mql) {
        dbg(`isDarkMode: matchMedia.matches=${mql.matches}`);
        if (mql.matches) return true;
      }
    } catch {
      /* matchMedia not available */
    }
  }
  // Strategy 2: Check main window's <window> theme attribute.
  try {
    const mainWin = Zotero.getMainWindow();
    const docEl = mainWin.document.documentElement;
    if (docEl) {
      const theme = docEl.getAttribute("theme");
      dbg(`isDarkMode: mainWin theme="${theme}"`);
      if (theme === "dark") return true;
    }
  } catch {
    /* ignore */
  }
  // Strategy 3: Check the computed background color of the reader's body.
  if (innerWin) {
    try {
      const win: Window = innerWin;
      const body: any = win.document.body || win.document.documentElement;
      if (body) {
        const bg = win.getComputedStyle(body)?.backgroundColor || "";
        dbg(`isDarkMode: computed bg="${bg}"`);
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
          const brightness = (r * 299 + g * 587 + b * 114) / 1000;
          if (brightness < 128) return true;
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Strategy 4: Check Zotero UI theme preference.
  try {
    const uiTheme = Zotero.Prefs.get("ui.theme", true);
    dbg(`isDarkMode: ui.theme="${uiTheme}"`);
    if (uiTheme === "dark" || uiTheme === 2) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Return theme-aware color set for the popup. Caches dark-mode result (D5). */
function getThemeColors(innerWin?: Window) {
  if (_cachedDark === null) {
    _cachedDark = isDarkMode(innerWin);
  }
  const dark = _cachedDark;
  if (dark) {
    return {
      bg: "#2c323e",
      border: "#4c566a",
      raw: "#b0b8c4",
      status: "#8a909a",
      primary: "#e0e4ea",
      secondary: "#a8b0bc",
      btnBg: "rgba(255,255,255,0.06)",
      btnBorder: "rgba(180,180,180,0.3)",
      divider: "rgba(255,255,255,0.1)",
      shadow: "0 4px 16px rgba(0,0,0,0.4)",
    };
  }
  return {
    bg: "#ffffff",
    border: "#d4d4d4",
    raw: "#666666",
    status: "#888888",
    primary: "#1a1a1a",
    secondary: "#555555",
    btnBg: "rgba(255,255,255,0.04)",
    btnBorder: "rgba(130,130,130,0.38)",
    divider: "#e0e0e0",
    shadow: "0 4px 16px rgba(0,0,0,0.18)",
  };
}

function getTranslateFontPrefs(): { fontSize: string; lineHeight: string } {
  try {
    const fs = Zotero.Prefs.get(
      "extensions.zotero.ZoteroPDFTranslate.fontSize",
      true,
    );
    const lh = Zotero.Prefs.get(
      "extensions.zotero.ZoteroPDFTranslate.lineHeight",
      true,
    );
    return {
      fontSize: fs != null ? String(fs) : "14",
      lineHeight: lh != null ? String(lh) : "1.4",
    };
  } catch {
    return { fontSize: "14", lineHeight: "1.4" };
  }
}

function injectPopupStyle(innerWin: Window) {
  const doc = innerWin.document;
  if ((doc as any)[STYLE_INJECTED_FLAG]) return;
  (doc as any)[STYLE_INJECTED_FLAG] = true;
  // D6: last-pointer tracking merged into the capture-phase onMouseMove
  // (one listener per window instead of two). No extra listener here.
}

function clearHover(innerWin: Window) {
  clearHighlight(innerWin);
  clearPopup(innerWin);
}

function clearPopup(innerWin: Window) {
  const el = innerWin.document.getElementById(POPUP_ID);
  if (el) el.remove();
}
