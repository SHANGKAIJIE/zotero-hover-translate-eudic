/**
 * pdf-access.ts —— PDF 数据接入层（重构版）。
 *
 * 职责：
 *  - 递归搜索持有 PDFViewerApplication 的 iframe（Zotero 9 viewer.html 嵌套）；
 *  - XPC 安全桥接：注入 iframe 原生函数调用官方 getPageData，结果以 JSON
 *    字符串写回全局属性，chrome 侧轮询读取（字符串跨边界零克隆风险）；
 *  - 输出纯 JSON chars（含官方 wordBreakAfter / inlineRect），供 page-bundle
 *    构建单流数据模型。
 *
 * Zotero 7/8/9 多形态：chars 数据统一走 getPageData / getProcessedData 的
 * processed chars（两者结构一致）；textContent 路径见 page-bundle 的
 * fallback（仅当 processed API 完全不可用时的最后手段）。
 */

import type { WordChar } from "./types";

const INJECTED_FN = "__hteFetchPageData";
const RESULT_PROP = "__htePageDataResult";
const READY_PROP = "__htePageDataReady";

export interface RawPageData {
  chars: RawChar[];
  viewBox: number[] | null;
}

export interface RawChar {
  c: string;
  u?: string;
  offset: number;
  rect: number[];
  inlineRect?: number[];
  baseline: number;
  fontSize: number;
  rotation: number;
  spaceAfter: boolean;
  lineBreakAfter: boolean;
  wordBreakAfter: boolean;
  paragraphBreakAfter: boolean;
  ignorable: boolean;
}

/** 取 pdf.js 全局应用对象（递归 iframe）。 */
export function getPdfViewerApp(innerWin: Window): any | null {
  try {
    return searchIframesForApp(innerWin);
  } catch {
    return null;
  }
}

function hasPdfViewerApp(win: Window): boolean {
  try {
    return !!(
      (win as any).wrappedJSObject?.PDFViewerApplication ||
      (win as any).PDFViewerApplication
    );
  } catch {
    return false;
  }
}

function searchIframesForApp(rootWin: Window, depth = 0): any | null {
  try {
    if (hasPdfViewerApp(rootWin)) {
      return (
        (rootWin as any).wrappedJSObject?.PDFViewerApplication ??
        (rootWin as any).PDFViewerApplication ??
        null
      );
    }
    if (depth > 5) return null;
    const iframes = rootWin?.document?.querySelectorAll("iframe");
    if (!iframes) return null;
    for (const iframe of Array.from(iframes)) {
      try {
        const cw = (iframe as HTMLIFrameElement).contentWindow;
        if (cw) {
          const found = searchIframesForApp(cw, depth + 1);
          if (found) return found;
        }
      } catch {
        /* cross-origin */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 当前页索引（0-based）；取不到返回 -1。 */
export function currentPageIndexOf(innerWin: Window): number {
  try {
    const n = getPdfViewerApp(innerWin)?.pdfViewer?.currentPageNumber;
    return typeof n === "number" ? n - 1 : -1;
  } catch {
    return -1;
  }
}

/** 获取持有 PDFViewerApplication 的 iframe 原生 window（未 XPC 包装）。 */
function getNativeViewerWindow(innerWin: Window): Window | null {
  try {
    const walk = (win: Window, depth: number): Window | null => {
      if (depth > 5) return null;
      try {
        const native = (win as any).wrappedJSObject ?? win;
        if (native?.PDFViewerApplication) return native;
      } catch { /* ignore */ }
      try {
        const iframes = win.document?.querySelectorAll?.("iframe");
        if (iframes) {
          for (const f of Array.from(iframes)) {
            try {
              const cw = (f as HTMLIFrameElement).contentWindow;
              if (cw) {
                const found = walk(cw, depth + 1);
                if (found) return found;
              }
            } catch { /* cross-origin */ }
          }
        }
      } catch { /* ignore */ }
      return null;
    };
    return walk(innerWin, 0);
  } catch {
    return null;
  }
}

/**
 * 在 iframe 原生 window 上注入桥接函数（v0.4.0 扩展字段）：
 *  - 新增 wordBreakAfter（官方词边界，单词定位权威来源）
 *  - 新增 inlineRect（官方行对齐 box，渲染首选）
 *  - 保留 c/u/offset/rect/baseline/fontSize/rotation/spaceAfter/
 *    lineBreakAfter/paragraphBreakAfter/ignorable
 */
function ensureInjected(nativeWin: Window): boolean {
  try {
    if ((nativeWin as any)[INJECTED_FN]) return true;

    const FN = INJECTED_FN;
    const RPY = READY_PROP;
    const RSP = RESULT_PROP;
    // 字符字段提取函数：统一序列化所有官方字段。
    // 注意字符串用显式 concat 拼接变量名（esbuild 压缩破坏模板字符串占位符）。
    const PUSH_CHAR =
      "chars.push({ c: ch.c, u: (typeof ch.u === 'string' ? ch.u : ch.c), " +
      "offset: (typeof ch.offset === 'number' && ch.offset >= 0 ? ch.offset : i), " +
      "rect: [Number(ch.rect[0]), Number(ch.rect[1]), Number(ch.rect[2]), Number(ch.rect[3])], " +
      "inlineRect: (Array.isArray(ch.inlineRect) && ch.inlineRect.length >= 4) ? [Number(ch.inlineRect[0]), Number(ch.inlineRect[1]), Number(ch.inlineRect[2]), Number(ch.inlineRect[3])] : null, " +
      "baseline: (typeof ch.baseline === 'number' ? ch.baseline : 0), " +
      "fontSize: (typeof ch.fontSize === 'number' ? ch.fontSize : 0), " +
      "rotation: (typeof ch.rotation === 'number' ? ch.rotation : 0), " +
      "spaceAfter: !!(ch && ch.spaceAfter), " +
      "lineBreakAfter: !!(ch && ch.lineBreakAfter), " +
      "wordBreakAfter: !!(ch && ch.wordBreakAfter), " +
      "paragraphBreakAfter: !!(ch && ch.paragraphBreakAfter), " +
      "ignorable: !!(ch && ch.ignorable) });";

    const src = "(function(){" +
      "window." + FN + " = function(pageIndex, selfWin){" +
        "var w = selfWin || window;" +
        "var app = w.PDFViewerApplication;" +
        "var doc = app && app.pdfDocument;" +
        "w." + RPY + " = false;" +
        "w." + RSP + " = null;" +
        "if (!doc || typeof doc.getPageData !== 'function') { w." + RPY + " = true; return; }" +
        "try {" +
          "doc.getPageData({ pageIndex: pageIndex }).then(function(data){" +
            "var src = Array.isArray(data && data.chars) ? data.chars : [];" +
            "var chars = [];" +
            "for (var i = 0; i < src.length; i++) {" +
              "var ch = src[i];" +
              "if (!ch || typeof ch.c !== 'string' || ch.c === 'undefined' || ch.c === 'null') continue;" +
              "if (!Array.isArray(ch.rect) || ch.rect.length < 4) continue;" +
              PUSH_CHAR +
            "}" +
            "var viewBox = (Array.isArray(data && data.viewBox) && data.viewBox.length >= 4) ? [Number(data.viewBox[0]), Number(data.viewBox[1]), Number(data.viewBox[2]), Number(data.viewBox[3])] : null;" +
            "var sample = '';" +
            "for (var s = 0; s < Math.min(30, chars.length); s++) { sample += chars[s].c; }" +
            "w." + RSP + " = JSON.stringify({ chars: chars, viewBox: viewBox, sample: sample });" +
            "w." + RPY + " = true;" +
          "}).catch(function(){ w." + RPY + " = true; });" +
        "} catch (e) { w." + RPY + " = true; }" +
      "};" +
    "})();";

    let ok = false;
    try {
      const nw = nativeWin as any;
      if (typeof nw.eval === "function") {
        nw.eval(src);
        ok = !!nw[INJECTED_FN];
      }
    } catch { /* fall through */ }
    if (!ok) {
      // 兜底：exportFunction 注入（仅当 eval 不可用时）
      try {
        const Cu = (globalThis as any).Components?.utils ?? (globalThis as any).Cu;
        const fallbackFn = function (this: any, pageIndex: number, selfWin?: any): void {
          try {
            const w = selfWin || this;
            const app = w?.PDFViewerApplication;
            const doc = app?.pdfDocument ?? null;
            if (!doc || typeof doc.getPageData !== "function") {
              w[READY_PROP] = true;
              return;
            }
            w[READY_PROP] = false;
            doc.getPageData({ pageIndex }).then((data: any) => {
              try {
                const src = Array.isArray(data?.chars) ? data.chars : [];
                const chars = src
                  .map((ch: any) => {
                    if (typeof ch?.c !== "string" || !Array.isArray(ch?.rect) || ch.rect.length < 4) return null;
                    return {
                      c: ch.c,
                      u: typeof ch.u === "string" ? ch.u : ch.c,
                      offset: typeof ch.offset === "number" ? ch.offset : -1,
                      rect: [Number(ch.rect[0]), Number(ch.rect[1]), Number(ch.rect[2]), Number(ch.rect[3])],
                      inlineRect:
                        Array.isArray(ch?.inlineRect) && ch.inlineRect.length >= 4
                          ? [Number(ch.inlineRect[0]), Number(ch.inlineRect[1]), Number(ch.inlineRect[2]), Number(ch.inlineRect[3])]
                          : null,
                      baseline: typeof ch.baseline === "number" ? ch.baseline : 0,
                      fontSize: typeof ch.fontSize === "number" ? ch.fontSize : 0,
                      rotation: typeof ch.rotation === "number" ? ch.rotation : 0,
                      spaceAfter: !!(ch && ch.spaceAfter),
                      lineBreakAfter: !!(ch && ch.lineBreakAfter),
                      wordBreakAfter: !!(ch && ch.wordBreakAfter),
                      paragraphBreakAfter: !!(ch && ch.paragraphBreakAfter),
                      ignorable: !!(ch && ch.ignorable),
                    };
                  })
                  .filter((ch: any) => !!ch);
                const viewBox =
                  Array.isArray(data?.viewBox) && data.viewBox.length >= 4
                    ? [Number(data.viewBox[0]), Number(data.viewBox[1]), Number(data.viewBox[2]), Number(data.viewBox[3])]
                    : null;
                w[RESULT_PROP] = JSON.stringify({ chars, viewBox });
              } catch { /* ignore */ }
              w[READY_PROP] = true;
            }).catch(() => {
              w[READY_PROP] = true;
            });
          } catch {
            try { (selfWin || this)[READY_PROP] = true; } catch { /* ignore */ }
          }
        };
        if (Cu?.exportFunction) {
          Cu.exportFunction(fallbackFn, nativeWin, { defineAs: INJECTED_FN });
          ok = !!(nativeWin as any)[INJECTED_FN];
        }
      } catch { /* ignore */ }
    }
    return ok;
  } catch {
    return false;
  }
}

/** 等待 iframe 内处理完成（轮询 READY_PROP）。 */
async function waitForReady(nativeWin: Window, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((nativeWin as any)[READY_PROP]) return true;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** 通过注入桥接获取纯 JSON（字符串跨边界，零克隆风险）。 */
export async function fetchPageDataCompact(
  innerWin: Window,
  pageIndex: number,
): Promise<RawPageData | null> {
  const nativeWin = getNativeViewerWindow(innerWin);
  if (!nativeWin) {
    logPdfAccess("fetchPageDataCompact: no native viewer window");
    return null;
  }
  if (!ensureInjected(nativeWin)) {
    logPdfAccess("fetchPageDataCompact: inject failed");
    return null;
  }
  try {
    (nativeWin as any)[READY_PROP] = false;
    (nativeWin as any)[RESULT_PROP] = null;
    (nativeWin as any)[INJECTED_FN](pageIndex, nativeWin);
    const ready = await waitForReady(nativeWin);
    if (!ready) {
      logPdfAccess(`fetchPageDataCompact: timeout waiting page ${pageIndex}`);
      return null;
    }
    const json = (nativeWin as any)[RESULT_PROP];
    if (typeof json !== "string" || !json) {
      logPdfAccess(`fetchPageDataCompact: empty result page ${pageIndex}`);
      return null;
    }
    const parsed = JSON.parse(json);
    return {
      chars: Array.isArray(parsed?.chars) ? parsed.chars : [],
      viewBox: Array.isArray(parsed?.viewBox) ? parsed.viewBox : null,
    };
  } catch (e) {
    logPdfAccess(`fetchPageDataCompact error: ${String((e as any)?.message || e)}`);
    return null;
  }
}

/** 规范化 RawChar → WordChar（清除非有限数值，保证后续几何运算安全）。 */
export function rawCharToWordChar(raw: RawChar, fallbackIndex: number): WordChar | null {
  const rect = rectOf(raw.rect);
  if (!rect) return null;
  const inlineRect = raw.inlineRect && raw.inlineRect.length >= 4 ? rectOf(raw.inlineRect) : undefined;
  return {
    c: raw.c,
    u: raw.u && raw.u.length > 0 ? raw.u : raw.c,
    offset: raw.offset >= 0 ? raw.offset : fallbackIndex,
    rect,
    ...(inlineRect ? { inlineRect } : {}),
    baseline: finiteOr(raw.baseline, 0),
    fontSize: finiteOr(raw.fontSize, 0),
    rotation: finiteOr(raw.rotation, 0),
    spaceAfter: !!raw.spaceAfter,
    lineBreakAfter: !!raw.lineBreakAfter,
    wordBreakAfter: !!raw.wordBreakAfter,
    paragraphBreakAfter: !!raw.paragraphBreakAfter,
    ignorable: !!raw.ignorable,
  };
}

function rectOf(v: number[] | undefined): PdfRectLike | null {
  if (!v || v.length < 4) return null;
  const r = [v[0], v[1], v[2], v[3]];
  if (r.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  return r as PdfRectLike;
}

type PdfRectLike = [number, number, number, number];

function finiteOr(v: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function logPdfAccess(msg: string): void {
  try {
    (globalThis as any).Zotero?.debug?.(`[hte-loc] ${msg}`);
  } catch {
    /* ignore */
  }
}
