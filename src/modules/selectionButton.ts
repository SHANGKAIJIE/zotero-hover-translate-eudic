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
import { setActiveAddBtn } from "./addWordShortcut";
import { getAllReaders, getReaderInnerWindow } from "../utils/window";
import { fetchDictResult, extractPhonetic, stripAudioText } from "./hoverTranslate";
import { suggestAbbr, addTermToTerminology } from "./terminology";
import { syncTermAnnotation } from "./annotationSync";
import { buildSourceLink } from "./zoteroNote";
import { injectTermDialogStyle } from "./termDialogStyle";

let registered = false;
let listener: ((event: any) => void) | null = null;
let prefObserverSymbol: symbol | null = null;

export function registerSelectionButton() {
  // Watch the enableEudicSync / enableTerminology prefs and register/unregister accordingly.
  prefObserverSymbol = registerPrefObserver("enableEudicSync", () => {
    syncRegistration();
  });
  try {
    (Zotero as any).Prefs.registerObserver?.(addonID(), "enableTerminology", () => {
      syncRegistration();
    });
  } catch { /* ignore */ }
  syncRegistration();
}

function addonID(): string {
  return (config as any).addonID || "hover-translate-eudic@zotero-plugins.dev";
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
  // 生词本同步 或 术语库 任一开启即注册划词弹窗监听
  const shouldEnable =
    (getPref("enableEudicSync") && hasStorage) || !!getPref("enableTerminology");
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

  const termEnabled = !!getPref("enableTerminology");
  const isWord = isSingleEnglishWord(selectedText);

  // 生词本按钮条件：enableEudicSync + 场景 + 单词 + 平台有存储
  const scenePref = getPref("buttonShowScene");
  const sceneOk = scenePref === "both" || scenePref === "selection";
  const platform = getPref("wordbookPlatform") as string;
  const hasStorage = platform === "maimemo"
    ? !!getPref("maimemoToken")
    : platform === "shanbay"
      ? !!getPref("shanbayToken")
      : platform === "local"
      ? true
      : !!getPref("eudicToken");
  const showWordBtn = getPref("enableEudicSync") && sceneOk && isWord && hasStorage;
  // 术语库按钮条件：开启术语库 + 文本非空（单词与短语均可；1 字符忽略）
  const showTermBtn = termEnabled && selectedText.length >= 2;

  if (!showWordBtn && !showTermBtn) return;

  // 同一行容器：+生词本（左）+ +术语库（右）
  const row = doc.createElement("div");
  row.style.cssText = [
    "display:flex",
    "gap:6px",
    "margin:2px 0",
    "width:100%",
    "box-sizing:border-box",
  ].join(";");

  // 全宽按钮样式（flex:1 平分容器）
  const mkSelectionButton = (text: string): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.textContent = text;
    b.style.cssText = [
      "display:block",
      "flex:1",
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
      "white-space:nowrap",
    ].join(";");
    return b;
  };

  // ---- +生词本 按钮（原逻辑，仅作用于单个英文单词） ----
  let wordBtn: HTMLButtonElement | null = null;
  if (showWordBtn) {
    wordBtn = mkSelectionButton(getString("wordbtn-add"));
    wordBtn.addEventListener("click", async () => {
      wordBtn!.textContent = getString("wordbtn-adding");
      wordBtn!.setAttribute("disabled", "true");
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
      // When the wordbook platform is zotero/local (or annotation translate is
      // enabled, or 同步至本地=本地/Zotero 笔记), fetch the full dictionary
      // entry — it carries the phonetic (audio/text) that the short textarea
      // translation lacks, so the note/CSV gets a 音标 line just like the
      // hover path. (2026-08-24: 补 syncToLocal 场景，不再受注释开关限制)
      const platform = getPref("wordbookPlatform") as string;
      const syncToLocal = getPref("syncToLocal") as string;
      if (trResult && reader && (platform === "zotero" || platform === "local" ||
          syncToLocal === "local" || syncToLocal === "zotero" ||
          (getPref("enableAnnotationSync") && getPref("enableAnnotationTranslate")))) {
        try {
          (globalThis as any).Zotero?.debug?.(
            `[hte-ann] selectionButton: fetching dict result for wordbook/annotation, ` +
            `word="${selectedText}"`,
          );
          const dict = await fetchDictResult(selectedText, reader);
          if (dict?.result) {
            (globalThis as any).Zotero?.debug?.(
              `[hte-ann] selectionButton: dict result len=${dict.result.length}, ` +
              `using dict result as trResult for wordbook`,
            );
            trResult = dict.result;
          } else {
            (globalThis as any).Zotero?.debug?.(
              `[hte-ann] selectionButton: dict result empty, keeping textarea trResult`,
            );
          }
          // 音标：与悬停路径一致（audio → stripAudioText → extractPhonetic → /.../）
          if (dict) {
            if (!phon && dict.audio?.length > 0) {
              const raw = (dict.audio[0].text || "").trim();
              if (raw) phon = stripAudioText(raw);
            }
            if (!phon) phon = extractPhonetic(dict.result || "");
            if (phon) phon = "/" + phon + "/";
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
      const ok = await addWordToEudic(selectedText, trResult, phon, annotationCtx, contextLine);
      wordBtn!.textContent = ok
        ? getString("wordbtn-added")
        : getString("wordbtn-failed");
      setTimeout(() => {
        wordBtn!.textContent = getString("wordbtn-add");
        wordBtn!.removeAttribute("disabled");
      }, 1000);
    });
    row.append(wordBtn);
  }

  // ---- +术语库 按钮 ----
  let termBtn: HTMLButtonElement | null = null;
  if (showTermBtn) {
    termBtn = mkSelectionButton(getString("termbtn-add"));
    termBtn!.addEventListener("click", async () => {
      termBtn!.textContent = getString("termbtn-adding");
      termBtn!.setAttribute("disabled", "true");
      // 读取弹窗译文（术语库保存的是译文）。若用户点击时译文尚未加载出
      // （翻译还在进行中），轮询等待译文出现后再弹窗，避免把空/简译写入；
      // 最多等待 WAIT_TRANSLATION_MS 毫秒（参考 hover 生词本「+」按钮的
      // Promise.race 超时 + 200ms 轮询机制），超时后使用当前值（可能为空）。
      let trResult = "";
      try {
        const WAIT_TRANSLATION_MS = 12000;
        const deadline = Date.now() + WAIT_TRANSLATION_MS;
        while (!trResult && Date.now() < deadline) {
          const ta = doc.querySelector(
            ".zoteropdftranslate-popup-textarea, .selection-popup textarea",
          ) as HTMLTextAreaElement | null;
          if (ta && ta.value) {
            trResult = ta.value;
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch { /* ignore */ }
      // 构建原文跳转链接 src（复用 zoteroNote.buildSourceLink）
      let src = "";
      let annotationCtx: any = undefined;
      try {
        const attachmentID = reader?.itemID ?? reader?._item?.id;
        const item = attachmentID ? Zotero.Items.get(attachmentID) : null;
        const key = item?.key;
        const libraryID = item?.libraryID;
        if (key && libraryID != null && pageIndex != null && pdfRects && pdfRects.length > 0) {
          src = buildSourceLink({ attachmentKey: key, libraryID, pageIndex, rects: pdfRects });
          annotationCtx = { attachmentID, reader, pdfRects, pageIndex };
        }
      } catch { /* ignore */ }
      // 弹窗任何异常都必须让按钮恢复（绝不卡在「添加中…」）
      let saved = false;
      try {
        saved = await openAddTermDialog(doc, {
          term: selectedText,
          exp: trResult,
          src,
          annotationCtx,
        });
      } catch (e) {
        try {
          (globalThis as any).Zotero?.debug?.(
            `[hover-translate-eudic/term] openAddTermDialog error: ${String(e)}`,
          );
        } catch { /* ignore */ }
      }
      termBtn!.textContent = saved
        ? getString("termbtn-added")
        : getString("termbtn-failed");
      setTimeout(() => {
        termBtn!.textContent = getString("termbtn-add");
        termBtn!.removeAttribute("disabled");
      }, 1000);
    });
    row.append(termBtn);
  }

  append(row);
  // 加词快捷键：注册 +生词本 按钮为当前活跃按钮（快捷键仅作用于生词本）。
  if (wordBtn) setActiveAddBtn(wordBtn);

  // Place the button row right after Translate for Zotero's translation textarea
  // (class "zoteropdftranslate-popup-textarea"). The textarea may be created
  // by Translate's listener after ours runs, so retry on the next tick.
  const placeAfterTextarea = () => {
    try {
      const ta = doc.querySelector(
        ".zoteropdftranslate-popup-textarea, .selection-popup textarea",
      ) as HTMLElement | null;
      if (ta && ta.parentNode && ta.parentNode !== row.parentNode) {
        ta.parentNode.insertBefore(row, ta.nextSibling);
        return true;
      }
      if (ta && ta.parentNode) {
        ta.parentNode.insertBefore(row, ta.nextSibling);
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
        // When the wordbook platform is zotero/local (or annotation translate
        // is enabled, or 同步至本地=本地/Zotero 笔记), fetch the full
        // dictionary entry for the note/annotation content AND extract the
        // phonetic from it. (2026-08-24: 补 syncToLocal 场景)
        const platform = getPref("wordbookPlatform") as string;
        const syncToLocal = getPref("syncToLocal") as string;
        if (reader && (platform === "zotero" || platform === "local" ||
            syncToLocal === "local" || syncToLocal === "zotero" ||
            (getPref("enableAnnotationSync") && getPref("enableAnnotationTranslate")))) {
          (globalThis as any).Zotero?.debug?.(
            `[hte-ann] selectionButton(auto): fetching dict result for wordbook/annotation, ` +
            `word="${selectedText}"`,
          );
          fetchDictResult(selectedText, reader).then((dict) => {
            if (dict?.result) {
              (globalThis as any).Zotero?.debug?.(
                `[hte-ann] selectionButton(auto): dict result len=${dict.result.length}, ` +
                `using dict result as trResult for wordbook`,
              );
              trResult = dict.result;
            } else {
              (globalThis as any).Zotero?.debug?.(
                `[hte-ann] selectionButton(auto): dict result empty, keeping textarea trResult`,
              );
            }
            // 音标：与悬停路径一致（audio → stripAudioText → extractPhonetic → /.../）
            if (dict) {
              if (!phon && dict.audio?.length > 0) {
                const raw = (dict.audio[0].text || "").trim();
                if (raw) phon = stripAudioText(raw);
              }
              if (!phon) phon = extractPhonetic(dict.result || "");
              if (phon) phon = "/" + phon + "/";
            }
            void addWordToEudic(selectedText, trResult, phon, autoAnnotationCtx, contextLine);
          }).catch((e) => {
            (globalThis as any).Zotero?.debug?.(
              `[hte-ann] selectionButton(auto): fetchDictResult error: ${String(e)}`,
            );
            void addWordToEudic(selectedText, trResult, phon, autoAnnotationCtx, contextLine);
          });
        } else {
          void addWordToEudic(selectedText, trResult, phon, autoAnnotationCtx, contextLine);
        }
      } else if (attempt < 3) {
        // Retry with progressive delay: 150ms → 400ms
        const delay = attempt === 1 ? 150 : 400;
        setTimeout(() => tryAutoAdd(attempt + 1), delay);
      } else {
        // Fallback: add word without phon/exp
        void addWordToEudic(selectedText, "", "", autoAnnotationCtx, contextLine);
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
  /** 例句原文（PDF 上下文句子）；成功加词后写入记忆 JSON ctx（M2）。 */
  contextLine?: string,
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
    const item: any = annotationCtx?.reader?.item ?? annotationCtx?.reader?._item;
    if (item?.key) {
      const { buildSourceLink } = await import("./zoteroNote");
      src = buildSourceLink({
        attachmentKey: item.key,
        libraryID: item.libraryID,
        pageIndex: annotationCtx?.pageIndex,
        rects: annotationCtx?.pdfRects,
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
    // 划词场景：写入 Zotero 笔记（与悬停场景同一实现）
    const { addWordToNote, getNoteTitle } = await import("./zoteroNote");
    // 翻译成功（有释义）→ completed（不渲染图标）；失败 → failed（渲染 ❌）
    const hasResult = !!(translateResult && translateResult.trim());
    ok = await addWordToNote({
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
      Zotero.debug(`[hover-translate-eudic/selection] unknown platform="${platform}", skipping`);
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
          Zotero.debug(`[hover-translate-eudic/selection] syncToLocal local error: ${e?.message || e}`);
        } catch { /* ignore */ }
      }
    } else if (syncMode === "zotero") {
      try {
        const { addWordToNote, getNoteTitle } = await import("./zoteroNote");
        const hasResult = !!(translateResult && translateResult.trim());
        await addWordToNote({
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
          Zotero.debug(`[hover-translate-eudic/selection] syncToLocal zotero error: ${e?.message || e}`);
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
  // 例句原文写入记忆（M2）：词已成功加入词表时记录 ctx 供背诵弹窗背面
  // 展示「原文」例句。优先用 locate 子系统取完整句子；失败回退单节点逻辑。
  if (ok) {
    let finalCtx = contextLine || "";
    try {
      const rd = (annotationCtx as any)?.reader;
      const pg = (annotationCtx as any)?.pageIndex;
      const rects = (annotationCtx as any)?.pdfRects;
      if (rd && pg != null && rects?.length) {
        const { sentenceForWordRect } = await import("../locate/sentence-locator");
        const iw = getReaderInnerWindow(rd);
        if (iw) {
          const s = await sentenceForWordRect(rd as object, iw, pg, rects);
          if (s) finalCtx = s;
        }
      }
    } catch { /* keep fallback */ }
    if (finalCtx) {
      try {
        const { setWordCtx } = await import("./reciteMemory");
        // 划词选中的文本即命中词形（可能含变形），记录供精确高亮
        void setWordCtx(lemma, finalCtx, word);
      } catch { /* ignore */ }
    }
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

/* ------------------------------------------------------------------ */
/*  添加术语弹窗（方案 X：点击 +术语库 → 弹窗确认）                    */
/* ------------------------------------------------------------------ */

/**
 * 弹出「添加术语」对话框。
 * - 术语全称：预填划词文本
 * - 缩写：自动提取首字母建议并直接预填（用户可修改 / 清空，留空不影响提交）
 * - 释义：预填弹窗译文
 * - 术语全称修改时：输入暂停 400ms 后自动更新缩写建议并预填缩写框
 * 保存成功后写入术语库（按术语库平台分发），返回是否成功。
 */
async function openAddTermDialog(
  doc: Document,
  init: { term: string; exp: string; src: string; annotationCtx?: any },
): Promise<boolean> {
  // 弹窗必须挂在**用户当前操作窗口的最顶层 document**（全屏可见、可操作、不随
  // popup 销毁）：
  //  1. 聚焦窗口（focusedWindow）的 top —— 用户点击 +术语库 所在窗口的顶层
  //     （主窗口 / 独立 PDF 窗口），稳定不销毁；
  //  2. 回退：popup doc 的 defaultView.top；
  //  3. 回退：主窗口 document。
  // 若弹窗挂到 popup iframe 自身（点击后随 popup 销毁 → document 失效 →
  // createElementNS/append 抛异常）或另一不可见窗口 → Promise 永不 resolve →
  // 按钮卡在「添加中…」。
  let mdoc: Document = doc;
  try {
    const focused = (Services as any)?.focus?.focusedWindow;
    const topWin = focused?.top || (doc.defaultView as any)?.top;
    if (topWin?.document?.documentElement) mdoc = topWin.document;
  } catch { /* fall through */ }
  if (!mdoc.documentElement) {
    try {
      const mainDoc = (Zotero.getMainWindow() as any)?.document;
      if (mainDoc?.documentElement) mdoc = mainDoc;
    } catch { /* keep */ }
  }
  try {
    (globalThis as any).Zotero?.debug?.(
      `[hover-translate-eudic/term] dialog doc: ${mdoc.location?.href || mdoc.URL || "?"} (hasEl=${!!mdoc.documentElement})`,
    );
  } catch { /* ignore */ }
  // XHTML namespace 创建（主窗口 document 为 application/xhtml+xml，
  // createElement 会创建无命名空间元素，需用 createElementNS）
  const elx = (tag: string): HTMLElement =>
    (mdoc as any).createElementNS
      ? (mdoc as any).createElementNS("http://www.w3.org/1999/xhtml", tag)
      : mdoc.createElement(tag);

  // ── 样式注入(幂等,必须与挂载同一个 mdoc)+ DOM 构建 ──
  // 布局参考豆包风格设计稿(2026-08-24):620px 大圆角卡片、focus 蓝色
  // 光环、按钮 hover 态;背景走 --color-background(方案 A:亮色纯白),
  // 亮暗主题自适应。类名与 CSS 见 termDialogStyle.ts。
  try {
    injectTermDialogStyle(mdoc);
  } catch { /* ignore */ }

  const overlay = elx("div");
  overlay.className = "hte-term-mask";
  const dlg = elx("div");
  dlg.className = "hte-term-dlg";

  const title = elx("div");
  title.className = "hte-term-title";
  title.textContent = getString("term-add-title");
  dlg.append(title);

  const mkField = (
    label: string,
    value: string,
    isArea = false,
  ): HTMLInputElement | HTMLTextAreaElement => {
    const item = elx("div");
    item.className = "hte-term-item";
    const l = elx("label");
    l.className = "hte-term-label";
    l.textContent = label;
    item.append(l);
    const input = elx(isArea ? "textarea" : "input") as any;
    input.className = "hte-term-input";
    // 注意：textarea 的 type 属性为只读（getter-only），直接赋值会抛
    // "TypeError: setting getter-only property \"type\""（Zotero 9 已实测复现）。
    // 因此仅对 input 元素设置 type="text"，textarea 不触碰该属性。
    if (!isArea) input.type = "text";
    input.value = value;
    item.append(input);
    dlg.append(item);
    return input;
  };

  const termInput = mkField(getString("term-add-term"), init.term) as HTMLInputElement;
  const abbrInput = mkField(getString("term-add-abbr"), "") as HTMLInputElement;
  const expInput = mkField(getString("term-add-exp"), init.exp, true) as HTMLTextAreaElement;

  // 缩写建议：打开时基于预填术语直接生成并预填（同步，不依赖异步 import）。
  // 缩写已直接预填到缩写输入框（用户可修改/清空），不再渲染额外的「建议缩写：xxx」提示行。
  let lastSuggestion = "";
  const applySuggestion = (sugg: string) => {
    lastSuggestion = sugg;
    if (sugg) {
      abbrInput.value = sugg; // 直接预填，用户可修改 / 清空
    }
  };
  try {
    applySuggestion(suggestAbbr(termInput.value));
  } catch { /* ignore */ }

  // 术语全称修改 → 输入暂停 400ms → 重新生成缩写建议并预填
  let suggestTimer: any = null;
  termInput.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => {
      try {
        const sugg = suggestAbbr(termInput.value);
        if (sugg && sugg !== lastSuggestion) applySuggestion(sugg);
      } catch { /* ignore */ }
    }, 400);
  });

  const btnRow = elx("div");
  btnRow.className = "hte-term-btnrow";
  const saveBtn = elx("button");
  saveBtn.className = "hte-term-save hte-term-btn";
  saveBtn.textContent = getString("term-add-save");
  saveBtn.addEventListener("click", async () => {
    saveBtn.setAttribute("disabled", "true");
    const term = termInput.value.trim();
    if (!term) {
      saveBtn.removeAttribute("disabled");
      return;
    }
    let saved = false;
    try {
      saved = await addTermToTerminology({
        term,
        abbr: abbrInput.value.trim(),
        exp: expInput.value.trim(),
        src: init.src,
      });
    } catch { /* ignore */ }
    overlay.remove();
    // 术语注释同步：开启「加入术语库时同步添加到注释」且注释上下文可用时，
    // 为划词位置创建注释（+术语库 保存的是译文；标注方式/颜色/标签用术语专用设置）
    if (saved && init.annotationCtx) {
      try {
        if (getPref("enableTerminologyAnnotationSync")) {
          await syncTermAnnotation({
            ...init.annotationCtx,
            word: term,
            translation: expInput.value.trim(),
          });
        }
      } catch { /* ignore */ }
    }
    // 同步刷新侧边栏面板（若开启）
    try {
      const { refreshAllPanels } = await import("./wordbookPanel");
      refreshAllPanels();
    } catch { /* ignore */ }
    resolve(saved);
  });
  const cancelBtn = elx("button");
  cancelBtn.className = "hte-term-cancel hte-term-btn";
  cancelBtn.textContent = getString("term-add-cancel");
  cancelBtn.addEventListener("click", () => {
    overlay.remove();
    resolve(false);
  });
  btnRow.append(cancelBtn, saveBtn);
  dlg.append(btnRow);

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) {
      overlay.remove();
      resolve(false);
    }
  });
  overlay.append(dlg);
  // 挂到 mdoc 的 documentElement（全屏遮罩覆盖整个窗口）
  try {
    const root = (mdoc.documentElement || mdoc.body) as HTMLElement | null;
    root?.append(overlay);
    try {
      (globalThis as any).Zotero?.debug?.(
        `[hover-translate-eudic/term] dialog mounted: ${!!root?.contains(overlay)}`,
      );
    } catch { /* ignore */ }
  } catch (e) {
    try {
      (globalThis as any).Zotero?.debug?.(
        `[hover-translate-eudic/term] dialog mount error: ${String(e)}`,
      );
    } catch { /* ignore */ }
    try {
      mdoc.body?.append(overlay);
    } catch { /* ignore */ }
  }
  termInput.focus();
  // 注意：不要调用 termInput.select() —— 会让预填的术语内容自动全选，
  // 用户只需光标定位即可直接编辑（需求：不要自动选中）。

  // 等待保存/取消决定
  let resolveFn: (v: boolean) => void = () => {};
  const resolve = (v: boolean) => resolveFn(v);
  const promise = new Promise<boolean>((r) => { resolveFn = r; });
  return promise;
}
