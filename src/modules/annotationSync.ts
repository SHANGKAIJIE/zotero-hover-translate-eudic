/**
 * Annotation sync module.
 *
 * When `enableAnnotationSync` is enabled, creates a Zotero annotation
 * (highlight / underline) on the PDF when a word is added to the wordbook.
 *
 * Coordinate conversion:
 *   - hover scene: DOM Range → PDF user-space rects via PDF.js viewport
 *   - selection scene: viewport rects → PDF user-space rects via PDF.js viewport
 *
 * Reference: zotero-ai-sidebar's `translate/annotation.ts` + `overlay.ts`
 *
 * 调试：所有日志统一前缀 `[hte-ann]`，在 Zotero Debug Output 中可搜索该前缀
 *       快速定位注释同步流程的每一步。
 */
import { getPref } from "../utils/prefs";
import { recordAnnotationID } from "./hideNoteIcon";

/** PDF user-space rect: [x1, y1, x2, y2] (origin at bottom-left). */
type PdfRect = [number, number, number, number];

export interface AnnotationContext {
  /** Zotero attachment itemID (the PDF). */
  attachmentID: number;
  /** The source word being annotated. */
  word: string;
  /** Translation result text (may be empty). */
  translation: string;
  /** hover scene: DOM Range of the word. */
  range?: Range;
  /** hover scene: 鼠标坐标(视口系),供 C 通道(字符 rect)定位更准确。 */
  mouseX?: number;
  mouseY?: number;
  /** selection scene: viewport rects {top,left,width,height}. */
  viewportRects?: { top: number; left: number; width: number; height: number }[];
  /** selection scene: 0-based page index. */
  pageIndex?: number;
  /** The Zotero reader instance (for finding PDFViewerApplication). */
  reader?: any;
  /** Already-PDF-space rects [x1,y1,x2,y2] (e.g. from Zotero annotation.position.rects).
   *  When provided, no coordinate conversion is needed. */
  pdfRects?: PdfRect[];
}

/** 统一调试日志输出（前缀 [hte-ann]），便于在 Debug Output 中过滤。 */
function annLog(msg: string): void {
  try {
    const Zotero = (globalThis as any).Zotero;
    Zotero?.debug?.(`[hte-ann] ${msg}`);
    // 同时输出到 console，便于在 Browser Toolbox 中查看
    (globalThis as any).console?.log?.(`[hte-ann] ${msg}`);
  } catch { /* ignore */ }
}

/** 转储错误对象为字符串（优先用 stack），用于日志。 */
function dumpErr(e: unknown): string {
  try {
    if (e && typeof e === "object" && "stack" in e) {
      return String((e as { stack?: unknown }).stack || e);
    }
    return String(e);
  } catch {
    return "[unstringifiable error]";
  }
}

/** 转储对象为字符串（用于日志），失败时返回 [unstringifiable]。 */
function dump(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    try {
      return String(obj);
    } catch {
      return "[unstringifiable]";
    }
  }
}

/**
 * Create a Zotero annotation for the given word, honouring all annotation
 * preferences. Returns true on success, false on failure or when disabled.
 *
 * Never throws — errors are logged and swallowed so the caller (wordbook
 * add flow) is not affected.
 */
export async function syncWordAnnotation(
  ctx: AnnotationContext,
  kind: "word" | "term" = "word",
): Promise<boolean> {
  const Zotero = (globalThis as any).Zotero;
  const isTerm = kind === "term";
  annLog(`syncWordAnnotation(${kind}) START: ctx=${dump({
    attachmentID: ctx.attachmentID,
    word: ctx.word,
    translationLen: (ctx.translation || "").length,
    hasRange: !!ctx.range,
    viewportRectsLen: ctx.viewportRects?.length ?? 0,
    pdfRectsLen: ctx.pdfRects?.length ?? 0,
    pageIndex: ctx.pageIndex,
    hasReader: !!ctx.reader,
  })}`);

  try {
    // ---- 1. 总开关检查（术语注释用术语总开关） ----
    const enabled = isTerm
      ? getPref("enableTerminologyAnnotationSync")
      : getPref("enableAnnotationSync");
    annLog(`pref enable${isTerm ? "Terminology" : ""}AnnotationSync=${enabled} (type=${typeof enabled})`);
    if (!enabled) {
      annLog(`syncWordAnnotation(${kind}) SKIP: total switch is falsy`);
      return false;
    }

    // ---- 2. 检查 Zotero API 可用性 ----
    if (!Zotero?.Annotations?.saveFromJSON) {
      annLog(`syncWordAnnotation FAIL: Zotero.Annotations.saveFromJSON not available`);
      return false;
    }
    if (!Zotero?.DataObjectUtilities?.generateKey) {
      annLog(`syncWordAnnotation FAIL: Zotero.DataObjectUtilities.generateKey not available`);
      return false;
    }

    // ---- 3. 解析 PDF rects + pageIndex ----
    let rects: PdfRect[] | undefined;
    let pageIndex: number | undefined;

    if (ctx.pdfRects && ctx.pdfRects.length > 0) {
      // selection scene — rects are already in PDF user space, no conversion.
      rects = ctx.pdfRects;
      pageIndex = ctx.pageIndex != null ? ctx.pageIndex : 0;
      annLog(`selection scene: using pre-computed pdfRects, pageIndex=${pageIndex}, rects=${dump(rects)}`);
    } else {
      // hover scene (ctx.range) or legacy selection scene (ctx.viewportRects)
      // — both need the PDFViewerApplication window for coordinate conversion.
      const viewerWin = findPdfViewerWindow(ctx.reader, ctx.range);
      if (!viewerWin) {
        annLog(`syncWordAnnotation FAIL: PDFViewerApplication window not found. ` +
          `hasReader=${!!ctx.reader}, hasRange=${!!ctx.range}`);
        if (ctx.reader) {
          annLog(`reader keys: ${dump(Object.keys(ctx.reader))}`);
          annLog(`reader._internalReader keys: ${ctx.reader._internalReader ? dump(Object.keys(ctx.reader._internalReader)) : "none"}`);
        }
        return false;
      }
      annLog(`PDFViewerApplication window found successfully`);

      if (ctx.range) {
      // hover scene — C 通道优先：字符 rect（PDF 数据层）直接作为批注几何。
      // 修复:Zotero 9 批注渲染(getPageRects)与 A 通道同源,都基于 textLayer
      // range 的浏览器度量,textLayer span 错位时批注位置偏移。C 通道的
      // LocatedWord.rects 本身就是 PDF 用户坐标,无需再做 range→PDF 转换,
      // 且不受 textLayer 错位影响(与取词高亮 trust C 同一数据源)。
      try {
        const { locateWordHybrid } = await import("./wordLocator");
        const located = await locateWordHybrid(
          ctx.reader,
          viewerWin,
          { word: ctx.word, range: ctx.range },
          ctx.mouseX,
          ctx.mouseY,
        );
        if (located && !(located as { gap?: boolean }).gap) {
          const loc = located as { rects: PdfRect[]; locator: { pageIndex: number } };
          rects = loc.rects;
          pageIndex = loc.locator.pageIndex;
          annLog(`hover scene: C-channel char rects, pageIndex=${pageIndex}, rects=${dump(rects)}`);
        }
      } catch (e) {
        annLog(`hover scene: C-channel error (${dumpErr(e)}), fallback DOM range`);
      }
      if (!rects) {
        // C 通道不可用(API 缺失 / 页未构建 / 定位失败)→ 回退 DOM Range 转换
        annLog(`hover scene: converting DOM Range to PDF rects`);
        const conv = domRectsToPdfRects(ctx.range, viewerWin);
        if (!conv) {
          annLog(`syncWordAnnotation FAIL: failed to convert DOM Range to PDF rects`);
          return false;
        }
        rects = conv.rects;
        pageIndex = conv.pageIndex;
        annLog(`hover scene: pageIndex=${pageIndex}, rects=${dump(rects)}`);
      }
      } else if (
        ctx.viewportRects && ctx.viewportRects.length > 0 &&
        ctx.pageIndex != null
      ) {
        // legacy selection scene — convert viewport rects to PDF coords.
        annLog(`legacy selection scene: converting viewport rects to PDF rects, ` +
          `viewportRects=${dump(ctx.viewportRects)}, pageIndex=${ctx.pageIndex}`);
        const conv = viewportRectsToPdfRects(ctx.viewportRects, ctx.pageIndex, viewerWin);
        if (!conv) {
          annLog(`syncWordAnnotation FAIL: failed to convert viewport rects to PDF rects`);
          return false;
        }
        rects = conv;
        pageIndex = ctx.pageIndex;
        annLog(`legacy selection scene: rects=${dump(rects)}`);
      } else {
        annLog(`syncWordAnnotation FAIL: no range, no viewportRects, no pdfRects provided`);
        return false;
      }
    }

    if (!rects || rects.length === 0) {
      annLog(`syncWordAnnotation FAIL: rects is empty after conversion`);
      return false;
    }

    // ---- 5. 构建 sortIndex ----
    const top = Math.max(...rects.map((r) => r[3]));
    const sortIndex = [
      String(pageIndex ?? 0).padStart(5, "0"),
      "000000",
      String(Math.floor(Math.abs(top))).padStart(5, "0"),
    ].join("|");
    annLog(`sortIndex=${sortIndex} (top=${top})`);

    // ---- 6. 读取注释相关偏好（术语注释用术语专用标注方式/颜色） ----
    const markType = isTerm
      ? (getPref("terminologyMarkType") as string) || "highlight"
      : (getPref("annotationMarkType") as string) || "highlight";
    const color = isTerm
      ? (getPref("terminologyColor") as string) || "#ffd400"
      : (getPref("annotationColor") as string) || "#ffd400";
    const separator = (getPref("annotationSeparator") as string) ?? "\n\n";
    const position = (getPref("annotationTranslatePosition") as string) || "comment";
    const posInBody = (getPref("annotationTranslatePositionInBody") as string) || "before";
    const sepMode = (getPref("annotationSeparatorMode") as string) || "newline";
    const wordPosition = (getPref("annotationWordPosition") as string) || "none";
    const enableTranslate = getPref("enableAnnotationTranslate");
    annLog(`prefs(${kind}): markType=${markType}, color=${color}, separator=${dump(separator)}, ` +
      `position=${position}, posInBody=${posInBody}, sepMode=${sepMode}, ` +
      `wordPosition=${wordPosition}, enableTranslate=${enableTranslate}`);

    // ---- 7. 构建注释文本 + comment ----
    // 分隔方式：newline → 换行符 "\n"；separator → 用户自定义分隔符 pref。
    const joinSep = sepMode === "separator" ? separator : "\n";
    let annotationText = ctx.word;
    let comment = "";
    const tr = (ctx.translation || "").trim();
    annLog(`translation trimmed: len=${tr.length}, text=${dump(tr.slice(0, 60))}`);

    // 自动标签：读取设置（供 json.tags 使用，saveFromJSON 的 setTags 会覆盖式设置）
    const enableAutoTag = getPref("enableAnnotationAutoTag");
    const autoTagName = isTerm
      ? (getPref("terminologyTagName") as string) || "术语"
      : (getPref("annotationTagName") as string) || "单词";
    annLog(`pref enableAnnotationAutoTag=${enableAutoTag}, autoTagName=${autoTagName}(${kind})`);

    if (tr && enableTranslate) {
      if (position === "comment") {
        // 翻译 → 注释评论；单词 → 标注正文（始终保留，高亮需要原文）。
        annotationText = ctx.word;
        comment = tr;
        if (wordPosition === "comment") {
          // 单词也保存到评论：单词 + 分隔方式 + 翻译
          comment = `${ctx.word}${joinSep}${tr}`;
          annLog(`build: position=comment, wordPosition=comment, sepMode=${sepMode}, ` +
            `comment=${dump(comment.slice(0, 80))}`);
        } else {
          annLog(`build: position=comment, wordPosition=none, text=word, comment=translation`);
        }
      } else {
        // 翻译 → 正文；单词与翻译按 posInBody 决定顺序，用分隔方式连接。
        const body = posInBody === "before"
          ? `${tr}${joinSep}${ctx.word}`
          : `${ctx.word}${joinSep}${tr}`;
        annotationText = body;
        comment = "";
        annLog(`build: position=body, posInBody=${posInBody}, sepMode=${sepMode}, ` +
          `annotationText=${dump(body.slice(0, 80))}`);
      }
    } else {
      if (!tr && enableTranslate) {
        // 翻译失败（如离线）：注释中补充「联网重启后自动重试补全，也可手动更改」
        // 提示（联网后重启 Zotero 会自动补全释义）。前缀 ❌ 与笔记条目失败
        // 图标（STATUS_SYMBOLS.failed）保持一致，一眼可辨哪些注释尚未补全。
        const hint = "\u274c 联网重启后自动重试补全，也可手动更改";
        annLog(`build: translation failed (tr empty), adding offline retry hint "${hint}"`);
        if (position === "comment") {
          annotationText = ctx.word;
          comment = wordPosition === "comment"
            ? `${ctx.word}${joinSep}${hint}`
            : hint;
        } else {
          annotationText = posInBody === "before"
            ? `${hint}${joinSep}${ctx.word}`
            : `${ctx.word}${joinSep}${hint}`;
          comment = "";
        }
      } else {
        annLog(`build: no translation added (tr empty=${!tr}, enableTranslate=${enableTranslate})`);
      }
    }

    // ---- 8. 获取 attachment ----
    const attachment = await Zotero.Items.getAsync(ctx.attachmentID);
    if (!attachment) {
      annLog(`syncWordAnnotation FAIL: attachment ${ctx.attachmentID} not found`);
      return false;
    }
    annLog(`attachment found: id=${attachment.id}, libraryID=${attachment.libraryID}, ` +
      `isAttachment=${attachment.isAttachment?.()}, isPDFAttachment=${attachment.isPDFAttachment?.()}`);

    if (!attachment.libraryID) {
      annLog(`syncWordAnnotation FAIL: attachment.libraryID is falsy (attachment not saved)`);
      return false;
    }

    // ---- 9. 构建 JSON 并保存 ----
    const key = Zotero.DataObjectUtilities.generateKey();
    const json: Record<string, unknown> = {
      key,
      type: markType, // "highlight" | "underline"
      text: annotationText,
      comment,
      color,
      pageLabel: String((pageIndex ?? 0) + 1),
      sortIndex,
      position: {
        pageIndex: pageIndex ?? 0,
        rects,
      },
    };
    // 自动标签：直接随 JSON 传给 saveFromJSON（其内部 setTags 为覆盖式设置，
    // 注释创建时标签即仅为 autoTagName，避免追加/继承其他标签）
    if (enableAutoTag) {
      json.tags = [{ name: autoTagName }];
      annLog(`json.tags set to [{name:"${autoTagName}"}]`);
    }
    annLog(`saving annotation: key=${key}, type=${markType}, color=${color}, ` +
      `pageIndex=${pageIndex ?? 0}, pageLabel=${json.pageLabel}, rects=${dump(rects)}`);

    const safeJson = cloneIntoChrome(json);
    annLog(`cloneIntoChrome done, safeJson keys=${dump(Object.keys(safeJson))}`);

    let item: any;
    try {
      item = await Zotero.Annotations.saveFromJSON(attachment, safeJson);
      annLog(`saveFromJSON SUCCESS: annotation id=${item?.id}, key=${item?.key}`);
    } catch (saveErr) {
      annLog(`saveFromJSON THREW: ${dumpErr(saveErr)}`);
      return false;
    }

    if (!item || !item.id) {
      annLog(`syncWordAnnotation FAIL: saveFromJSON returned no item`);
      return false;
    }

    // 记录注释 ID 到隐藏便签跟踪列表（word 模式按 ID 精确识别本插件注释）
    try {
      const savedKey = String(item?.key || key || "");
      if (savedKey) {
        recordAnnotationID(attachment.id, savedKey);
        annLog(`tracked annotation key=${savedKey}`);
      }
    } catch (trackErr) {
      annLog(`recordAnnotationID THREW: ${dumpErr(trackErr)}`);
    }

    // ---- 10. 自动添加标签（覆盖式 + 延迟修正，防第三方自动标签附加）----
    // enableAutoTag / autoTagName 已在第 7 步读取（json.tags 已携带）
    if (enableAutoTag) {
      annLog(`adding tag "${autoTagName}" to annotation ${item.id}`);
      try {
        await addTagToAnnotation(item.id, autoTagName);
        annLog(`addTagToAnnotation done`);
      } catch (tagErr) {
        annLog(`addTagToAnnotation THREW: ${dumpErr(tagErr)}`);
      }
    }

    annLog(`syncWordAnnotation SUCCESS for word="${ctx.word}"`);
    return true;
  } catch (e) {
    annLog(`syncWordAnnotation ERROR: ${dumpErr(e)}`);
    return false;
  }
}

/**
 * 术语注释同步：与 syncWordAnnotation 共用同一套坐标/文本构建逻辑，
 * 仅标注方式/颜色/标签使用术语专用 pref（terminologyMarkType/Color/TagName），
 * 翻译保存位置/单词保存位置/分隔方式等复用生词注释设置。内容为译文。
 */
export async function syncTermAnnotation(
  ctx: AnnotationContext,
): Promise<boolean> {
  return syncWordAnnotation(ctx, "term");
}

/**
 * Find the window that contains `PDFViewerApplication`.
 *
 * In Zotero 7, the PDF.js viewer lives in a nested iframe accessible via:
 *   reader._internalReader._primaryView._iframeWindow
 *   reader._internalReader._iframeWindow
 *   reader._iframeWindow (fallback)
 *
 * If a DOM Range is provided, also search from the Range's ownerDocument's
 * defaultView upward through iframe hierarchy.
 */
function findPdfViewerWindow(reader?: any, range?: Range): Window | null {
  annLog(`findPdfViewerWindow: hasReader=${!!reader}, hasRange=${!!range}`);

  // Strategy 1: from reader's internal structure.
  if (reader) {
    const r = reader;
    const candidates: any[] = [
      r?._internalReader?._primaryView?._iframeWindow,
      r?._internalReader?._primaryView?.iframeWindow,
      r?._internalReader?._primaryView?._iframe?.contentWindow,
      r?._internalReader?._primaryView?.iframe?.contentWindow,
      r?._internalReader?._secondaryView?._iframeWindow,
      r?._internalReader?._secondaryView?.iframeWindow,
      r?._internalReader?._secondaryView?._iframe?.contentWindow,
      r?._internalReader?._secondaryView?.iframe?.contentWindow,
      r?._internalReader?._iframeWindow,
      r?._internalReader?.iframeWindow,
      r?._internalReader?._iframe?.contentWindow,
      r?._internalReader?.iframe?.contentWindow,
      r?._iframeWindow,
      r?._iframe?.contentWindow,
    ];
    let idx = 0;
    for (const w of candidates) {
      if (w && hasPdfViewer(w)) {
        annLog(`findPdfViewerWindow: found via reader candidate[${idx}]`);
        return w;
      }
      idx++;
    }
    annLog(`findPdfViewerWindow: no direct candidate matched, trying recursive search`);
    // Recursive search from reader's iframe window.
    for (const w of candidates) {
      if (w) {
        const found = searchIframesForPdfViewer(w);
        if (found) {
          annLog(`findPdfViewerWindow: found via recursive search from a candidate`);
          return found;
        }
      }
    }
  }

  // Strategy 2: from Range's ownerDocument.
  if (range) {
    annLog(`findPdfViewerWindow: trying strategy 2 from range's ownerDocument`);
    const doc = range.startContainer?.ownerDocument;
    const win = doc?.defaultView;
    if (win) {
      if (hasPdfViewer(win)) {
        annLog(`findPdfViewerWindow: found via range ownerDocument defaultView`);
        return win;
      }
      const found = searchIframesForPdfViewer(win);
      if (found) {
        annLog(`findPdfViewerWindow: found via recursive search from range's window`);
        return found;
      }
      // 尝试向上查找父窗口
      let parent: Window | null = win;
      let depth = 0;
      while (parent && depth < 6) {
        if (hasPdfViewer(parent)) {
          annLog(`findPdfViewerWindow: found via parent window at depth=${depth}`);
          return parent;
        }
        try {
          const next: Window | null = parent.parent;
          if (!next || next === parent) break;
          parent = next;
        } catch { break; }
        depth++;
      }
    }
  }

  // Strategy 3: 枚举所有 Zotero reader 窗口（最后兜底）
  try {
    const Zotero = (globalThis as any).Zotero;
    const readers = Zotero?.Reader?.getReaders?.() || Zotero?.Readers?.getReaders?.();
    if (Array.isArray(readers)) {
      annLog(`findPdfViewerWindow: strategy 3, found ${readers.length} readers`);
      for (const rd of readers) {
        const win = rd?._iframeWindow || rd?._iframe?.contentWindow ||
          rd?._internalReader?._iframeWindow;
        if (win && hasPdfViewer(win)) {
          annLog(`findPdfViewerWindow: found via strategy 3 (Reader.getReaders)`);
          return win;
        }
        if (win) {
          const found = searchIframesForPdfViewer(win);
          if (found) {
            annLog(`findPdfViewerWindow: found via strategy 3 recursive`);
            return found;
          }
        }
      }
    }
  } catch (e) {
    annLog(`findPdfViewerWindow: strategy 3 error: ${String(e)}`);
  }

  annLog(`findPdfViewerWindow: all strategies failed`);
  return null;
}

/** Check if a window has PDFViewerApplication.pdfViewer._pages. */
function hasPdfViewer(win: any): boolean {
  try {
    const app = win?.PDFViewerApplication ||
      win?.wrappedJSObject?.PDFViewerApplication;
    const ok = !!app?.pdfViewer?._pages;
    if (ok) {
      annLog(`hasPdfViewer: true, pages count=${app.pdfViewer._pages?.length}`);
    }
    return ok;
  } catch {
    return false;
  }
}

/** Recursively search nested iframes for a window with PDFViewerApplication. */
function searchIframesForPdfViewer(rootWin: any, depth = 0): Window | null {
  if (depth > 5) return null;
  try {
    if (hasPdfViewer(rootWin)) return rootWin;
    const iframes = rootWin?.document?.querySelectorAll("iframe");
    if (!iframes) return null;
    for (const iframe of Array.from(iframes)) {
      try {
        const cw = (iframe as HTMLIFrameElement).contentWindow;
        if (cw) {
          if (hasPdfViewer(cw)) return cw;
          const found = searchIframesForPdfViewer(cw, depth + 1);
          if (found) return found;
        }
      } catch { /* cross-origin */ }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Convert a DOM Range (browser viewport coords) to PDF user-space rects.
 *
 * Uses the viewBox + pageRect ratio method (same approach as zotero-ai-sidebar's
 * fallbackViewportRectForPdfRect, but in reverse: viewport→PDF). This avoids
 * calling viewport.convertToPdfPoint which can throw in some PDF.js versions
 * and doesn't account for CSS transforms on the .page element.
 */
function domRectsToPdfRects(
  range: Range,
  viewerWin: Window,
): { rects: PdfRect[]; pageIndex: number } | null {
  try {
    const pageEl = findPageElement(range.startContainer);
    if (!pageEl) {
      annLog(`domRectsToPdfRects: page element not found for range.startContainer`);
      return null;
    }
    annLog(`domRectsToPdfRects: pageEl found, data-page-number=${pageEl.getAttribute("data-page-number")}`);

    const pageNumber = parseInt(
      pageEl.getAttribute("data-page-number") || "1",
      10,
    );
    const pageIndex = pageNumber - 1;

    const pageRect = pageEl.getBoundingClientRect();
    const domRects = range.getClientRects();
    annLog(`domRectsToPdfRects: pageRect=${dump({l: pageRect.left, t: pageRect.top, w: pageRect.width, h: pageRect.height})}, ` +
      `domRects count=${domRects?.length || 0}`);
    if (!domRects || domRects.length === 0) {
      annLog(`domRectsToPdfRects: range.getClientRects() returned empty`);
      return null;
    }

    // Get viewBox (PDF user-space: [x0, y0, x1, y1], origin bottom-left).
    const viewBox = getViewBox(viewerWin, pageIndex);
    if (!viewBox) {
      annLog(`domRectsToPdfRects: viewBox not found for pageIndex=${pageIndex}`);
      return null;
    }
    const [vx0, vy0, vx1, vy1] = viewBox;
    const vbWidth = Math.max(1, vx1 - vx0);
    const vbHeight = Math.max(1, vy1 - vy0);
    annLog(`domRectsToPdfRects: viewBox=${dump(viewBox)}, vbWidth=${vbWidth}, vbHeight=${vbHeight}`);

    const pdfRects: PdfRect[] = [];
    for (const r of Array.from(domRects)) {
      if (r.width === 0 || r.height === 0) continue;
      // DOM rect relative to page element (post-CSS-transform viewport coords).
      const relX1 = r.left - pageRect.left;
      const relY1 = r.top - pageRect.top;
      const relX2 = relX1 + r.width;
      const relY2 = relY1 + r.height;
      // Convert to PDF user space via ratio (origin bottom-left, y up).
      // pdfX = vx0 + (relX / pageRect.width) * vbWidth
      // pdfY = vy1 - (relY / pageRect.height) * vbHeight   (y flipped)
      const px1 = vx0 + (relX1 / Math.max(1, pageRect.width)) * vbWidth;
      const px2 = vx0 + (relX2 / Math.max(1, pageRect.width)) * vbWidth;
      const py1 = vy1 - (relY1 / Math.max(1, pageRect.height)) * vbHeight;
      const py2 = vy1 - (relY2 / Math.max(1, pageRect.height)) * vbHeight;
      pdfRects.push([
        Math.min(px1, px2),
        Math.min(py1, py2),
        Math.max(px1, px2),
        Math.max(py1, py2),
      ]);
    }
    annLog(`domRectsToPdfRects: produced ${pdfRects.length} pdf rects, rects=${dump(pdfRects)}`);
    return pdfRects.length > 0
      ? { rects: pdfRects, pageIndex }
      : null;
  } catch (e) {
    annLog(`domRectsToPdfRects error: ${dumpErr(e)}`);
    return null;
  }
}

/**
 * Get the PDF page viewBox [x0, y0, x1, y1] (user-space, origin bottom-left).
 * Tries multiple property paths, mirroring zotero-ai-sidebar's pageViewBox().
 */
function getViewBox(viewerWin: Window, pageIndex: number): [number, number, number, number] | null {
  try {
    const app = (viewerWin as any).PDFViewerApplication ||
      (viewerWin as any).wrappedJSObject?.PDFViewerApplication;
    const pages = app?.pdfViewer?._pages;
    const pageView = pages?.[pageIndex];
    if (!pageView) {
      annLog(`getViewBox: pageView not found at pageIndex=${pageIndex}`);
      return null;
    }

    // Try multiple property paths (mirroring zotero-ai-sidebar's pageViewBox).
    const candidates: any[] = [
      pageView?.viewport?.viewBox,
      pageView?.originalPage?.viewport?.viewBox,
      pageView?.pdfPage?.view,
      pageView?.pdfPage?.viewBox,
      pageView?.pdfPage?._pageInfo?.view,
      pageView?.view,
      pageView?.viewBox,
      pageView?._pageInfo?.view,
    ];

    for (let i = 0; i < candidates.length; i++) {
      const v = candidates[i];
      const rect = rectValue(v);
      if (rect) {
        annLog(`getViewBox: found via candidate[${i}], rect=${dump(rect)}`);
        return rect;
      }
    }
    annLog(`getViewBox: no candidate yielded a valid rect`);
    return null;
  } catch (e) {
    annLog(`getViewBox error: ${dumpErr(e)}`);
    return null;
  }
}

/** Validate a raw value into a [x0,y0,x1,y1] tuple, or null. */
function rectValue(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const [a, b, c, d] = raw;
  if (typeof a !== "number" || typeof b !== "number" ||
      typeof c !== "number" || typeof d !== "number") return null;
  if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d)) return null;
  return [a, b, c, d];
}

/**
 * Convert viewport rects {top,left,width,height} to PDF user-space rects.
 * Used by selection scene.
 */
function viewportRectsToPdfRects(
  viewportRects: { top: number; left: number; width: number; height: number }[],
  pageIndex: number,
  viewerWin: Window,
): PdfRect[] | null {
  try {
    const viewport = getViewport(viewerWin, pageIndex);
    if (!viewport) {
      annLog(`viewportRectsToPdfRects: viewport not found for pageIndex=${pageIndex}`);
      return null;
    }
    annLog(`viewportRectsToPdfRects: viewport found, has convertToPdfPoint=${typeof viewport.convertToPdfPoint}, has convertToPDFPoint=${typeof viewport.convertToPDFPoint}`);

    // Find the page element for this pageIndex to get its offset.
    const pageEl = findPageByIndex(viewerWin, pageIndex);
    if (!pageEl) {
      annLog(`viewportRectsToPdfRects: page element not found for pageIndex=${pageIndex}`);
      return null;
    }
    const pageRect = pageEl.getBoundingClientRect();
    annLog(`viewportRectsToPdfRects: pageRect=${dump({l: pageRect.left, t: pageRect.top, w: pageRect.width, h: pageRect.height})}`);

    const pdfRects: PdfRect[] = [];
    for (const r of viewportRects) {
      if (r.width === 0 || r.height === 0) continue;
      // viewport rect relative to page element.
      const vx1 = r.left - pageRect.left;
      const vy1 = r.top - pageRect.top;
      const vx2 = vx1 + r.width;
      const vy2 = vy1 + r.height;
      const [px1, py1] = viewport.convertToPdfPoint(vx1, vy1);
      const [px2, py2] = viewport.convertToPdfPoint(vx2, vy2);
      pdfRects.push([
        Math.min(px1, px2),
        Math.min(py1, py2),
        Math.max(px1, px2),
        Math.max(py1, py2),
      ]);
    }
    annLog(`viewportRectsToPdfRects: produced ${pdfRects.length} pdf rects`);
    return pdfRects.length > 0 ? pdfRects : null;
  } catch (e) {
    annLog(`viewportRectsToPdfRects error: ${dumpErr(e)}`);
    return null;
  }
}

/** Get the PDF.js viewport for a given page index. */
function getViewport(viewerWin: Window, pageIndex: number): any {
  try {
    const app = (viewerWin as any).PDFViewerApplication ||
      (viewerWin as any).wrappedJSObject?.PDFViewerApplication;
    const pages = app?.pdfViewer?._pages;
    annLog(`getViewport: pages array length=${pages?.length}, pageIndex=${pageIndex}, ` +
      `page at index exists=${!!pages?.[pageIndex]}`);
    const viewport = pages?.[pageIndex]?.viewport;
    if (viewport && (typeof viewport.convertToPdfPoint === "function" || typeof viewport.convertToPDFPoint === "function")) {
      return viewport;
    }
    annLog(`getViewport: viewport invalid or missing convertToPdfPoint (has convertToPdfPoint=${typeof viewport?.convertToPdfPoint}, has convertToPDFPoint=${typeof viewport?.convertToPDFPoint})`);
    return null;
  } catch (e) {
    annLog(`getViewport error: ${String(e)}`);
    return null;
  }
}

/** Find the `.page[data-page-number]` element by page index (0-based). */
function findPageByIndex(viewerWin: Window, pageIndex: number): HTMLElement | null {
  try {
    const doc = (viewerWin as any).document || viewerWin.document;
    const pageNumber = pageIndex + 1;
    // PDF.js sets data-page-number (1-based).
    const el = doc.querySelector(
      `.page[data-page-number="${pageNumber}"]`,
    ) as HTMLElement | null;
    if (el) {
      annLog(`findPageByIndex: found directly, pageIndex=${pageIndex}`);
      return el;
    }
    annLog(`findPageByIndex: not found directly, searching iframes`);
    // Fallback: search all iframes.
    return searchIframesForPage(doc, pageNumber);
  } catch (e) {
    annLog(`findPageByIndex error: ${String(e)}`);
    return null;
  }
}

/** Recursively search iframes for a page element. */
function searchIframesForPage(doc: any, pageNumber: number, depth = 0): HTMLElement | null {
  if (depth > 5) return null;
  try {
    const el = doc?.querySelector?.(
      `.page[data-page-number="${pageNumber}"]`,
    ) as HTMLElement | null;
    if (el) return el;
    const iframes = doc?.querySelectorAll?.("iframe");
    if (!iframes) return null;
    for (const iframe of Array.from(iframes)) {
      try {
        const cw = (iframe as HTMLIFrameElement).contentWindow;
        if (cw?.document) {
          const found = searchIframesForPage(cw.document, pageNumber, depth + 1);
          if (found) return found;
        }
      } catch { /* cross-origin */ }
    }
  } catch { /* ignore */ }
  return null;
}

/** Walk up from a node to find the nearest `.page[data-page-number]` element. */
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

/** Clone a plain object into the chrome window (XPCOM security requirement). */
function cloneIntoChrome(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    const Zotero = (globalThis as any).Zotero;
    const chromeWin = Zotero?.getMainWindow?.();
    const cloneInto = (chromeWin as any)?.Components?.utils?.cloneInto;
    if (cloneInto && chromeWin) {
      annLog(`cloneIntoChrome: using Components.utils.cloneInto`);
      return cloneInto(obj, chromeWin);
    }
    annLog(`cloneIntoChrome: cloneInto not available, falling back to JSON`);
    if (chromeWin?.JSON?.parse) {
      return chromeWin.JSON.parse(JSON.stringify(obj));
    }
  } catch (e) {
    annLog(`cloneIntoChrome error: ${String(e)}, returning original object`);
  }
  return obj;
}

/**
 * 设置注释标签为「仅 tagName」（覆盖式，而不是追加）。
 *
 * 背景：Zotero 的 item.addTag 是追加语义，且第三方插件/自动标签机制可能在
 * 注释创建后异步附加其他标签（实测：注释 1018 被附加"方法"、1020 被附加"背景"，
 * 日志见 [Actions and Tags for Zotero] 介入）。用户期望插件创建的注释标签
 * 仅为注释设置里的标签名（如"单词"）。
 *
 * 策略：
 *  1. 立即 setTags([{tag: tagName}]) —— 覆盖已有标签（含创建时继承的）
 *  2. 延迟 1.5s 再检查一次，若有额外标签则再次覆盖 —— 抵御创建通知后
 *     异步附加的自动标签（第三方插件通常在通知队列里立即打标）
 */
async function addTagToAnnotation(
  annotationID: number,
  tagName: string,
): Promise<void> {
  const Zotero = (globalThis as any).Zotero;
  const apply = async () => {
    const item = await Zotero.Items.getAsync(annotationID);
    if (!item) {
      annLog(`addTagToAnnotation: item ${annotationID} not found`);
      return false;
    }
    const tags = (item.getTags() as Array<{ tag: string }>).map((t) => t.tag);
    // 已经是仅 tagName 且包含 tagName → 无需写库
    if (tags.length === 1 && tags[0] === tagName) {
      return false;
    }
    item.setTags([{ tag: tagName }]);
    await item.saveTx();
    annLog(`addTagToAnnotation: tags set to ["${tagName}"] (was ${tags.join(",") || "none"})`);
    return true;
  };
  try {
    await apply();
    // 延迟修正：第三方插件/自动标签可能在创建通知后异步附加标签
    try {
      await (Zotero.Promise?.delay ? Zotero.Promise.delay(1500) : new Promise((r) => setTimeout(r, 1500)));
      await apply();
    } catch (e) {
      annLog(`addTagToAnnotation refix error: ${dumpErr(e)}`);
    }
  } catch (e) {
    annLog(`addTagToAnnotation error: ${dumpErr(e)}`);
  }
}
