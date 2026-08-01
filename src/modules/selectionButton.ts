/**
 * Selection-button module.
 *
 * Registers a `renderTextSelectionPopup` listener — but ONLY when the user
 * has enabled Eudic sync. When disabled (the default), this module is
 * completely inert and does NOT touch the reader event chain, so it cannot
 * interfere with Translate for Zotero or other plugins' popups.
 *
 * When enabled, it appends a "+生词本" button to the native selection popup,
 * but ONLY when the selected text is a single pure English word.
 */
import { config } from "../../package.json";
import { getPref, registerPrefObserver } from "../utils/prefs";
import { getString } from "../utils/locale";
import { isSingleEnglishWord, wordRangeAtOffset } from "./util";
import { toLemma } from "./lemmatize";
import { createEudicClientFromPrefs } from "./eudic";
import { createMaimemoClientFromPrefs } from "./maimemo";
import { createShanbayClientFromPrefs } from "./shanbay";
import { addWord as addWordToLocal } from "./localWordbook";
import { getAllReaders, getReaderInnerWindow } from "../utils/window";
import { fetchDictResult } from "./hoverTranslate";

let registered = false;
let listener: ((event: any) => void) | null = null;
let prefObserverSymbol: symbol | null = null;

export function registerSelectionButton() {
  // Watch the enableEudicSync pref and register/unregister accordingly.
  prefObserverSymbol = registerPrefObserver("enableEudicSync", () => {
    syncRegistration();
  });
  syncRegistration();
}

export function unregisterSelectionButton() {
  doUnregister();
}

function syncRegistration() {
  const platform = getPref("wordbookPlatform") as string;
  const hasStorage = platform === "maimemo"
    ? !!getPref("maimemoToken")
    : platform === "shanbay"
      ? !!getPref("shanbayToken")
      : platform === "local"
      ? true
      : !!getPref("eudicToken");
  const shouldEnable =
    getPref("enableEudicSync") && hasStorage;
  if (shouldEnable && !registered) {
    doRegister();
  } else if (!shouldEnable && registered) {
    doUnregister();
  }
}

function doRegister() {
  if (registered) return;
  const R: any = (Zotero as any).Reader;
  if (!R || typeof R.registerEventListener !== "function") return;

  listener = (event: any) => {
    try {
      onRenderTextSelectionPopup(event);
    } catch (e) {
      // Never let an error here break the event chain for other plugins.
      ztoolkit.log("selectionButton: error (suppressed)", e);
    }
  };

  try {
    R.registerEventListener(
      "renderTextSelectionPopup",
      listener,
      config.addonID,
    );
    registered = true;
  } catch (e) {
    ztoolkit.log("selectionButton: register failed", e);
  }
}

function doUnregister() {
  if (!registered || !listener) return;
  const R: any = (Zotero as any).Reader;
  if (R && typeof R.unregisterEventListener === "function") {
    try {
      R.unregisterEventListener("renderTextSelectionPopup", listener);
    } catch {
      /* ignore */
    }
  }
  registered = false;
  listener = null;
}

function onRenderTextSelectionPopup(event: any) {
  const { doc, append } = event;
  const selectedText: string = (event?.params?.annotation?.text || "").trim();
  const annot = event?.params?.annotation;
  const pageIndex = annot?.position?.pageIndex;
  /** PDF user-space rects [x1,y1,x2,y2] from Zotero annotation position. */
  const pdfRects: [number, number, number, number][] | undefined = annot?.position?.rects;
  // Resolve the reader instance for this event (for attachmentID).
  const reader: any = event?.reader || event?.params?.reader || null;

  if (!getPref("enableEudicSync")) return;
  const scenePref = getPref("buttonShowScene");
  if (scenePref !== "both" && scenePref !== "selection") return;
  if (!isSingleEnglishWord(selectedText)) return;
  const platform = getPref("wordbookPlatform") as string;
  const hasStorage = platform === "maimemo"
    ? !!getPref("maimemoToken")
    : platform === "shanbay"
      ? !!getPref("shanbayToken")
      : platform === "local"
      ? true
      : !!getPref("eudicToken");
  if (!hasStorage) return;

  // Build a full-width button styled like llm-for-zotero's "Add Text" button.
  const btn = doc.createElement("button");
  btn.textContent = getString("wordbtn-add");
  btn.style.cssText = [
    "display:block",
    "width:100%",
    "margin:0",
    "padding:6px 8px",
    "box-sizing:border-box",
    "border:1px solid rgba(130,130,130,0.38)",
    "border-radius:6px",
    "background:rgba(255,255,255,0.04)",
    "color:inherit",
    "font-size:12px",
    "line-height:1.25",
    "text-align:center",
    "cursor:pointer",
  ].join(";");

  btn.addEventListener("click", async () => {
    btn.textContent = getString("wordbtn-adding");
    btn.setAttribute("disabled", "true");
    // Capture translation data from pdf-translate textarea (already visible)
    let trResult = "";
    let phon = "";
    try {
      const ta = doc.querySelector(
        ".zoteropdftranslate-popup-textarea, .selection-popup textarea",
      ) as HTMLTextAreaElement | null;
      if (ta && ta.value) {
        trResult = ta.value;
        const match = ta.value.split("\n")[0].match(/\[([^\]]+?)\]/);
        if (match) phon = match[1];
      }
    } catch { /* ignore */ }
    // When annotation sync + annotation translate is enabled, fetch the full
    // dictionary entry (instead of the short translation from the textarea)
    // so the annotation comment/body contains the complete dictionary content.
    if (trResult && reader && getPref("enableAnnotationSync") &&
        getPref("enableAnnotationTranslate")) {
      try {
        (globalThis as any).Zotero?.debug?.(
          `[hte-ann] selectionButton: fetching dict result for annotation, ` +
          `word="${selectedText}"`,
        );
        const dict = await fetchDictResult(selectedText, reader);
        if (dict?.result) {
          (globalThis as any).Zotero?.debug?.(
            `[hte-ann] selectionButton: dict result len=${dict.result.length}, ` +
            `using dict result as trResult for annotation`,
          );
          trResult = dict.result;
        } else {
          (globalThis as any).Zotero?.debug?.(
            `[hte-ann] selectionButton: dict result empty, keeping textarea trResult`,
          );
        }
      } catch (e) {
        (globalThis as any).Zotero?.debug?.(
          `[hte-ann] selectionButton: fetchDictResult error: ${String(e)}`,
        );
      }
    }
    const contextLine = findContextFromReaders(selectedText, undefined, pageIndex);
    // Build annotation context for syncWordAnnotation (selection scene).
    let annotationCtx: any = undefined;
    try {
      const attachmentID = reader?.itemID ?? reader?._item?.id;
      try {
        (globalThis as any).Zotero?.debug?.(
          `[hte-ann] selectionButton: building ctx, reader.itemID=${reader?.itemID}, ` +
          `reader._item?.id=${reader?._item?.id}, resolved attachmentID=${attachmentID}, ` +
          `pdfRectsLen=${pdfRects?.length}, pageIndex=${pageIndex}`,
        );
      } catch { /* ignore */ }
      if (attachmentID && pdfRects && pdfRects.length > 0 && pageIndex != null) {
        annotationCtx = { attachmentID, reader, pdfRects, pageIndex };
      }
    } catch { /* ignore */ }
    const ok = await addWordToEudic(selectedText, trResult, phon, annotationCtx);
    btn.textContent = ok
      ? getString("wordbtn-added")
      : getString("wordbtn-failed");
    setTimeout(() => {
      btn.textContent = getString("wordbtn-add");
      btn.removeAttribute("disabled");
    }, 1000);
  });

  append(btn);

  // Place the button right after Translate for Zotero's translation textarea
  // (class "zoteropdftranslate-popup-textarea"). The textarea may be created
  // by Translate's listener after ours runs, so retry on the next tick.
  const placeAfterTextarea = () => {
    try {
      const ta = doc.querySelector(
        ".zoteropdftranslate-popup-textarea, .selection-popup textarea",
      ) as HTMLElement | null;
      if (ta && ta.parentNode && ta.parentNode !== btn.parentNode) {
        ta.parentNode.insertBefore(btn, ta.nextSibling);
        return true;
      }
      if (ta && ta.parentNode) {
        ta.parentNode.insertBefore(btn, ta.nextSibling);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  };
  if (!placeAfterTextarea()) {
    setTimeout(placeAfterTextarea, 0);
    setTimeout(placeAfterTextarea, 50);
  }

  // Auto-add mode: add immediately after the popup is shown.
  // Use retry to wait for pdf-translate's async textarea population.
  if (getPref("addWordMode") === "auto") {
    // Capture context_line once (readers don't change between retries)
    const contextLine = findContextFromReaders(selectedText, undefined, pageIndex);
    // Build annotation context for syncWordAnnotation (selection scene).
    let autoAnnotationCtx: any = undefined;
    try {
      const attachmentID = reader?.itemID ?? reader?._item?.id;
      try {
        (globalThis as any).Zotero?.debug?.(
          `[hte-ann] selectionButton(auto): building ctx, reader.itemID=${reader?.itemID}, ` +
          `reader._item?.id=${reader?._item?.id}, resolved attachmentID=${attachmentID}, ` +
          `pdfRectsLen=${pdfRects?.length}, pageIndex=${pageIndex}`,
        );
      } catch { /* ignore */ }
      if (attachmentID && pdfRects && pdfRects.length > 0 && pageIndex != null) {
        autoAnnotationCtx = { attachmentID, reader, pdfRects, pageIndex };
      }
    } catch { /* ignore */ }
    const tryAutoAdd = (attempt: number) => {
      let trResult = "";
      let phon = "";
      try {
        const ta = doc.querySelector(
          ".zoteropdftranslate-popup-textarea, .selection-popup textarea",
        ) as HTMLTextAreaElement | null;
        if (ta && ta.value) {
          trResult = ta.value;
          const match = ta.value.split("\n")[0].match(/\[([^\]]+?)\]/);
          if (match) phon = match[1];
        }
      } catch { /* ignore */ }
      if (trResult) {
        // When annotation sync + annotation translate is enabled, fetch the
        // full dictionary entry for the annotation comment/body.
        if (reader && getPref("enableAnnotationSync") &&
            getPref("enableAnnotationTranslate")) {
          (globalThis as any).Zotero?.debug?.(
            `[hte-ann] selectionButton(auto): fetching dict result for annotation, ` +
            `word="${selectedText}"`,
          );
          fetchDictResult(selectedText, reader).then((dict) => {
            if (dict?.result) {
              (globalThis as any).Zotero?.debug?.(
                `[hte-ann] selectionButton(auto): dict result len=${dict.result.length}, ` +
                `using dict result as trResult for annotation`,
              );
              trResult = dict.result;
            } else {
              (globalThis as any).Zotero?.debug?.(
                `[hte-ann] selectionButton(auto): dict result empty, keeping textarea trResult`,
              );
            }
            void addWordToEudic(selectedText, trResult, phon, autoAnnotationCtx);
          }).catch((e) => {
            (globalThis as any).Zotero?.debug?.(
              `[hte-ann] selectionButton(auto): fetchDictResult error: ${String(e)}`,
            );
            void addWordToEudic(selectedText, trResult, phon, autoAnnotationCtx);
          });
        } else {
          void addWordToEudic(selectedText, trResult, phon, autoAnnotationCtx);
        }
      } else if (attempt < 3) {
        // Retry with progressive delay: 150ms → 400ms
        const delay = attempt === 1 ? 150 : 400;
        setTimeout(() => tryAutoAdd(attempt + 1), delay);
      } else {
        // Fallback: add word without phon/exp
        void addWordToEudic(selectedText, "", "", autoAnnotationCtx);
      }
    };
    tryAutoAdd(1);
  }
}

async function addWordToEudic(
  word: string,
  translateResult?: string,
  phon?: string,
  annotationCtx?: {
    attachmentID: number;
    reader?: any;
    pdfRects?: [number, number, number, number][];
    pageIndex?: number;
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
  let ok = false;
  if (platform === "maimemo") {
    const client = createMaimemoClientFromPrefs();
    if (!client) return false;
    const categoryId = getPref("maimemoCategoryId") as string;
    const res = await client.addWord(word.toLowerCase(), categoryId);
    ok = res.success;
  } else if (platform === "local") {
    ok = await addWordToLocal({
      word: lemma,
      phon: phon || "",
      exp: translateResult || "",
    });
  } else if (platform === "shanbay") {
    const client = createShanbayClientFromPrefs();
    if (!client) return false;
    const res = await client.addWord(word.toLowerCase());
    ok = res.success;
  } else {
    // platform === "eudic" (explicit guard, not fallthrough)
    if (platform !== "eudic") {
      Zotero.debug(`[hover-translate-eudic/selection] unknown platform="${platform}", skipping`);
      return false;
    }
    const client = createEudicClientFromPrefs();
    if (!client) return false;
    const categoryId = getPref("eudicCategoryId");
    const res = await client.addWord(lemma, categoryId);
    ok = res.success;
  }

  // Sync annotation after successful wordbook add (best-effort, never throws).
  if (ok && annotationCtx) {
    try {
      try {
        (globalThis as any).Zotero?.debug?.(
          `[hte-ann] selectionButton: wordbook add ok, calling syncWordAnnotation, ` +
          `attachmentID=${annotationCtx.attachmentID}, ` +
          `pdfRectsLen=${annotationCtx.pdfRects?.length ?? 0}, ` +
          `pageIndex=${annotationCtx.pageIndex}, hasReader=${!!annotationCtx.reader}`,
        );
      } catch { /* ignore */ }
      const { syncWordAnnotation } = await import("./annotationSync");
      void syncWordAnnotation({
        attachmentID: annotationCtx.attachmentID,
        word,
        translation: translateResult || "",
        reader: annotationCtx.reader,
        pdfRects: annotationCtx.pdfRects,
        pageIndex: annotationCtx.pageIndex,
      });
    } catch { /* ignore annotation errors */ }
  } else {
    try {
      (globalThis as any).Zotero?.debug?.(
        `[hte-ann] selectionButton: skip sync (ok=${ok}, hasCtx=${!!annotationCtx})`,
      );
    } catch { /* ignore */ }
  }
  return ok;
}

/** Extract sentence from text around the word at the given offset. */
function extractSentenceFromText(text: string, wordStart: number, word: string): string {
  let start = 0;
  for (let i = wordStart - 1; i >= 0; i--) {
    if (".!?\n".includes(text[i])) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = wordStart + word.length; i < text.length; i++) {
    if (".!?\n".includes(text[i])) { end = i + 1; break; }
  }
  return text.slice(start, end).trim();
}

/**
 * Find the PDF text node at the position given by the annotation rects,
 * verify it matches the selected word, and extract the surrounding sentence.
 *
 * Uses the same caretPositionFromPoint mechanism as the hover path,
 * so precision matches the hover path exactly.
 *
 * @param word      The selected word
 * @param rects     Bounding rects of the selection (viewport coordinates)
 * @param pageIndex Optional 0-based page index (fallback if rects don't work)
 */
function findContextFromReaders(
  word: string,
  rects?: { top: number; left: number; width: number; height: number }[],
  pageIndex?: number,
): string {
  try {
    const readers = getAllReaders();
    const lowerWord = word.toLowerCase();

    for (const reader of readers) {
      const iw = getReaderInnerWindow(reader);
      if (!iw?.document?.body) continue;

      // --- Primary method: use selection rect with caretPositionFromPoint ---
      // This is the same mechanism as the hover path, giving exact text node.
      if (rects && rects.length > 0) {
        try {
          // 同上：取词期间临时禁用 annotation layer 的 pointer-events 以穿透
          // 覆盖层（Zotero 高亮/划线标注渲染其中），取词后立即恢复。
          // 不用 reading-caret-position：Zotero 7 中并不存在该 class。
          const layers = iw.document.querySelectorAll(
            ".annotationLayer",
          ) as NodeListOf<HTMLElement>;
          const prevPointerEvents: string[] = [];
          layers.forEach((el: HTMLElement) => {
            prevPointerEvents.push(el.style.pointerEvents);
            el.style.pointerEvents = "none";
          });
          let cp: any = null;
          try {
            cp = (iw.document as any).caretPositionFromPoint?.(
              rects[0].left,
              rects[0].top,
            );
          } finally {
            layers.forEach((el: HTMLElement, i: number) => {
              el.style.pointerEvents = prevPointerEvents[i];
            });
          }
          if (cp?.offsetNode?.nodeType === 3) {
            const text = cp.offsetNode.data || "";
            const wp = wordRangeAtOffset(text, cp.offset);
            if (wp && wp.word.toLowerCase() === lowerWord && wp.word.length === word.length) {
              return extractSentenceFromText(text, wp.start, word);
            }
          }
        } catch { /* fall through */ }
      }

      // --- Fallback: page-based text node scan ---
      let searchRoot: Node = iw.document.body;
      if (pageIndex != null) {
        const pageEl = iw.document.querySelector(
          `.page[data-page-number="${pageIndex + 1}"]`,
        );
        if (pageEl) searchRoot = pageEl;
      }
      const walker = iw.document.createTreeWalker(
        searchRoot,
        NodeFilter.SHOW_TEXT,
        null as any,
      );
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.data || "";
        const idx = text.toLowerCase().indexOf(lowerWord);
        if (idx >= 0) {
          return extractSentenceFromText(text, idx, word);
        }
      }
    }
  } catch { /* ignore */ }
  return "";
}
