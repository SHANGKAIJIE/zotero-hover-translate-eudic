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
import { addWordToNote as addWordToZoteroNote, getNoteTitle } from "./zoteroNote";
import { setActiveAddBtn, installAddWordShortcut } from "./addWordShortcut";
import {
  locateWordHybrid,
  pdfRectsToViewport,
  wordAnchorFromLocated,
  clearPageLocatorCache,
  getPdfViewerApp,
  type LocatedWord,
} from "./wordLocator";

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
type DictResult = {
  result: string;
  audio: { text: string; url: string }[];
  service: string;
};
const dictCache: Map<string, Promise<DictResult | null>> = new Map();

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
let _themeObserver: MutationObserver | null = null;

function initThemeWatcher() {
  try {
    const mainWin = Zotero.getMainWindow();
    // 系统级兜底：OS 主题变化时清缓存
    const mql = mainWin.matchMedia("(prefers-color-scheme: dark)");
    if (mql) {
      mql.addEventListener("change", () => {
        _cachedDark = null;
        refreshAllPopupThemes();
      });
    }
    // Zotero 级（zotero-style 约定）：主窗口 <window> 根元素上的
    // theme="dark"/"light" 属性是用户切换日间/夜间的权威信号。
    // 用 MutationObserver 监听该属性变化，实时清缓存 + 重绘已打开弹窗。
    const root = mainWin.document.documentElement;
    if (root && typeof MutationObserver !== "undefined") {
      _themeObserver = new MutationObserver(() => {
        _cachedDark = null;
        refreshAllPopupThemes();
      });
      _themeObserver.observe(root, {
        attributes: true,
        attributeFilter: ["theme", "data-theme", "class"],
      });
    }
  } catch {
    /* ignore */
  }
}

function stopThemeWatcher() {
  try {
    _themeObserver?.disconnect();
  } catch {
    /* ignore */
  }
  _themeObserver = null;
}

/**
 * 主题切换后重绘所有已打开的 hover 弹窗与悬停高亮
 * （跟随 zotero-style：window[theme="dark"] 变化 → 实时更新，无需重新翻译）。
 */
function refreshAllPopupThemes() {
  for (const { innerWin } of attached.values()) {
    try {
      // 弹窗换肤：更新根元素 CSS 变量
      const popup = innerWin.document.getElementById(POPUP_ID) as HTMLElement | null;
      if (popup) applyThemeVars(popup, getThemeColors(innerWin));
      // 悬停高亮换色：夜间 normal+半透明（白字可读），日间 multiply+原色
      const dark = isDarkMode(innerWin);
      const blend = dark ? "normal" : "multiply";
      const baseColor = getPref("highlightColor") || "rgba(255,233,79,1.0)";
      const bg = dark ? toTranslucent(baseColor, 0.4) : baseColor;
      const hl = innerWin.document.querySelectorAll(
        `.${HIGHLIGHT_CLASS}, #${HIGHLIGHT_OVERLAY_ID}`,
      );
      for (const el of hl) {
        (el as HTMLElement).style.mixBlendMode = blend;
        (el as HTMLElement).style.background = bg;
      }
    } catch {
      /* ignore detached reader */
    }
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
  stopThemeWatcher();
  setActiveAddBtn(null); // 清除快捷键活跃按钮引用
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
      const hitRange = lastHitRef.get()?.range;
      doTranslate(activeWinRef.win, reader, word, lastWordRef, contextLineRef, hitRange);
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
    // 仅对 PDF 渲染窗口处理取词:鼠标移到左侧注释/笔记面板等非 PDF 区域时,
    // 不取词,并清除所有已监控窗口的高亮——避免注释面板文本被误取词后
    // 在 PDF 上反查到词导致高亮莫名出现、位置混乱。
    if (!isPdfViewerWindow(win)) {
      for (const w of targets) {
        try {
          (w as any).__hteHighlightSeq = ((w as any).__hteHighlightSeq || 0) + 1;
          clearHighlight(w);
        } catch {
          /* ignore */
        }
      }
      lastHitRef.set(null);
      return;
    }
    // While the user is actively selecting text (mouse down + dragging),
    // suppress hover so it does not fight the selection gesture. Annotation
    // ranges kept live by Zotero in the textLayer selection are NOT treated
    // as "selecting" (no mouse button pressed), so annotated text stays
    // hoverable — no click needed to recover.
    if (getPref("disableOnSelection")) {
      try {
        if (isSelectingText(ev, activeWinRef.win)) {
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
      // 仅 PDF 渲染窗口取词(注释面板点击不触发 preheat)
      if (!isPdfViewerWindow(win)) return;
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
      // Yield to Zotero's selection toolbar / Translate's selection popup
      // while visible (let its buttons handle the click); annotated text
      // without a popup remains click-to-translate as usual.
      if (getPref("disableOnSelection")) {
        if (
          isSelectionPopupActive(activeWinRef.win) ||
          isTranslatePopupVisible(activeWinRef.win)
        ) {
          return;
        }
      }
      const win = (ev.view as Window) || activeWinRef.win;
      activeWinRef.win = win;
      // 仅 PDF 渲染窗口取词(点击注释面板不触发翻译/高亮)
      if (!isPdfViewerWindow(win)) {
        clearHover(win);
        return;
      }
      const hit = getWordAtPoint(win.document, ev.clientX, ev.clientY);
      if (!hit) {
        clearHover(win);
        return;
      }
      lastWord = hit.word;
      if (getPref("enableHighlight")) {
        void highlightHit(win, reader, hit, ev.clientX, ev.clientY);
      }
      // Translate immediately (no debounce for click mode).
      void doTranslate(win, reader, hit.word, lastWordRef, contextLineRef, hit.range);
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
        void highlightHit(activeWinRef.win, reader, hit);
      }
      void doTranslate(activeWinRef.win, reader, hit.word, lastWordRef, contextLineRef, hit.range);
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
      // 递增序号使飞行中的 highlightHit 失效,避免其完成后复活已清除的高亮
      (activeWinRef.win as any).__hteHighlightSeq = ((activeWinRef.win as any).__hteHighlightSeq || 0) + 1;
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
  const shortcutCleanups: (() => void)[] = [];
  for (const win of targets) {
    try {
      win.addEventListener("mousemove", onMouseMove as any, true);
      win.addEventListener("mousedown", onMouseDown as any, true);
      win.addEventListener("mouseup", onMouseUp as any, true);
      win.addEventListener("keydown", onKeyDown as any, true);
      win.addEventListener("mouseout", onMouseLeave as any, true);
      win.document.addEventListener("selectionchange", onSelectionChange as any);
      // 加词快捷键：独立 capture 监听（命中后 activeBtn.click()，不干扰现有 onKeyDown）。
      shortcutCleanups.push(installAddWordShortcut(win));
    } catch (e) {
      dbg(`register failed on ${safeHref(win)}: ${e}`);
    }
  }

  // ── scalechange reflow:缩放变化时用 C 字符 rect 重算高亮 + 重定位弹窗 ──
  // 参考 sentence-translator 的 reflow 机制,消除缩放后高亮/弹窗漂移。
  const onScaleChange = () => {
    try {
      const located = (activeWinRef.win as any).__hteLastLocated as LocatedWord | null | undefined;
      const range = (activeWinRef.win as any).__hteLastRange as Range | null | undefined;
      if (!located || !range) return;
      // 先清空旧高亮,再按当前 viewport 重算(位置跟随新缩放)
      applyHighlight(activeWinRef.win, range, located);
      const popup = activeWinRef.win.document.getElementById(POPUP_ID) as HTMLElement | null;
      if (popup) {
        try {
          repositionHoverPopup(activeWinRef.win, popup, range);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };
  let scaleEventBus: any = null;
  let scaleRetryTimer: number | null = null;
  const tryRegisterScale = () => {
    try {
      const app = getPdfViewerApp(innerWin);
      const eb = app?.eventBus ?? null;
      if (eb?.on) {
        eb.on("scalechanging", onScaleChange);
        eb.on("scalechanged", onScaleChange);
        scaleEventBus = eb;
        dbg(`scalechange reflow registered`);
      } else {
        // viewer iframe 可能尚未就绪,延迟重试(attach 时 iframe 常未加载完)
        dbg(`scalechange register retry: no eventBus yet (app=${!!app})`);
        scaleRetryTimer = (innerWin as any).setTimeout?.(tryRegisterScale, 1000) ?? null;
      }
    } catch (e) {
      dbg(`scalechange register error: ${e}`);
      scaleRetryTimer = (innerWin as any).setTimeout?.(tryRegisterScale, 1000) ?? null;
    }
  };
  tryRegisterScale();

  const cleanup = () => {
    try {
      if (scaleRetryTimer != null) {
        (innerWin as any).clearTimeout?.(scaleRetryTimer);
        scaleRetryTimer = null;
      }
    } catch { /* ignore */ }
    try {
      if (scaleEventBus?.off) {
        scaleEventBus.off("scalechanging", onScaleChange);
        scaleEventBus.off("scalechanged", onScaleChange);
      }
    } catch { /* ignore */ }
    try {
      clearPageLocatorCache(reader);
    } catch { /* ignore */ }
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
    for (const off of shortcutCleanups) {
      try {
        off();
      } catch { /* ignore */ }
    }
    shortcutCleanups.length = 0;
    try {
      delete (innerWin as any).__hteLastLocated;
      delete (innerWin as any).__hteLastRange;
    } catch { /* ignore */ }
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

/**
 * 是否为 PDF 渲染窗口(reader 的 viewer iframe:含 .textLayer / .page,
 * 或暴露 PDFViewerApplication)。左侧注释/笔记面板、reader 顶层窗口等
 * 非 PDF 区域一律返回 false —— 取词高亮仅针对 PDF 界面。
 */
function isPdfViewerWindow(win: Window): boolean {
  try {
    if (!win?.document) return false;
    if ((win as any).PDFViewerApplication) return true;
    const doc = win.document;
    return (
      !!doc.querySelector(".textLayer") ||
      !!doc.querySelector(".page[data-page-number]")
    );
  } catch {
    return false;
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

    // While the user is actively selecting text (mouse down + dragging),
    // suppress the whole hover (highlight + popup) so it does not fight the
    // selection gesture. Annotation ranges kept live by Zotero in the textLayer
    // selection are NOT "selecting" (no button pressed) → annotated text stays
    // hoverable.
    if (getPref("disableOnSelection") && isSelectingText(ev, innerWin)) {
      clearHover(innerWin);
      return;
    }
    // Zotero's selection toolbar / Translate's selection popup visible
    // (user just finished selecting) → keep word highlighting but skip the
    // hover translate popup (avoid popup overlap). The toolbar check covers
    // the gap before Translate sets translate-task-id.
    const selectionPopupVisible =
      getPref("disableOnSelection") &&
      (isSelectionPopupActive(innerWin) || isTranslatePopupVisible(innerWin));

    const hit = getWordAtPoint(innerWin.document, ev.clientX, ev.clientY);
    if (!hit) {
      // Moved off a word — clear highlight but keep popup (timer closes it).
      // 递增序号使飞行中的 highlightHit 失效,避免其完成后复活已清除的高亮。
      (innerWin as any).__hteHighlightSeq = ((innerWin as any).__hteHighlightSeq || 0) + 1;
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
      // C 通道优先(字符 rect 精确),A 通道(range)兜底——渐进增强
      void highlightHit(innerWin, reader, hit, ev.clientX, ev.clientY);
    } else {
      clearHighlight(innerWin);
    }

    // Translate's selection popup is visible → show the word highlight but
    // NOT the hover translate popup (the two popups would overlap).
    if (selectionPopupVisible) {
      clearPopup(innerWin);
      return;
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

/**
 * 是否正在划词（用户按住鼠标左键）。
 *
 * 以「左键按下」为判据（ev.buttons & 1）：覆盖按下未拖动、拖动中、暂停
 * 等全部划词阶段，不要求选区已形成。注释常驻选区悬停时无按键（buttons=0），
 * 不会被误判——已高亮的句子可以正常悬停取词。
 */
function isSelectingText(ev: MouseEvent, _fallbackWin?: Window): boolean {
  try {
    return !!ev && (ev.buttons & 1) !== 0;
  } catch {
    return false;
  }
}

/**
 * 沿窗口链查找选区工具栏/Translate 弹窗元素（.selection-popup）。
 *
 * Zotero 9 的选区工具栏（SelectionPopup）渲染在 reader iframe 的
 * #annotation-overlay 的 shadow DOM 中（annotationOverlay.attachShadow
 * ({mode:"open"})），document.querySelector 无法穿透 shadow DOM，必须通过
 * shadowRoot 查询；同时保留普通 DOM 查询（不同版本/视图渲染位置可能不同，
 * 例如 Translate 弹窗容器）。事件窗口（textLayer 嵌套 iframe）没有
 * #annotation-overlay，需沿 window.parent 链向上找。
 */
function findSelectionPopupEl(win: Window): HTMLElement | null {
  let w: Window | null = win;
  for (let depth = 0; w && depth < 6; depth++, w = w.parent as Window | null) {
    try {
      const doc = w.document;
      if (!doc) continue;
      // 1) 普通 DOM
      const direct = doc.querySelector(".selection-popup") as HTMLElement | null;
      if (direct) return direct;
      // 2) #annotation-overlay 的 shadow DOM
      const overlay = doc.getElementById("annotation-overlay");
      const shadow = overlay ? (overlay as any).shadowRoot : null;
      if (shadow) {
        const popup = shadow.querySelector(".selection-popup") as HTMLElement | null;
        if (popup) return popup;
      }
    } catch {
      /* cross-origin — try parent */
    }
  }
  return null;
}

/**
 * 划词后 Zotero 的选区工具栏（.selection-popup）是否可见。
 *
 * Zotero 在用户划词（创建新选区）后立即显示浮动选区工具栏（高亮/划线按钮），
 * 点击其他位置才消失；而注释常驻选区（悬停时）不会唤出该工具栏。
 * 用它覆盖「划词完成但 Translate 翻译尚未返回」的空白期——此时
 * translate-task-id 属性尚未设置，仅靠 Translate 弹窗检测会漏掉。
 */
function isSelectionPopupActive(win: Window): boolean {
  try {
    const popup = findSelectionPopupEl(win);
    if (!popup || popup.hidden) return false;
    const doc = popup.ownerDocument;
    const style = doc?.defaultView?.getComputedStyle(popup);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Translate for Zotero（划词翻译）弹窗是否可见。
 *
 * 该插件复用 Zotero reader 的 .selection-popup 容器，翻译完成后在容器上设置
 * translate-task-id 属性（zotero-pdf-translate 源码 src/modules/popup.ts）。
 * 有划词翻译弹窗时：允许显示本插件的取词高亮，但抑制悬停翻译弹窗，
 * 避免两个弹窗重叠冲突。
 */
function isTranslatePopupVisible(win: Window): boolean {
  try {
    const popup = findSelectionPopupEl(win);
    if (!popup || popup.hidden) return false;
    if (!popup.hasAttribute("translate-task-id")) return false;
    const doc = popup.ownerDocument;
    const style = doc?.defaultView?.getComputedStyle(popup);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the given viewport point lies inside the current text selection.
 *
 * Zotero keeps the annotation selection (highlight/underline/strikeout created
 * by dragging) as a live DOM selection in the PDF textLayer (setTextLayerSelection).
 * We must only yield to the native selection popup while the pointer is actually
 * over the selected text — otherwise hover lookup would be suppressed forever
 * after any annotation is created (until the user clicks to collapse the range).
 */
function isPointInSelection(win: Window, x: number, y: number): boolean {
  try {
    const sel = win.getSelection();
    if (!sel || sel.isCollapsed) return false;
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const rects = range.getClientRects() ?? [];
      for (let j = 0; j < rects.length; j++) {
        const r = rects[j];
        if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return true;
        }
      }
    }
  } catch {
    /* cross-origin or detached — ignore */
  }
  return false;
}

function getWordAtPoint(
  doc: Document,
  x: number,
  y: number,
): { word: string; range: Range } | null {
  // Gecko exposes caretPositionFromPoint. Zotero Reader 在用户手动创建高亮/
  // 划线标注后会在文本层上方叠加 annotation layer（SVG 覆盖元素），它拦截
  // caretPositionFromPoint 的命中测试，返回 annotation 元素而非文本节点，
  // 导致取词失效（必须先点击一下才能恢复）。
  // 注意：Zotero 并没有内置 "reading-caret-position" class（Zotero 7 源码中
  // 不存在，之前的修复因此无效）。这里改为在取词期间临时禁用 annotation
  // layer 的 pointer-events，取词后立即恢复，不依赖任何 Zotero 内部实现。
  const layers = doc.querySelectorAll(
    ".annotationLayer",
  ) as NodeListOf<HTMLElement>;
  const prevPointerEvents: string[] = [];
  layers.forEach((el: HTMLElement) => {
    prevPointerEvents.push(el.style.pointerEvents);
    el.style.pointerEvents = "none";
  });
  let cp: any = null;
  try {
    cp = (doc as any).caretPositionFromPoint
      ? (doc as any).caretPositionFromPoint(x, y)
      : null;
  } finally {
    layers.forEach((el: HTMLElement, i: number) => {
      el.style.pointerEvents = prevPointerEvents[i];
    });
  }
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

function applyHighlight(
  innerWin: Window,
  range: Range,
  located?: LocatedWord | null,
) {
  clearHighlight(innerWin);
  const doc = innerWin.document;
  const color = getPref("highlightColor") || "rgba(255,233,79,1.0)";
  const dark = isDarkMode(innerWin);
  // 混合模式/不透明度跟随主题：
  //  - 日间：multiply + 原色。pdf.js 阅读器文字画在 canvas 上（黑字），
  //    multiply 让黑字保持深色可读、白底被压成黄色。
  //  - 夜间：normal + 半透明。Zotero 反色后文字是白色，任何混合模式
  //    （multiply/screen）都会破坏白字；改用半透明覆盖层，白字透过
  //    半透明黄色依然清晰，黄色块在黑底上也醒目。
  const blend = dark ? "normal" : "multiply";
  const bg = dark ? toTranslucent(color, 0.4) : color;

  // ── C 通道优先：字符 rect 渲染（PDF 数据层，消除浏览器度量偏差）──
  // 坐标基准:convertToViewportPoint 返回【page 元素局部坐标】,
  // 高亮 div 挂 pageEl 内 position:absolute,直接赋值 left/top,
  // 【不要再减 pageEl 位置】——否则双重偏移,高亮完全错位
  // (sentence-translator 的 positionPdfRect 同此逻辑,已验证)。
  if (located) {
    // 坐标基准:convertToViewportPoint 返回 page 局部坐标,挂到
    // 【同一个 pageEl】(pdfRectsToViewport 返回的,与 viewport 同源)
    // 上,position:absolute 直接赋值 left/top。不能用 range 的 pageEl——
    // 两者 document 可能不同导致整体偏移。
    const { rects: vp, pageEl } = pdfRectsToViewport(innerWin, located.locator, located.rects);
    if (vp.length) {
      dbg(`highlight C: ${vp.length} rects, pageEl=${!!pageEl}, first=(${vp[0].left.toFixed(1)},${vp[0].top.toFixed(1)},${vp[0].width.toFixed(1)}x${vp[0].height.toFixed(1)})`);
      for (const r of vp) {
        const el = doc.createElement("div");
        el.className = HIGHLIGHT_CLASS;
        if (pageEl) {
          el.style.cssText = [
            "position:absolute",
            `left:${r.left}px`, `top:${r.top}px`,
            `width:${r.width}px`, `height:${r.height}px`,
            `background:${bg}`, "border-radius:2px",
            "pointer-events:none", "z-index:20", `mix-blend-mode:${blend}`,
          ].join(";");
          pageEl.appendChild(el);
        } else {
          el.style.cssText = [
            "position:fixed", `left:${r.left}px`, `top:${r.top}px`,
            `width:${r.width}px`, `height:${r.height}px`,
            `background:${bg}`, "border-radius:2px",
            "pointer-events:none", "z-index:20", `mix-blend-mode:${blend}`,
          ].join(";");
          doc.body?.appendChild(el);
        }
      }
    }
    // 记录 C 命中结果，供弹窗锚定 / scalechange reflow 复用
    (innerWin as any).__hteLastLocated = located;
    return;
  }
  (innerWin as any).__hteLastLocated = null;

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
      `background:${bg}`, "border-radius:2px",
      "pointer-events:none", "z-index:20", `mix-blend-mode:${blend}`,
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
      `background:${bg}`, "border-radius:2px",
      "pointer-events:none", "z-index:20", `mix-blend-mode:${blend}`,
    ].join(";");
    pageEl.appendChild(el);
  }
}

/**
 * 高亮辅助:C 通道(字符 rect)优先,A 通道(range)兜底。
 * 命中时把 C 结果写入 win 供弹窗锚定 / reflow 复用。
 */
async function highlightHit(
  innerWin: Window,
  reader: _ZoteroTypes.ReaderInstance,
  hit: { word: string; range: Range },
  mouseX?: number,
  mouseY?: number,
): Promise<void> {
  // 竞态防护:C 通道首次构建页定位器耗时较长(注入桥接 + getPageData),
  // 快速移动时多个 highlightHit 并发,后发起的不一定后完成,会乱序覆盖
  // 高亮。用 per-window 递增序号标记:任何新的 mousemove / 主动清除都会
  // 递增序号,使旧任务失效,只有「最新一次」允许落盘(applyHighlight/清除)。
  const seq = ((innerWin as any).__hteHighlightSeq || 0) + 1;
  (innerWin as any).__hteHighlightSeq = seq;
  (innerWin as any).__hteLastRange = hit.range;
  let located: LocatedWord | null = null;
  try {
    // 传鼠标坐标:让 C 通道用真实鼠标位置定位,而非 A 的 range 中心
    // (range 是浏览器度量,可能带偏差;鼠标坐标直接转 PDF 更准)
    const result = await locateWordHybrid(reader, innerWin, hit, mouseX, mouseY);
    if ((innerWin as any).__hteHighlightSeq !== seq) return; // 过期,丢弃
    // 词间隙(gap):鼠标在词与词之间的空白处 → 不高亮、不显示弹窗
    if (result && (result as { gap?: boolean }).gap) {
      clearHighlight(innerWin);
      clearPopup(innerWin);
      (innerWin as any).__hteLastLocated = null;
      return;
    }
    located = result as LocatedWord | null;
  } catch {
    if ((innerWin as any).__hteHighlightSeq !== seq) return; // 过期,丢弃
    located = null;
  }
  if ((innerWin as any).__hteHighlightSeq !== seq) return; // 过期,丢弃
  applyHighlight(innerWin, hit.range, located);
}

/**
 * 把颜色转为指定 alpha 的半透明 rgba（支持 #rgb / #rrggbb / rgb() / rgba()）。
 * 解析失败时原样返回。用于夜间模式下高亮改为半透明覆盖层，
 * 保证白色文字透过高亮依然可读。
 */
function toTranslucent(color: string, alpha: number): string {  const c = color.trim();
  // hex: #rgb / #rrggbb
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // rgb() / rgba()
  const rgb = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  }
  return color;
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
  range?: Range,
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
    "min-width:90px",
    "max-width:380px",
    "background:var(--hte-bg, #ffffff)",
    "border:1px solid var(--hte-border, #d4d4d4)",
    "border-radius:8px",
    "box-shadow:var(--hte-shadow, 0 4px 16px rgba(0,0,0,0.18))",
    "padding:6px 8px",
    "font-family:inherit",
    "transition:background-color .2s, border-color .2s, color .2s",
  ].join(";");
  // 主题色板写入 CSS 变量必须在 cssText 赋值之后（cssText 会整体替换 style 属性）
  applyThemeVars(popup, tc);

  const raw = doc.createElement("div");
  raw.textContent = word;
  raw.style.cssText =
    "color:var(--hte-raw, #666666);font-size:12px;margin-bottom:2px;word-break:break-word;transition:color .2s;";

  const status = doc.createElement("div");
  status.textContent = getString("hover-popup-translating");
  status.style.cssText =
    "color:var(--hte-status, #888888);font-size:12px;font-style:italic;transition:color .2s;";

  const result = doc.createElement("div");
  result.style.cssText = `color:var(--hte-primary, #1a1a1a);white-space:pre-wrap;word-break:break-word;font-size:${fontSize}px;line-height:${lineHeight};font-weight:400;padding-left:4px;transition:color .2s;`;

  // Flex row: left column (word + translation) + right circular button.
  // 简洁(仅译文)模式：保持原布局，row 铺满弹窗内容宽度（弹窗宽度自适应内容，
  // 下限 90px / 上限 380px），leftCol flex:1 占满剩余空间，+ 按钮位于弹窗
  // 内容区右缘 —— 单词/译文较短时，按钮与文字之间自然保留一段间距。
  // 完整(译文+字典释义)模式：字典释义会把弹窗撑到很宽，若 row 仍铺满则
  // + 按钮会被推到弹窗最右端。因此让 row 收缩为与简洁模式相同的自适应宽度
  // （width:fit-content + 同样的 90/380 上下限），leftCol 保持 flex:1，
  // 使 + 按钮始终位于与简洁模式相同的水平位置，文字与按钮之间的间距也保留。
  const isFullMode = getPref("translateDisplayMode") === "full";
  const row = doc.createElement("div");
  row.dataset.hteRow = "1"; // 核心区标记（syncPopupLayout 按实际位置调整布局用）
  row.style.cssText = isFullMode
    ? "display:flex;align-items:center;gap:6px;width:fit-content;min-width:90px;max-width:380px;"
    : "display:flex;align-items:center;gap:6px;";

  const leftCol = doc.createElement("div");
  leftCol.style.cssText = "flex:1;min-width:0;";

  leftCol.appendChild(raw);
  leftCol.appendChild(status);
  leftCol.appendChild(result);
  row.appendChild(leftCol);
  popup.appendChild(row);
  // 字典释义独立区域：避免撑高 leftCol，使 + 按钮始终与"单词+译文"垂直居中对齐。
  // 布局方向跟随弹窗与单词的相对位置——核心区（单词/译文/+按钮）永远靠近单词：
  //  - 弹窗在单词上方（preferTop）：释义放弹窗上部，核心区在下（贴近单词顶部）
  //  - 弹窗在单词下方：释义放弹窗下部，核心区在上（贴近单词底部）
  const dictArea = doc.createElement("div");
  dictArea.dataset.hteDict = "1"; // 释义区标记（syncPopupLayout 调整用）
  if (isFullMode && getPref("popupPosition") !== "bottom") {
    popup.insertBefore(dictArea, row); // 释义在 row 之前（弹窗上部）
  } else {
    popup.appendChild(dictArea);
  }

  doc.body?.appendChild(popup);

  // +生词本 button — create immediately with the popup shell, before
  // translation completes.  Keep a ref so auto-add can drive states.
  const wordBtn = maybeAddWordButton(innerWin, row, word, "hover", reader, range);

  // Position anchored to the word's Range bounding box (same coordinates as the
  // highlight) so the popup stays close to the hovered word; falls back to the
  // last mouse position when no range is available.  Called after the popup is
  // in the document so its real size can be measured.
  try {
    positionPopup(innerWin, popup, range);
  } catch (e) {
    // 定位异常绝不能让弹窗停在左上角——记录日志，回退到默认位置
    dbg(`initial position error: ${String((e as any)?.message || e)}`);
    popup.style.left = "4px";
    popup.style.top = "4px";
  }
  // 保存锚点 Range，供翻译完成/释义填充后的重新定位使用
  (popup as any).__hteRange = range;

  // 间距恒定修正：positionPopup 在翻译开始前调用，此时弹窗是「翻译中」高度；
  // 译文/释义填充后弹窗尺寸变化，若不重新定位，多行译文会向下延伸而盖住单词。
  // ① ResizeObserver 兜底：任何尺寸变化（翻译完成、full 模式释义填充、+按钮
  //    状态变化等）都重新定位；② 主流程也在翻译完成/释义填充后显式重定位。
  try {
    const ro = new ResizeObserver(() => {
      try {
        dbg(`popup resized to ${popup.offsetWidth}x${popup.offsetHeight}, repositioning`);
        repositionHoverPopup(innerWin, popup, range);
      } catch (e) {
        dbg(`popup resize reposition error: ${String((e as any)?.message || e)}`);
      }
    });
    ro.observe(popup);
    (popup as any).__hteResizeObserver = ro;
    dbg(`popup resize observer created (${popup.offsetWidth}x${popup.offsetHeight})`);
  } catch (e) {
    dbg(`ResizeObserver unavailable: ${String((e as any)?.message || e)}`);
  }

  // Perform translation via Translate for Zotero.
  let tr: any;
  // +生词本按钮可能在翻译完成前就被点击——把翻译 Promise 挂在按钮上，
  // 点击时若翻译未完成则等待其完成（见 maybeAddWordButton click 处理）。
  const setTrPromise = (p: Promise<any>) => {
    try {
      if (wordBtn) (wordBtn as any)._trPromise = p;
    } catch { /* ignore */ }
    return p;
  };
  if (getPref("translateEngine") === "dict") {
    // Dict engine (faster): query dictSource and extract first definition.
    // 直接查询用户悬停的原文词，不做词形还原——词形还原（lemmaMode）只用于
    // 「加生词本」流程（下方 wordBtn 路径）。悬停翻译要查的是当前悬停的具体词
    // （如 imager），还原成词根（imag）会查到无关词条（如 imag 的「复数虚部」）
    // 或查空导致回退显示完整词典条目。
    const dictPromise = (async () => {
      const dictR = await fetchDictResult(word, reader);
      if (dictR?.result) {
        return {
          ok: true,
          result: extractFirstDefinition(dictR.result, dictR.service),
          task: { audio: dictR.audio },
        };
      }
      return translateWord(word, reader);
    })();
    // 整个 dict 流程挂到按钮（含 fetchDictResult 阶段）
    setTrPromise(dictPromise);
    tr = await dictPromise;
  } else {
    tr = await setTrPromise(translateWord(word, reader));
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
  // 译文已填入 → 显式重定位一次，保持与单词固定间距（多行译文不盖住单词）
  repositionHoverPopup(innerWin, popup, range);

  // For local platform, fetch full dictionary result for exp + phon
  let expText = (tr.result || "").trim();
  let phonText = "";
  // Also fetch full dictionary result when annotation sync + annotation
  // translate is enabled, so the annotation comment/body contains the full
  // dictionary entry instead of just the short translation.
  const needDictForAnnotation = getPref("enableAnnotationSync") &&
    getPref("enableAnnotationTranslate");
  if (wordBtn && (getPref("wordbookPlatform") === "local" ||
                  getPref("wordbookPlatform") === "zotero" ||
                  needDictForAnnotation)) {
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
    void fillDictionaryResult(word, reader, doc, dictArea, fontSize, lineHeight);
  }

  // extraTasks 与 full 模式释义可能已同步填充 → 再重定位一次
  repositionHoverPopup(innerWin, popup, range);

  // Start auto-close timer now that the translation is visible.
  schedulePopupAutoClose(innerWin);

  // Auto-add mode: drive the button through the same states as a click.
  if (
    getPref("enableEudicSync") &&
    getPref("addWordMode") === "auto" &&
    isSingleEnglishWord(word) &&
    wordBtn
  ) {
    void autoAddWordWithButton(word, wordBtn, expText, phonText, reader, range);
  }
}

/** Run an auto-add and reflect the result on the button (mirrors manual click). */
async function autoAddWordWithButton(
  word: string,
  btn: HTMLButtonElement,
  trResult?: string,
  phonText?: string,
  reader?: _ZoteroTypes.ReaderInstance,
  range?: Range,
) {
  try {
    const win = btn.ownerDocument?.defaultView as Window | null;
    if (win) _cancelAutoClose(win);
    btn.textContent = "+";
    btn.setAttribute("disabled", "true");
    // Build annotation context (same as manual click path).
    const lastPos = (win as any)?.__hoverLastPos as { x?: number; y?: number } | undefined;
    const lastLocated = (win as any)?.__hteLastLocated as
      | { rects?: [number, number, number, number][]; locator?: { pageIndex?: number } }
      | null
      | undefined;
    const annotationCtx = reader
      ? {
          attachmentID: (reader as any).itemID as number,
          reader,
          range,
          // 传鼠标坐标:C 通道定位批注几何用真实鼠标位置,不受 textLayer 错位影响
          mouseX: lastPos?.x,
          mouseY: lastPos?.y,
          pdfRects: lastLocated?.rects,
          pageIndex: lastLocated?.locator?.pageIndex,
        }
      : undefined;
    try {
      (globalThis as any).Zotero?.debug?.(
        `[hte-ann] hoverTranslate(auto): building ctx, reader.itemID=${(reader as any)?.itemID}, ` +
        `hasReader=${!!reader}, hasRange=${!!range}`,
      );
    } catch { /* ignore */ }
    const ok = await addWordToEudic(word, trResult || "", phonText || "", annotationCtx);
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
      btn.textContent = "+";
      btn.style.color = "var(--hte-raw, #666666)";
      btn.style.borderColor = "var(--hte-btn-border, rgba(130,130,130,0.38))";
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
  /** 分割线方向：top=分隔线在释义上方（释义位于核心区下方时）；bottom=在释义下方（释义位于核心区上方时） */
  dividerPos: "top" | "bottom" = "top",
) {
  const ex = doc.createElement("div");
  if (isHtml) {
    ex.innerHTML = text;
  } else {
    ex.textContent = text;
  }
  const divider =
    dividerPos === "bottom"
      ? "margin-bottom:4px;border-bottom:1px solid var(--hte-divider, #e0e0e0);padding-bottom:4px;"
      : "margin-top:4px;border-top:1px solid var(--hte-divider, #e0e0e0);padding-top:4px;";
  ex.style.cssText = `color:var(--hte-secondary, #555555);white-space:pre-wrap;word-break:break-word;font-size:${fontSize}px;line-height:${lineHeight};${divider}transition:color .2s;`;
  popup.appendChild(ex);
}

/** Full mode: query Translate for Zotero's dictionary service and append. */
async function fillDictionaryResult(
  word: string,
  reader: _ZoteroTypes.ReaderInstance,
  doc: Document,
  container: HTMLElement,
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
      const formatted = task.result
        .replace(/;\s*/g, '\n')
        .replace(/\s+(n\.|adj\.|adv\.|v\.|vi\.|vt\.|prep\.|conj\.|pron\.|int\.|网络释义)\s*/gi,
          (_: string, pos: string) => `\n<span style="color:var(--hte-primary, #1a1a1a)">${pos}</span> `)
        .replace(/^\n+/, '');
      appendExtraResult(
        doc,
        container,
        formatted,
        fontSize,
        lineHeight,
        true,
        // 分割线方向与 dictArea 插入位置一致：弹窗在单词上方时释义在弹窗上部，
        // 分隔线放释义底部（与下方核心区分隔）；否则放释义顶部
        getPref("popupPosition") !== "bottom" ? "bottom" : "top",
      );
      // 释义已填入 → 重定位，保持与单词固定间距
      const popup = doc.getElementById(POPUP_ID) as HTMLElement | null;
      if (popup) {
        repositionHoverPopup(
          doc.defaultView as Window,
          popup,
          (popup as any).__hteRange as Range | undefined,
        );
      }
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
  // 服务选择：与插件的"译文引擎"设置联动，语义同 pdf-translate 面板的
  // "使用字典服务翻译词语"——
  //   - 译文引擎 = 字典引擎（更快，取首条释义）：单词优先用词典源
  //     dictSource（如必应词典，免费且稳定），失败自动回退翻译源（传
  //     service 数组让 pdf-translate 处理回退）；
  //   - 译文引擎 = 翻译引擎（稍慢，释义更贴切）：一律直接用翻译源
  //     translateSource，不再经过词典源。
  const translateSource = getPdfTranslateSource() || "";
  let service: string | string[] | undefined = translateSource || undefined;
  try {
    if (
      getPref("translateEngine") === "dict" &&
      isSingleEnglishWord(word)
    ) {
      const enableDict = Zotero.Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.enableDict",
        true,
      );
      const dictSource = Zotero.Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.dictSource",
        true,
      );
      if (enableDict && dictSource && dictSource !== translateSource) {
        service = [String(dictSource), translateSource];
      }
    }
  } catch {
    /* keep translateSource */
  }
  const cacheServiceKey = Array.isArray(service)
    ? service.join("|")
    : service || "";
  const cacheKey = makeCacheKey(word, cacheServiceKey, langfrom, langto);

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
        service,
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

/**
 * 安全重定位悬停弹窗（间距恒定修正用）：
 *  - range 有效 → 重新锚定单词包围盒定位
 *  - range 失效（pdf.js 文本层重建等）→ 保持当前位置，不跳回鼠标
 *  - 任何异常 → 记录日志，不中断主流程
 */
function repositionHoverPopup(
  innerWin: Window,
  popup: HTMLElement,
  range?: Range | null,
): void {
  try {
    let hasAnchor = false;
    try {
      hasAnchor = (range?.getClientRects()?.length ?? 0) > 0;
    } catch {
      hasAnchor = false;
    }
    if (!hasAnchor) {
      dbg(`reposition skip: range invalid, keeping current position`);
      return;
    }
    positionPopup(innerWin, popup, range ?? undefined);
  } catch (e) {
    dbg(`reposition error: ${String((e as any)?.message || e)}`);
  }
}

/**
 * 同步弹窗内部布局与「实际显示位置」一致（间距恒定修正的一部分）：
 * 核心区（单词/译文/+按钮，[data-hte-row]）永远靠近单词文本——
 *  - placeBelow（弹窗在单词下方）：释义区在核心区之后（弹窗底部）
 *  - !placeBelow（弹窗在单词上方）：释义区在核心区之前（弹窗顶部）
 * 同时切换释义区分割线方向（border-top/bottom），保证分隔线始终位于
 * 释义区与核心区之间。
 */
function syncPopupLayout(popup: HTMLElement, placeBelow: boolean): void {
  try {
    const dictArea = popup.querySelector<HTMLElement>("[data-hte-dict]");
    const row = popup.querySelector<HTMLElement>("[data-hte-row]");
    if (!dictArea || !row) return;
    // 用字面量 4（DOCUMENT_POSITION_PRECEDING）替代 Node 全局——
    // 主进程特权环境可能没有 Node 常量，直接用 compareDocumentPosition 位掩码
    const dictPrecedesRow =
      (dictArea.compareDocumentPosition(row) & 4) !== 0;
    const wantPrecede = !placeBelow; // 上方模式：释义区在核心区之前
    if (dictPrecedesRow !== wantPrecede) {
      if (wantPrecede) {
        popup.insertBefore(dictArea, row);
      } else {
        popup.appendChild(dictArea);
      }
    }
    // 分割线方向始终与「实际显示位置」同步（独立于位置调整——即使位置无需
    // 移动，也要修正异步填充的释义元素方向：释义创建时按设置偏好设方向，
    // 翻转场景下可能与实际位置不一致，如偏好上方但翻转下方时释义在核心区
    // 之后，分割线必须是 border-top 而不是创建时的 border-bottom）
    for (const ex of Array.from(dictArea.children) as HTMLElement[]) {
      if (placeBelow) {
        ex.style.marginTop = "4px";
        ex.style.borderTop = "1px solid var(--hte-divider, #e0e0e0)";
        ex.style.paddingTop = "4px";
        ex.style.marginBottom = "";
        ex.style.borderBottom = "";
        ex.style.paddingBottom = "";
      } else {
        ex.style.marginBottom = "4px";
        ex.style.borderBottom = "1px solid var(--hte-divider, #e0e0e0)";
        ex.style.paddingBottom = "4px";
        ex.style.marginTop = "";
        ex.style.borderTop = "";
        ex.style.paddingTop = "";
      }
    }
  } catch (e) {
    dbg(`syncPopupLayout error: ${String((e as any)?.message || e)}`);
  }
}

function positionPopup(innerWin: Window, popup: HTMLElement, range?: Range) {
  const vw = innerWin.innerWidth;
  const vh = innerWin.innerHeight;
  const EST_W = 240;
  const EST_H = 120;
  const GAP = 8;

  // 优先锚定单词 Range 的包围盒（与高亮同一套坐标，弹窗永远贴近文本）。
  // C 通道优先：用字符 rect 的视口坐标（精确）；否则回退 range 几何。
  let anchor: { x: number; top: number; bottom: number } | null = null;
  const located = (innerWin as any).__hteLastLocated as LocatedWord | null | undefined;
  if (located) {
    try {
      anchor = wordAnchorFromLocated(innerWin, located);
    } catch {
      anchor = null;
    }
  }
  if (!anchor && range) {
    const rects = range.getClientRects();
    if (rects?.length) {
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (const r of rects) {
        if (r.width === 0 && r.height === 0) continue;
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
      if (isFinite(left)) anchor = { x: left, top, bottom };
    }
  }

  let x: number;
  let y: number;
  let placeBelow: boolean | null = null;

  if (anchor) {
    // 弹窗此时已在文档中（调用方先挂载再定位），实测实际宽高，
    // 避免估算误差导致上方翻转时弹窗离文本太远。
    const W = popup.offsetWidth || EST_W;
    const H = popup.offsetHeight || EST_H;
    // 垂直：按「弹窗位置」偏好决定默认方向（间距均为 GAP）。
    //  - top（单词上方，默认）：优先放文本上方；上方空间不足且下方更大时翻转下方
    //  - bottom（单词下方）：优先放文本下方；下方空间不足时翻转上方
    const spaceBelow = vh - anchor.bottom;
    const spaceAbove = anchor.top;
    const preferTop = getPref("popupPosition") !== "bottom";
    if (preferTop) {
      placeBelow = spaceAbove < Math.min(H, 132) && spaceBelow > spaceAbove;
    } else {
      placeBelow = spaceBelow >= spaceAbove || spaceBelow >= Math.min(H, 132);
    }
    if (placeBelow) {
      y = anchor.bottom + GAP;
    } else {
      y = anchor.top - H - GAP;
    }
    // 水平：左边缘对齐文本左边缘，越界则收进视口。
    x = anchor.x;
    if (x + W > vw) x = Math.max(4, vw - W - 4);
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    if (y + H > vh) y = Math.max(4, vh - H - 4);
  } else {
    // 回退：用鼠标最后位置（原逻辑）。
    const last = (innerWin as any).__hoverLastPos as
      | { x: number; y: number }
      | undefined;
    x = (last?.x ?? vw / 2) + 14;
    y = (last?.y ?? vh / 2) + 18;
    if (x + EST_W > vw) x = (last?.x ?? vw / 2) - EST_W - 14;
    if (x < 4) x = 4;
    if (y + EST_H > vh) y = (last?.y ?? vh / 2) - EST_H - 10;
    if (y < 4) y = 4;
  }

  // 先完成定位（x/y 已就绪），再同步内部布局——布局同步绝不影响弹窗位置
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  if (placeBelow !== null) {
    try {
      syncPopupLayout(popup, placeBelow);
    } catch (e) {
      dbg(`syncPopupLayout error: ${String((e as any)?.message || e)}`);
    }
  }
}

/* ----------------------------- wordbook button ----------------------------- */

function maybeAddWordButton(
  innerWin: Window,
  container: HTMLElement,
  word: string,
  scene: "hover" | "selection",
  reader?: _ZoteroTypes.ReaderInstance,
  range?: Range,
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

  const btn = doc.createElement("button");
  btn.textContent = "+";
  // Circular outline button, placed to the left of word + translation.
  btn.style.cssText = [
    "width:28px",
    "height:28px",
    "min-width:28px",
    "flex-shrink:0",
    "border-radius:6px",
    "box-shadow:0 0 4px rgba(128,128,128,0.15)",
    "border:1.5px solid var(--hte-btn-border, rgba(130,130,130,0.38))",
    "background:var(--hte-btn-bg, rgba(255,255,255,0.04))",
    "padding:0",
    "color:var(--hte-raw, #666666)",
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

    // 等待翻译加载完成（最多 WAIT_TRANSLATION_MS 毫秒）：
    // 若用户点击时翻译还没加载出来，等加载完成后再添加生词，
    // 避免把空翻译 / 简译写入生词本 / 注释。
    // 注意：不能拿 _trPromise 的 result（简译）补写 dataset——主流程在
    // 翻译完成后还会 fetchDictResult 取完整字典释义并写入 dataset.trResult
    // （expText 优先字典释义）。这里只等翻译主体完成，然后轮询等主流程
    // 把字典释义写入 dataset，保证落库的是字典释义而非简译。
    const WAIT_TRANSLATION_MS = 12000;
    try {
      const pending = (btn as any)._trPromise as Promise<any> | undefined;
      if (pending) {
        // 等翻译主体完成（简译显示；随后主流程继续取字典释义写 dataset）
        await Promise.race([
          pending,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_TRANSLATION_MS)),
        ]);
      }
      // 轮询等待主流程把字典释义写入 dataset.trResult（200ms 间隔，超时兜底）
      const deadline = Date.now() + WAIT_TRANSLATION_MS;
      while (!btn.dataset.trResult && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch { /* ignore */ }

    const trResult = btn.dataset.trResult || "";
    const phon = btn.dataset.phon || "";
    const lastPos = (innerWin as any)?.__hoverLastPos as { x?: number; y?: number } | undefined;
    // 取当前高亮词的 PDF 坐标（position 精确定位用）
    const lastLocated = (innerWin as any)?.__hteLastLocated as
      | { rects?: [number, number, number, number][]; locator?: { pageIndex?: number } }
      | null
      | undefined;
    const annotationCtx = reader
      ? {
          attachmentID: (reader as any).itemID as number,
          reader,
          range,
          // 传鼠标坐标:C 通道定位批注几何用真实鼠标位置,不受 textLayer 错位影响
          mouseX: lastPos?.x,
          mouseY: lastPos?.y,
          // PDF 用户空间坐标 rects + 页码（zotero://open-pdf position 参数）
          pdfRects: lastLocated?.rects,
          pageIndex: lastLocated?.locator?.pageIndex,
        }
      : undefined;
    try {
      (globalThis as any).Zotero?.debug?.(
        `[hte-ann] hoverTranslate: building ctx, reader.itemID=${(reader as any)?.itemID}, ` +
        `hasReader=${!!reader}, hasRange=${!!range}`,
      );
    } catch { /* ignore */ }
    const ok = await addWordToEudic(word, trResult, phon, annotationCtx);
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
      btn.style.color = "var(--hte-raw, #666666)";
      btn.style.borderColor = "var(--hte-btn-border, rgba(130,130,130,0.38))";
      btn.removeAttribute("disabled");
    }, 1000);
  });

  // + 按钮位置：左侧 → 插入到行首（单词和译文前面）；右侧 → 追加到行尾（默认）。
  const btnPos = (getPref("wordButtonPosition") as string) || "right";
  if (btnPos === "left") {
    container.insertBefore(btn, container.firstChild);
  } else {
    container.appendChild(btn);
  }
  // 加词快捷键：注册为当前活跃按钮（弹窗可见期间按下快捷键即触发本按钮）。
  setActiveAddBtn(btn);
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
export async function fetchDictResult(
  word: string,
  reader: _ZoteroTypes.ReaderInstance,
): Promise<{
  result: string;
  audio: { text: string; url: string }[];
  /** 词典源 service 名（供 extractFirstDefinition 按词典专用策略提取）。 */
  service: string;
} | null> {
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
        // 显式传 langfrom/langto（与 translateWord 一致）：hover 目标总是
        // 英文单词。缺省时 pdf-translate 会走 autoDetectLanguage 自动推断，
        // 推断结果不稳定可能导致词典源请求失败（表现为 [请求错误]）。
        const task = await pdf.api.translate(word, {
          pluginID: config.addonID,
          service: dictSource,
          itemID: reader.itemID,
          langfrom: "en",
          langto: getPdfTranslateTargetLang(),
        });
        // 必须同时满足 status=success 且有结果。词典服务请求可能 HTTP 成功但
        // 解析失败（如 Bing 页面无 description meta → Parse error），此时
        // task.result 是 "[请求错误] <服务名>..." 错误文本——若当作成功结果，
        // 弹窗会原样显示「请求错误」（extractFirstDefinition 的 fallback 会把
        // 含中文的错误行提取出来）。
        if (!task || task.status !== "success" || !task.result) {
          dbg(
            `fetchDictResult: non-success for "${word}" (service=${dictSource}, status=${task?.status})`,
          );
          dictCache.delete(cacheKey);
          return null;
        }
        return { result: task.result, audio: task.audio || [], service: dictSource };
      } catch (e) {
        dbg(
          `fetchDictResult: request error for "${word}" (service=${dictSource}): ${String((e as any)?.message || e)}`,
        );
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
/** 词性标记词表（用于识别定义行与剥离 POS 前缀）。 */
const POS_WORDS =
  "linkv|attrib|auxv|interrog|interj|prefix|suffix|abbr|modal|modv|phr|idm|comb|pref|suff|sing|pl|pred|na|noun|verb|adjective|adverb|preposition|conjunction|pronoun|interjection|article|determiner|numeral|quantifier|symbol|n|vt|vi|adj|adv|a|ad|prep|conj|pron|int|art|aux|det|num|qua|sym|v";

/** 是否是音标/发音行（英 [...]、美 [...]、uk /.../、/ˈ.../ 等）。 */
function isPhoneticLine(l: string): boolean {
  return (
    // 语言前缀 + 音标：英 [...]、美 [...]、uk /.../、us /.../（容忍 uk/'... 复制失真）
    /^(英|美)\s*[\[/(]/.test(l) ||
    /^(uk|us)\s*[/'\[(]/.test(l) ||
    // /ˈ.../、[ˈ...]、(ˈ.../) 音标行
    (/^[/\[(]/.test(l) && /[ˈˌəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑɝɚɘɵɤɨ]/.test(l)) ||
    // "uk ˈkɒmpjʊtə" / "ˈkɒmpjʊtə" 等无括号形式
    (/^[a-z]+ /i.test(l) &&
      /[ˈˌəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑ]/.test(l) &&
      !/[\u4e00-\u9fff]/.test(l))
  );
}

/** 是否是单独一行的词性标记：剑桥/科林斯的 "noun"/"verb"，剑桥的 "noun[C]"、"verb[I,T]" 变体。 */
function isBarePosLine(l: string): boolean {
  return new RegExp(`^(${POS_WORDS})\\b(?:\\[[^\\]]*\\])?\\.?\\s*$`, "i").test(l);
}

/**
 * 从词典结果中提取第一条释义（简译用）。
 *
 * 以 Translate for Zotero 的 dictSource（service 名）为分流依据，对每个词典
 * 使用专用提取策略——各词典 result 格式差异很大，纯通用启发式易误判：
 *  - webliodict（en-ja）：2.5.2 源码 process2 会把页面描述区标题「意味・対訳」
 *    当作第一项释义。去掉标题前缀后剩余即全部释义，取第一段日文释义
 *  - bingdict / youdaodict / haicidict / collinsdict / cambridgedict（en-zh）：
 *    跳过音标行 / 单独词性行（含 noun[C] 变体）/ 剑桥英文定义行，
 *    取第一个含中文的定义行
 *  - freedictionaryapi（en-en）：取 [noun] 英文定义行
 *  - gramotadict（ru）：取第一个有定义特征的行
 *  - 未知 service：通用启发式兜底
 */
function extractFirstDefinition(dict: string, service?: string): string {
  if (!dict) return "";
  const svc = String(service || "").toLowerCase();
  const lines = dict.replace(/\r/g, "").split("\n").map((l) => l.trim());

  // Weblio（en-ja）专用：标题「意味・対訳」后可能直接接全部释义（同一行）
  if (svc.includes("weblio")) {
    for (const l of lines) {
      if (!l) continue;
      const m = l.match(/^意味[・·]対訳\s*(.*)$/);
      if (m) {
        // 2.5.2 的 process2 用 `:` 连接标题与释义（如 "意味・対訳:....と..."），
        // 去标题前缀后剩余可能以冒号等分隔符开头——先清理再取第一段，否则
        // split 第一段为空 → 简译显示「(无译文)」
        const rest = m[1].replace(/^[:：;；|、,，\s]+/, "").trim();
        if (rest) return cleanDefinition(rest, true);
        continue; // 标题独占一行 → 继续找
      }
      // 跳过区块标题/说明行（コア、項目を...、and/イディオム...）
      if (l === "コア" || /^項目/.test(l) || /^[a-z]+\//i.test(l)) continue;
      if (/[ぁ-んァ-ヶ]/.test(l)) return cleanDefinition(l, true);
    }
    return "";
  }

  let candidate = "";
  // 1. zh 词典：第一个「剥 POS 前缀后行首是中文」的定义行（正式释义行）。
  //    要求中文在行首或紧随 POS 前缀——避免选中英文标注开头的行
  //    （如必应对 were 的 "short. we are;"，行首是英文，切第一段会得到
  //    "short." 噪音）
  for (const l of lines) {
    if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
    // 剑桥英文定义行（"1. guideword definition"）位于其中文释义之前，跳过
    if (/^\d+[.、)）]\s+[A-Za-z]/.test(l)) continue;
    const stripped = l.replace(new RegExp(`^(${POS_WORDS})\\b\\.?\\s*`, "i"), "");
    if (/[\u4e00-\u9fff]/.test(stripped) && !/^[A-Za-z]/.test(stripped)) {
      candidate = l;
      break;
    }
  }
  // 2. 兜底：第一个含中文的行（如必应仅有网络释义行 "网络释义:是;..."）
  if (!candidate) {
    for (const l of lines) {
      if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
      if (/[\u4e00-\u9fff]/.test(l)) {
        candidate = l;
        break;
      }
    }
  }

  // 2. 无中文（en-en / ru / 单释义行）：第一个非音标/非词性/非噪音行
  if (!candidate) {
    for (const l of lines) {
      if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
      if (/^-{2,}$/.test(l)) continue; // 分隔线（freedictionaryapi 的 ----）
      if (/^\[(example|audio|synonym|antonym|note)\]/i.test(l)) continue; // 元信息
      candidate = l;
      break;
    }
  }
  if (!candidate) return "";

  let r = candidate;
  if (/[\u4e00-\u9fff]/.test(r)) {
    r = r.replace(new RegExp(`^(${POS_WORDS})\\b\\.?\\s*`, "i"), "");
  } else {
    r = r.replace(/^\[[a-z]+\]\s*/i, "");
  }
  return cleanDefinition(r, false);
}

/**
 * 清理释义文本：去数字序号、按分隔符取第一段、清理括号注释。
 * 中文/日文释义常以 冒号/分号/顿号/逗号/空格 分隔多个义项，取第一个；
 * 英文定义（freedictionaryapi）保留完整句子，仅按分号/竖线切分。
 */
function cleanDefinition(r: string, jp: boolean): string {
  // 必应网络释义行："网络释义:是;过去式;..." → 剥前缀，取冒号后的第一条
  r = r.replace(/^\s*网络释义\s*[:：]\s*/, "");
  r = r.replace(/^\s*\d+[.、)）]\s*/, "");
  if (jp || /[\u4e00-\u9fff\u3040-\u30ff]/.test(r)) {
    r = r.split(/[:：;；|、,，\s]+/)[0].trim();
  } else {
    r = r.split(/[;；|]/)[0].trim();
  }
  r = r.replace(/\s*[(（][^)）]+[)）]\s*/g, " ").replace(/\s+/g, " ").trim();
  return r;
}

/** Check if a string looks like IPA phonetic notation (contains Unicode IPA characters). */
function looksLikeIPA(s: string): boolean {
  return /[ˈˌa-zA-Zəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑɝɚɘɵɤɨ]{4,}/.test(s);
}

/** Extract phonetic notation from a dictionary/translation result string. */
export function extractPhonetic(text: string): string {
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

export function stripAudioText(raw: string): string {
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
  annotationCtx?: {
    attachmentID: number;
    reader?: any;
    range?: Range;
    viewportRects?: { top: number; left: number; width: number; height: number }[];
    pageIndex?: number;
    pdfRects?: [number, number, number, number][];
  },
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
  // 构建原文跳转链接（zotero://open-pdf/...），供本地生词表 / Zotero 笔记条目跳转使用
  let src = "";
  try {
    const readerAny: any = (annotationCtx as any)?.reader;
    const item: any = readerAny?.item ?? readerAny?._item;
    const pageIndex = (annotationCtx as any)?.pageIndex
      ?? readerAny?.state?.pageIndex;
    const rects = (annotationCtx as any)?.pdfRects;
    if (item?.key) {
      const { buildSourceLink } = await import("./zoteroNote");
      src = buildSourceLink({
        attachmentKey: item.key,
        libraryID: item.libraryID,
        pageIndex: Number.isInteger(pageIndex) ? pageIndex : undefined,
        rects: Array.isArray(rects) && rects.length ? rects : undefined,
      });
    }
  } catch { /* ignore */ }
  let ok = false;
  if (platform === "maimemo") {
    const client = createMaimemoClientFromPrefs();
    if (!client) return false;
    const categoryId = getPref("maimemoCategoryId") as string;
    const res = await client.addWord(word.toLowerCase(), categoryId);
    ok = res.success;
  } else if (platform === "local") {
    // 翻译成功（有释义）→ 正常行；失败 → status=failed, tries=1，
    // 重启 Zotero 后自动重试补全（见 localWordbook.retryFailedLocalWords）
    const hasResult = !!(translateResult && translateResult.trim());
    ok = await addWordToLocal({
      word: lemma,
      phon: phon || "",
      exp: translateResult || "",
      src,
      status: hasResult ? "" : "failed",
      tries: hasResult ? 0 : 1,
    });
  } else if (platform === "shanbay") {
    const client = createShanbayClientFromPrefs();
    if (!client) return false;
    const res = await client.addWord(word.toLowerCase());
    ok = res.success;
  } else if (platform === "zotero") {
    // 翻译成功（有释义）→ completed（不渲染图标）；失败 → failed（渲染 ❌）
    const hasResult = !!(translateResult && translateResult.trim());
    ok = await addWordToZoteroNote({
      title: getNoteTitle(),
      word: lemma,
      phon: phon || "",
      exp: translateResult || "",
      src,
      status: hasResult ? "completed" : "failed",
      tries: hasResult ? 0 : 1,
    });
  } else {
    // platform === "eudic" (explicit guard, not fallthrough)
    if (platform !== "eudic") {
      Zotero.debug(`[hover-translate-eudic] unknown platform="${platform}", skipping`);
      return false;
    }
    const client = createEudicClientFromPrefs();
    if (!client) return false;
    const categoryId = getPref("eudicCategoryId");
    const res = await client.addWord(lemma, categoryId);
    ok = res.success;
  }

  // 同步至本地：平台为云端（欧路/扇贝/墨墨）时，若开启「同步至本地」，
  // 额外将单词写入本地生词表 / Zotero 笔记（词形还原与主平台一致）。
  if (ok && (platform === "eudic" || platform === "shanbay" || platform === "maimemo")) {
    const syncMode = getPref("syncToLocal") as string;
    if (syncMode === "local") {
      try {
        const hasResult = !!(translateResult && translateResult.trim());
        await addWordToLocal({
          word: lemma,
          phon: phon || "",
          exp: translateResult || "",
          src,
          status: hasResult ? "" : "failed",
          tries: hasResult ? 0 : 1,
        });
      } catch (e: any) {
        try {
          Zotero.debug(`[hover-translate-eudic] syncToLocal local error: ${e?.message || e}`);
        } catch { /* ignore */ }
      }
    } else if (syncMode === "zotero") {
      try {
        const hasResult = !!(translateResult && translateResult.trim());
        await addWordToZoteroNote({
          title: getNoteTitle(),
          word: lemma,
          phon: phon || "",
          exp: translateResult || "",
          src,
          status: hasResult ? "completed" : "failed",
          tries: hasResult ? 0 : 1,
        });
      } catch (e: any) {
        try {
          Zotero.debug(`[hover-translate-eudic] syncToLocal zotero error: ${e?.message || e}`);
        } catch { /* ignore */ }
      }
    }
  }

  // 加词成功后刷新所有窗口（主窗口 + PDF reader）的生词本面板。
  // 走 Zotero 原生 Notifier("refresh","itempane")，一次刷新所有窗口。
  if (ok) {
    try {
      const { refreshAllPanels } = await import("./wordbookPanel");
      refreshAllPanels();
    } catch { /* ignore */ }
  }

  // Sync annotation after successful wordbook add (best-effort, never throws).
  if (ok && annotationCtx) {
    try {
      try {
        (globalThis as any).Zotero?.debug?.(
          `[hte-ann] hoverTranslate: wordbook add ok, calling syncWordAnnotation, ` +
          `attachmentID=${annotationCtx.attachmentID}, hasRange=${!!annotationCtx.range}, ` +
          `hasReader=${!!annotationCtx.reader}`,
        );
      } catch { /* ignore */ }
      const { syncWordAnnotation } = await import("./annotationSync");
      void syncWordAnnotation({
        attachmentID: annotationCtx.attachmentID,
        word,
        translation: translateResult || "",
        reader: annotationCtx.reader,
        range: annotationCtx.range,
        viewportRects: annotationCtx.viewportRects,
        pageIndex: annotationCtx.pageIndex,
      });
    } catch { /* ignore annotation errors */ }
  } else {
    try {
      (globalThis as any).Zotero?.debug?.(
        `[hte-ann] hoverTranslate: skip sync (ok=${ok}, hasCtx=${!!annotationCtx})`,
      );
    } catch { /* ignore */ }
  }
  return ok;
}

/* ----------------------------- helpers ----------------------------- */

/** Detect if Zotero is in dark mode using multiple strategies. */
function isDarkMode(innerWin?: Window): boolean {
  // Strategy 1 (zotero-style 约定): main window <window> root `theme`
  // attribute — the authoritative signal for Zotero's own day/night toggle
  // (Preferences → Appearance → theme). zotero-style follows it via the
  // `window[theme="dark"]` CSS selector; we read the same attribute.
  try {
    const mainWin = Zotero.getMainWindow();
    const docEl = mainWin.document.documentElement;
    if (docEl) {
      const theme = docEl.getAttribute("theme");
      dbg(`isDarkMode: mainWin theme="${theme}"`);
      if (theme === "dark") return true;
      // 显式 light 也直接采用（Zotero 手动切换日间，不跟随系统）
      if (theme === "light") return false;
    }
  } catch {
    /* ignore */
  }
  // Strategy 2: Check the inner window's matchMedia (system-level fallback,
  // only consulted when the main window has no theme attribute).
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

/**
 * 把主题色板写入弹窗根元素的 CSS 变量。所有子元素通过
 * `var(--hte-*)` 引用颜色，主题切换（zotero-style 的
 * window[theme="dark"] 变化）时只需调用本函数重设根元素变量，
 * 已打开的弹窗即可实时换肤，无需重建 DOM 或重新翻译。
 */
function applyThemeVars(popup: HTMLElement, tc: ReturnType<typeof getThemeColors>) {
  const s = popup.style;
  s.setProperty("--hte-bg", tc.bg);
  s.setProperty("--hte-border", tc.border);
  s.setProperty("--hte-raw", tc.raw);
  s.setProperty("--hte-status", tc.status);
  s.setProperty("--hte-primary", tc.primary);
  s.setProperty("--hte-secondary", tc.secondary);
  s.setProperty("--hte-btn-bg", tc.btnBg);
  s.setProperty("--hte-btn-border", tc.btnBorder);
  s.setProperty("--hte-divider", tc.divider);
  s.setProperty("--hte-shadow", tc.shadow);
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
  // 使飞行中的 highlightHit 任务失效(递增序号),避免其完成后复活已清除的高亮
  (innerWin as any).__hteHighlightSeq = ((innerWin as any).__hteHighlightSeq || 0) + 1;
  clearHighlight(innerWin);
  clearPopup(innerWin);
}

function clearPopup(innerWin: Window) {
  const el = innerWin.document.getElementById(POPUP_ID);
  if (!el) return;
  // 断开 ResizeObserver，避免移除后残留观察器
  try {
    const ro = (el as any).__hteResizeObserver as ResizeObserver | undefined;
    ro?.disconnect();
  } catch {
    /* ignore */
  }
  el.remove();
}
