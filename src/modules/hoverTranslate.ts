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
import { toLemma } from "./lemmatize";
import { createEudicClientFromPrefs } from "./eudic";
import { createMaimemoClientFromPrefs } from "./maimemo";
import { createShanbayClientFromPrefs } from "./shanbay";
import { addWord as addWordToLocal } from "./localWordbook";

const HIGHLIGHT_OVERLAY_ID = `${config.addonRef}-highlight-overlay`;
const HIGHLIGHT_CLASS = `${config.addonRef}-highlight`;
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

// Dict result cache (for dict engine mode, keyed by word|dictSource)
const dictCache: Map<
  string,
  Promise<{ result: string; audio: { text: string; url: string }[] } | null>
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
  let sweepPreheatTimer: number | null = null; // shared click/modifier preheat
  let lastWord = "";
  const lastWordRef = { get: () => lastWord, set: (v: string) => (lastWord = v) };
  // Track the last hit (word + range) so the keydown handler can trigger
  // translation when the user presses modifier keys while hovering.
  let lastHit: { word: string; range: Range } | null = null;
  const lastHitRef = {
    get: () => lastHit,
    set: (v: { word: string; range: Range } | null) => (lastHit = v),
  };
  /** Track the sentence context (surrounding text) of the most recent hovered word. */
  let lastContextLine = "";
  const contextLineRef = { get: () => lastContextLine, set: (v: string) => (lastContextLine = v) };
  let moveCount = 0;
  // Track the window the mouse is currently over. The popup/highlight MUST
  // be created in THIS window (not the outer reader window), otherwise an
  // inner pdf.js iframe would render the popup invisible/occluded.
  const activeWinRef = { win: innerWin };

  // D3 preheat: shorter debounce starts a background translation that
  // writes into D2 cache. The popup gate (hoverDelay) fires later and
  // reads from cache — so the popup shows the translation immediately.
  const PREHEAT_DELAY = 200; // ms, enough to filter quick sweeps
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
      doTranslate(activeWinRef.win, reader, word, lastWordRef, contextLineRef);
    }, Math.max(0, getPref("hoverDelay") | 0));
  };

  // Shared preheat for click & modifier modes: debounce so sweeping past
  // many words only fires one background translation on the last word.
  const sweepPreheat = (word: string) => {
    const win = activeWinRef.win;
    if (sweepPreheatTimer) win.clearTimeout(sweepPreheatTimer);
    sweepPreheatTimer = win.setTimeout(() => {
      sweepPreheatTimer = null;
      void translateWord(word, reader).catch(() => { /* ignore */ });
    }, PREHEAT_DELAY);
  };

  const onMouseMove = (ev: MouseEvent) => {
    // The window that actually generated the event (may be a nested iframe).
    const win = (ev.view as Window) || activeWinRef.win;
    activeWinRef.win = win;
    // D6: update last pointer pos here (merged from injectPopupStyle's
    // extra mousemove listener — one listener instead of two per window).
    (win as any).__hoverLastPos = { x: ev.clientX, y: ev.clientY };
    // If user is selecting text, suppress hover entirely. Prevents the
    // hover popup from appearing alongside the selection popup.
    if (getPref("disableOnSelection")) {
      try {
        const sel = win.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
          clearHover(activeWinRef.win);
          return;
        }
      } catch {
        /* cross-origin iframe — ignore */
      }
    }
    onReaderMouseMove(ev, win, reader, lastWordRef, lastHitRef, contextLineRef, schedule, sweepPreheat);
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
      // Clear hover in ALL monitored windows so no stale popup survives
      // into a selection gesture.
      for (const win of targets) {
        try { clearHover(win); } catch { /* ignore */ }
      }
      lastWord = "";

      // mousedown preheat for click mode: start the translation request
      // immediately on mouse press, before mouseup fires, so the network
      // request is already in flight by the time doTranslate runs.
      // The 50-200ms between mousedown and mouseup is free time — use it.
      if (ev.button !== 0) return;
      if (!getPref("enableHoverTranslate")) return;
      if (getPref("triggerMode") !== "click") return;
      const win = (ev.view as Window) || activeWinRef.win;
      const hit = getWordAtPoint(win.document, ev.clientX, ev.clientY);
      if (hit) {
        // translateWord checks D2 cache internally; if already running or
        // completed (from sweepPreheat), this returns the same promise.
        void translateWord(hit.word, reader);
      }
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
        if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
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
      void doTranslate(win, reader, hit.word, lastWordRef, contextLineRef);
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
      void doTranslate(activeWinRef.win, reader, hit.word, lastWordRef, contextLineRef);
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
      if (sweepPreheatTimer) {
        activeWinRef.win.clearTimeout(sweepPreheatTimer);
        sweepPreheatTimer = null;
      }
      clearHighlight(activeWinRef.win);
    } catch {
      /* suppress */
    }
  };
  const onSelectionChange = () => {
    try {
      // Check all monitored windows — selection may occur in a nested
      // iframe that is not activeWinRef.win.
      for (const win of targets) {
        try {
          const sel = win.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
            clearHover(win);
            lastWord = "";
            return;
          }
        } catch {
          /* cross-origin iframe */
        }
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
  contextLineRef: { get: () => string; set: (v: string) => void },
  schedule: (word: string) => void,
  sweepPreheat: ((word: string) => void) | null,
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
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
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

    // Extract sentence context from the PDF text node around this word
    try {
      const container = hit.range.startContainer;
      if (container && container.nodeType === 3) {
        const fullText = (container as Text).data || "";
        const wStart = hit.range.startOffset;
        const wEnd = wStart + hit.word.length;
        // Find start of sentence — walk back from word to delimiter
        let sStart = 0;
        for (let i = wStart - 1; i >= 0; i--) {
          if (".!?\n".includes(fullText[i])) { sStart = i + 1; break; }
        }
        // Find end of sentence — walk forward from word to delimiter
        let sEnd = fullText.length;
        for (let i = wEnd; i < fullText.length; i++) {
          if (".!?\n".includes(fullText[i])) { sEnd = i + 1; break; }
        }
        contextLineRef.set(fullText.slice(sStart, sEnd).trim());
      }
    } catch {
      contextLineRef.set("");
    }

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
    // D3 preheat for click mode: shared debounce — sweeping past many words
    // only fires one preheat on the last paused word.
    if (mode === "click") {
      sweepPreheat?.(hit.word);
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
        // Modifiers not pressed — start a D3 background preheat with shared
        // debounce. When the user presses the modifier later, the result is
        // already in cache.
        sweepPreheat?.(hit.word);
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
    let word = wr.word;

    // PDF text layer sometimes splits a word across multiple <span> elements
    // when characters have different font sizes (e.g. a large drop capital
    // "S" in "SPECIFICATIONS" → "S" in one span, "PECIFICATIONS" in the next).
    // When our word starts at offset 0 of this text node, check if the
    // previous sibling span's text forms a continuous alpha word.
    if (wr.start === 0) {
      const span = node.parentElement;
      if (span) {
        const prevSpan = span.previousElementSibling;
        if (prevSpan) {
          const prevText = (prevSpan.textContent || "").replace(/\s+$/, "");
          if (prevText && /[A-Za-z]$/.test(prevText)) {
            const prevWr = wordRangeAtOffset(prevText, prevText.length - 1);
            if (prevWr && prevWr.end === prevText.length) {
              word = prevWr.word + word;
              const prevNode = prevSpan.firstChild;
              if (prevNode && prevNode.nodeType === 3) {
                range.setStart(prevNode, prevWr.start);
              }
            }
          }
        }
      }
    }

    return { word, range };
  } catch {
    return null;
  }
}

/* ----------------------------- highlight ----------------------------- */

/** Find the closest pdf.js .page ancestor element. */
function findPageElement(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null = null;
  if (node && node.nodeType === 3) {
    el = (node as Text).parentElement as HTMLElement | null;
  } else if (node) {
    el = node as HTMLElement;
  }
  if (!el) return null;
  while (el) {
    if (el.matches?.(".page[data-page-number]")) return el;
    el = el.parentElement as HTMLElement | null;
  }
  return null;
}

function applyHighlight(innerWin: Window, range: Range) {
  clearHighlight(innerWin);
  const doc = innerWin.document;
  const color = getPref("highlightColor") || "rgba(255,213,79,0.45)";
  const pageEl = findPageElement(range.startContainer);

  if (!pageEl) {
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const overlay = doc.createElement("div");
    overlay.id = HIGHLIGHT_OVERLAY_ID;
    overlay.style.cssText = [
      "position:fixed",
      `left:${rect.left}px`, `top:${rect.top}px`,
      `width:${rect.width}px`, `height:${rect.height}px`,
      `background:${color}`, "border-radius:2px",
      "pointer-events:none", "z-index:20", "mix-blend-mode:multiply",
    ].join(";");
    doc.body?.appendChild(overlay);
    return;
  }

  const pageRect = pageEl.getBoundingClientRect();
  const rects = range.getClientRects();
  if (!rects?.length) return;

  for (const r of rects) {
    if (r.width === 0 && r.height === 0) continue;
    const el = doc.createElement("div");
    el.className = HIGHLIGHT_CLASS;
    el.style.cssText = [
      "position:absolute",
      `left:${r.left - pageRect.left}px`, `top:${r.top - pageRect.top}px`,
      `width:${r.width}px`, `height:${r.height}px`,
      `background:${color}`, "border-radius:2px",
      "pointer-events:none", "z-index:20", "mix-blend-mode:multiply",
    ].join(";");
    pageEl.appendChild(el);
  }
}

function clearHighlight(innerWin: Window) {
  const doc = innerWin.document;
  const els = doc.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
  const oldEl = doc.getElementById(HIGHLIGHT_OVERLAY_ID);
  for (const el of els) el.remove();
  if (oldEl) oldEl.remove();
}

/* ----------------------------- translate + popup ----------------------------- */

async function doTranslate(
  innerWin: Window,
  reader: _ZoteroTypes.ReaderInstance,
  word: string,
  lastWordRef: { get: () => string; set: (v: string) => void },
  contextLineRef: { get: () => string; set: (v: string) => void },
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
    "min-width:120px",
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
  result.style.cssText = `color:${tc.primary};white-space:pre-wrap;word-break:break-word;font-size:${fontSize}px;line-height:${lineHeight};font-weight:400;padding-left:4px;`;

  // Flex row: left column (word + translation) + right circular button
  const row = doc.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;";

  const leftCol = doc.createElement("div");
  leftCol.style.cssText = "flex:1;min-width:0;";

  leftCol.appendChild(raw);
  leftCol.appendChild(status);
  leftCol.appendChild(result);
  row.appendChild(leftCol);
  popup.appendChild(row);

  // Position near cursor (use last known mouse pos stored on dataset via window).
  positionPopup(innerWin, popup);

  doc.body?.appendChild(popup);

  // +生词本 button — create immediately with the popup shell, before
  // translation completes.  Keep a ref so auto-add can drive states.
  const wordBtn = maybeAddWordButton(innerWin, row, word, "hover");

  // Perform translation via Translate for Zotero.
  let tr: any;
  if (getPref("translateEngine") === "dict") {
    // Dict engine (faster): query dictSource and extract first definition.
    // Apply lemma reduction so inflected forms (e.g. "links") use the base
    // word ("link") and get proper definitions instead of "link的复数".
    const dictWord = getPref("lemmaMode") === "lemma" ? toLemma(word) : word;
    const dictR = await fetchDictResult(dictWord, reader);
    if (dictR?.result) {
      tr = { ok: true, result: extractFirstDefinition(dictR.result), task: { audio: dictR.audio } };
    } else {
      // Fallback: use translateSource if dictSource returns nothing
      tr = await translateWord(word, reader);
    }
  } else {
    tr = await translateWord(word, reader);
  }
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

/** Check if a string looks like IPA phonetic notation (contains Unicode IPA characters). */
function looksLikeIPA(s: string): boolean {
  return /[ˈˌa-zA-Zəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑɝɚɘɵɤɨ]{4,}/.test(s);
}

/** Extract phonetic notation from a dictionary/translation result string. */
function extractPhonetic(text: string): string {
  if (!text) return "";
  // 1. Try [...] (e.g. 英 [ˈkɒmpjʊtə])
  let m = text.match(/\[([^\]]+?)\]/);
  if (m) return m[1];
  // 2. Try /.../ (e.g. /ˈkɒmpjʊtə/)
  m = text.match(/\/([^\/]+?)\//);
  if (m) return m[1];
  // 3. Try the first word of the first line if it looks like IPA
  const firstLine = text.split("\n")[0].trim();
  const firstWord = firstLine.split(/[\s,;]/)[0];
  if (firstWord && looksLikeIPA(firstWord)) return firstWord;
  return "";
}

  // For local platform, fetch full dictionary result for exp + phon
  let expText = (tr.result || "").trim();
  let phonText = "";
  if (wordBtn && getPref("wordbookPlatform") === "local") {
    // Determine which word to query: when lemma mode is on, use the
    // headword so phon/exp match the stored word (not the inflected form).
    const dictWord = getPref("lemmaMode") === "lemma" ? toLemma(word) : word;
    const dictResult = await fetchDictResult(dictWord, reader);
    if (dictResult) {
      expText = dictResult.result.trim();
      // Extract phon from dict task's audio (first entry only, single IPA)
      if (dictResult.audio.length > 0) {
        const raw = (dictResult.audio[0].text || "").trim();
        if (raw) phonText = stripAudioText(raw);
      }
      // Fallback: try to extract phon from the dict result text
      if (!phonText) phonText = extractPhonetic(dictResult.result);
    }
    // Fallback: try main translate task's audio
    if (!phonText && tr.task?.audio?.length > 0) {
      const raw = (tr.task.audio[0].text || "").trim();
      if (raw) phonText = stripAudioText(raw);
    }
    // Fallback: try tr.result text
    if (!phonText) phonText = extractPhonetic(tr.result || "");
    // Wrap single IPA in /.../ format
    if (phonText) phonText = "/" + phonText + "/";
  }

  // Store translation data on button for wordbook addition
  if (wordBtn) {
    wordBtn.dataset.trResult = expText;
    wordBtn.dataset.phon = phonText;
  }

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

  // Start auto-close timer now that the translation is visible.
  schedulePopupAutoClose(innerWin);

  // Auto-add mode: drive the button through the same states as a click.
  if (
    getPref("enableEudicSync") &&
    getPref("addWordMode") === "auto" &&
    isSingleEnglishWord(word) &&
    wordBtn
  ) {
    void autoAddWordWithButton(word, wordBtn, expText, phonText);
  }
}

/** Run an auto-add and reflect the result on the button (mirrors manual click). */
async function autoAddWordWithButton(
  word: string,
  btn: HTMLButtonElement,
  trResult?: string,
  phonText?: string,
) {
  try {
    const win = btn.ownerDocument?.defaultView as Window | null;
    if (win) _cancelAutoClose(win);
    btn.textContent = "+";
    btn.setAttribute("disabled", "true");
    const ok = await addWordToEudic(word, trResult || "", phonText || "");
    if (ok) {
      btn.textContent = "✓";
      btn.style.color = "#22c55e";
      btn.style.borderColor = "#22c55e";
    } else {
      btn.textContent = "✗";
      btn.style.color = "#ef4444";
      btn.style.borderColor = "#ef4444";
    }
    if (win) _resumeAutoClose(win);
    setTimeout(() => {
      const tc = getThemeColors(win || undefined);
      btn.textContent = "+";
      btn.style.color = tc.raw;
      btn.style.borderColor = tc.btnBorder;
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
 *  in a feedback cycle (\"✓\" / \"✗\").  If so it re-arms
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
    if (btn && btn.textContent !== "+") {
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
  isHtml?: boolean,
) {
  const tc = getThemeColors(doc.defaultView || undefined);
  const ex = doc.createElement("div");
  if (isHtml) {
    ex.innerHTML = text;
  } else {
    ex.textContent = text;
  }
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
  // Read pdf-translate's dict source. On a cold start our plugin may
  // load before pdf-translate has registered its pref defaults, so retry
  // once after a short delay if the value is missing.
  let dictSource: string = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const enabled = Zotero.Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.enableDict",
        true,
      ) as boolean;
      if (!enabled) {
        dbg("fillDictionaryResult: dict disabled in pdf-translate");
        return;
      }
      dictSource = (Zotero.Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.dictSource",
        true,
      ) as string) || "";
    } catch { /* ignore */ }
    if (dictSource) break;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
  }
  if (!dictSource) {
    dbg("fillDictionaryResult: dictSource still empty after retry, skipping");
    return;
  }
  try {
    const task = await pdf.api.translate(word, {
      pluginID: config.addonID,
      service: dictSource,
      itemID: reader.itemID,
    });
    if (task && task.status === "success" && task.result) {
      const tc = getThemeColors(doc.defaultView || undefined);
      const formatted = task.result
        .replace(/;\s*/g, '\n')
        .replace(/\s+(n\.|adj\.|adv\.|v\.|vi\.|vt\.|prep\.|conj\.|pron\.|int\.|网络释义)\s*/gi,
          (_: string, pos: string) => `\n<span style="color:${tc.primary}">${pos}</span> `)
        .replace(/^\n+/, '');
      appendExtraResult(doc, popup, formatted, fontSize, lineHeight, true);
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
  container: HTMLElement,
  word: string,
  scene: "hover" | "selection",
): HTMLButtonElement | null {
  if (!getPref("enableEudicSync")) return null;
  const scenePref = getPref("buttonShowScene");
  if (scenePref !== "both" && scenePref !== scene) return null;
  if (!isSingleEnglishWord(word)) return null;
  const platform = getPref("wordbookPlatform") as string;
  const hasStorage = platform === "maimemo"
    ? !!getPref("maimemoToken")
    : platform === "shanbay"
      ? !!getPref("shanbayToken")
      : platform === "local"
      ? true
      : !!getPref("eudicToken");
  if (!hasStorage) return null;

  const doc = container.ownerDocument!;
  const tc = getThemeColors(innerWin);

  const btn = doc.createElement("button");
  btn.textContent = "+";
  // Circular outline button, placed to the right of word + translation.
  btn.style.cssText = [
    "width:28px",
    "height:28px",
    "min-width:28px",
    "flex-shrink:0",
    "border-radius:6px",
    "box-shadow:0 0 4px rgba(128,128,128,0.15)",
    `border:1.5px solid ${tc.btnBorder}`,
    "background:transparent",
    "padding:0",
    `color:${tc.raw}`,
    "font-size:16px",
    "font-weight:bold",
    "cursor:pointer",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "transition:color 0.2s, border-color 0.2s",
  ].join(";");

  btn.addEventListener("click", async () => {
    _cancelAutoClose(innerWin);
    btn.textContent = "+";
    btn.setAttribute("disabled", "true");
    const trResult = btn.dataset.trResult || "";
    const phon = btn.dataset.phon || "";
    const ok = await addWordToEudic(word, trResult, phon);
    if (ok) {
      btn.textContent = "✓";
      btn.style.color = "#22c55e";
      btn.style.borderColor = "#22c55e";
    } else {
      btn.textContent = "✗";
      btn.style.color = "#ef4444";
      btn.style.borderColor = "#ef4444";
    }
    _resumeAutoClose(innerWin);
    setTimeout(() => {
      btn.textContent = "+";
      btn.style.color = tc.raw;
      btn.style.borderColor = tc.btnBorder;
      btn.removeAttribute("disabled");
    }, 1000);
  });

  container.appendChild(btn);
  return btn;
}

/**
 * Query zotero-pdf-translate's dictionary engine (dictSource) for a
 * full dictionary entry (phonetics + definitions), used as `exp` for
 * the local CSV wordbook.
 *
 * Returns both the result text and audio IPA entries, because some
 * services (e.g. BingDict) ONLY populate audio with IPA but NOT the
 * result text.
 */
async function fetchDictResult(
  word: string,
  reader: _ZoteroTypes.ReaderInstance,
): Promise<{ result: string; audio: { text: string; url: string }[] } | null> {
  try {
    const pdf = (Zotero as any).PDFTranslate;
    if (!pdf?.api?.translate) return null;
    const enabled = Zotero.Prefs.get(
      "extensions.zotero.ZoteroPDFTranslate.enableDict", true,
    ) as boolean;
    if (!enabled) return null;
    const dictSource = Zotero.Prefs.get(
      "extensions.zotero.ZoteroPDFTranslate.dictSource", true,
    ) as string;
    if (!dictSource) return null;

    // Use dictCache so preheat/mousedown-preheat also caches dict results
    const cacheKey = `${word}|${dictSource}`;
    const cached = dictCache.get(cacheKey);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const task = await pdf.api.translate(word, {
          pluginID: config.addonID,
          service: dictSource,
          itemID: reader.itemID,
        });
        if (!task?.result) {
          dictCache.delete(cacheKey);
          return null;
        }
        return { result: task.result, audio: task.audio || [] };
      } catch {
        dictCache.delete(cacheKey);
        return null;
      }
    })();

    dictCache.set(cacheKey, promise);
    return promise;
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction: from an audio text value, extract the bare IPA.
 * Handles various service formats:
 *   BingDict:      "ˈkɒmpjʊtə"           → "ˈkɒmpjʊtə"
 *   YoudaoDict:    "英 [ˈkɒmpjʊtə]"       → "ˈkɒmpjʊtə"
 *   HaiciDict:     "英 [ˈkɒmpjʊtə] 英"   → "ˈkɒmpjʊtə"
 *   CambridgeDict: "uk ˈkɒmpjʊtə  "      → "ˈkɒmpjʊtə"
 */
/** Extract first definition line from a dictionary result, stripping word-class labels. */
function extractFirstDefinition(dict: string): string {
  if (!dict) return "";
  // BingDict returns ALL definitions on a SINGLE LINE like:
  //   "n. 图像；偶像；肖像； v. 反映；想像； 网络释义： 图片；影像"
  // We need only the FIRST definition within the first word-class:
  //   → "图像"
  const lines = dict.replace(/\r/g, "").split("\n");
  const defRe = /^\s*(linkv|attrib|auxv|interrog|interj|prefix|suffix|abbr|modal|modv|phr|idm|comb|pref|suff|sing|pl|pred|na|n|vt|vi|adj|adv|a|ad|prep|conj|pron|int|art|aux|det|num|qua|sym|v)\.\s*/i;
  // Split at: semicolons (define separators), then next word-class, then 网络释义
  const splitRe = /[;；]|\s+(?:linkv|attrib|auxv|interrog|interj|prefix|suffix|abbr|modal|modv|phr|idm|comb|pref|suff|sing|pl|pred|na|n|vt|vi|adj|adv|a|ad|prep|conj|pron|int|art|aux|det|num|qua|sym|v)\.\s|网络释义/i;

  let result = "";

  // 1. Try each line — match POS tag at start
  const found = lines.find((l) => defRe.test(l));
  if (found) {
    const s = found.replace(defRe, "").trim();
    result = s.split(splitRe)[0].trim();
  }

  // 2. For single-line dicts: find POS tag ANYWHERE in the line
  if (!result) {
    for (const line of lines) {
      const m = line.match(defRe);
      if (m && m.index != null) {
        const s = line.slice(m.index + m[0].length).trim();
        const first = s.split(splitRe)[0].trim();
        if (first) { result = first; break; }
      }
    }
  }

  // 3. Fallback: first line with significant Chinese content (skip phonetic lines)
  if (!result) {
    const cnLine = lines.find((l) => {
      const stripped = l.replace(/^[\s\u82f1\u7f8e\uff3a\uff4a\uff4b\uff35\uff2b\uff33\uff35\uff33]/i, "").trim();
      return /[\u4e00-\u9fff]/.test(stripped);
    });
    if (cnLine) result = cnLine.trim();
  }

  // 4. Last fallback: first non-empty line
  if (!result) {
    const first = lines.find((l) => l.trim());
    result = first ? first.trim() : "";
  }

  // 5. Post-process: strip parenthetical notes like
  //    "(材料对光或辐射的)反射率" → "反射率"
  //    "（材料对光或辐射的）反射率" → "反射率"  (full-width parens)
  //    "（用于）强调"              → "强调"
  //    "在(某处)发生"             → "在发生"
  //    Only apply when meaningful content remains.
  const stripped = result.replace(/\s*[(（][^)）]+[)）]\s*/g, " ").replace(/\s+/g, " ").trim();
  if (stripped) {
    result = stripped;
  }

  return result;
}

function stripAudioText(raw: string): string {
  // Try brackets first: "英 [ˈkɒmpjʊtə]" → "ˈkɒmpjʊtə"
  const bracketM = raw.match(/\[([^\]]+?)\]/);
  if (bracketM) return bracketM[1];
  // Strip language/region prefix: "uk ˈkɒmpjʊtə" → "ˈkɒmpjʊtə"
  const stripped = raw.replace(/^[a-z]{2}\s+/i, "").trim();
  return stripped;
}

async function addWordToEudic(
  word: string,
  translateResult?: string,
  phon?: string,
): Promise<boolean> {
  // Lemmatise inflected forms to dictionary headwords before API call
  // when lemmaMode is "lemma"; skip lemmatisation when "inflected".
  const raw = getPref("lemmaMode") === "lemma" ? toLemma(word) : word;
  // Remove sentence-case capitalization (e.g. "Subsequently" → "subsequently")
  // but preserve true acronyms / all-caps words (e.g. "NASA" stays "NASA").
  const lemma =
    word === word.toUpperCase() && word.length > 1
      ? raw
      : raw.toLowerCase();
  if (lemma !== word) {
    try {
      Zotero.debug(
        `[hover-translate-eudic] lemmatise: "${word}" → "${lemma}"`
      );
    } catch { /* ignore */ }
  }
  const platform = getPref("wordbookPlatform") as string;
  if (platform === "maimemo") {
    const client = createMaimemoClientFromPrefs();
    if (!client) return false;
    const categoryId = getPref("maimemoCategoryId") as string;
    const res = await client.addWord(word.toLowerCase(), categoryId);
    return res.success;
  }
  if (platform === "local") {
    return addWordToLocal({
      word: lemma,
      phon: phon || "",
      exp: translateResult || "",
    });
  }
  if (platform === "shanbay") {
    const client = createShanbayClientFromPrefs();
    if (!client) return false;
    const res = await client.addWord(word.toLowerCase());
    return res.success;
  }
  // platform === "eudic" (explicit guard, not fallthrough)
  if (platform !== "eudic") {
    Zotero.debug(`[hover-translate-eudic] unknown platform="${platform}", skipping`);
    return false;
  }
  const client = createEudicClientFromPrefs();
  if (!client) return false;
  const categoryId = getPref("eudicCategoryId");
  const res = await client.addWord(lemma, categoryId);
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
