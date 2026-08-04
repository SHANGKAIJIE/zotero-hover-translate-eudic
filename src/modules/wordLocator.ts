/**
 * Word locator module — 字符级单词定位(C 通道)。
 *
 * 目标:把 eudic 的高亮/弹窗锚定从「textLayer 浏览器度量」(A 通道,
 * range.getClientRects())升级为「PDF 数据层字符 rect」(C 通道),
 * 根治字体 fallback / span 插值导致的左右偏差,并配合 scalechange
 * reflow 解决缩放漂移。
 *
 * 数据来源:Zotero 9 官方 API `PDFViewerApplication.pdfDocument.getPageData({pageIndex})`,
 * 返回 `{ chars, overlays, viewBox }`,其中 chars 是逐字符数组,每字符:
 *   { c, u, rect: [x1,y1,x2,y2](PDF用户坐标), fontSize, fontName,
 *     bold, italic, glyphWidth, baseline, rotation, diagonal, offset, pageIndex }
 * (已在 Zotero-9.0.6 app/omni.ja 源码中确认)。
 *
 * 与 A 通道的关系:渐进增强。A 负责零延迟取词;本模块负责精确定位。
 * 定位不可用(API 缺失 / 页未构建)时返回 null,调用方回退 A。
 */
import { getPref } from "../utils/prefs";

/** PDF user-space rect: [x1, y1, x2, y2] (origin at bottom-left). */
export type PdfRect = [number, number, number, number];

/** 单个字符的定位信息(从官方 getPageData chars 精简)。 */
export interface WordChar {
  c: string;
  offset: number;
  rect: PdfRect;
  baseline: number;
  fontSize: number;
  rotation: number;
  /** Zotero processed chars 自带:该字符后是否有空格(词边界权威信号)。 */
  spaceAfter: boolean;
  /** 该字符后是否有换行(行边界)。 */
  lineBreakAfter: boolean;
}

/** 单页定位器。 */
export interface PageLocator {
  pageIndex: number;
  chars: WordChar[];
  viewBox: PdfRect | null;
  /** 行分组(按 baseline 聚类,每行是 chars 索引数组)。构建时预计算,命中零开销。 */
  lines: number[][];
  /** 页面文本(按 offset 序拼接 chars,spaceAfter/lineBreakAfter 展开为空格)。 */
  pageText: string;
  /** 规范化文本(小写 + 空白合并 + 连字展开),用于文本匹配兜底。 */
  normalizedText: string;
  /** 规范化偏移 → 原始 pageText 偏移。 */
  normalizedToOriginal: number[];
  /** 第 i 个字符在 pageText 中的起始偏移(查找字符区间用)。 */
  charTextStart: number[];
}

/** C 通道命中结果。 */
export interface LocatedWord {
  word: string;
  rects: PdfRect[];
  chars: WordChar[];
  locator: PageLocator;
}

/** 每 reader 一页缓存:{ pageIndex → Promise<PageLocator | null> } */
const pageLocatorCache = new WeakMap<object, Map<number, Promise<PageLocator | null>>>();

/** 命中时的最近字符距离上限(PDF 单位,约为一个字高,防止跨段误命中)。 */
const MAX_CLOSEST_DISTANCE = 200;

/**
 * 取 pdf.js 全局应用对象。
 *
 * Zotero 9 的 PDFViewerApplication 不在 reader 外层 window(reader.html)上,
 * 而在其嵌套 iframe(viewer.html)里(日志证实:mousemove 事件源为
 * resource://zotero/reader/pdf/web/viewer.html,而 attached 的 innerWin
 * 是 reader.html)。因此必须递归搜索 iframe,参照
 * annotationSync.searchIframesForPdfViewer 的已验证实现。
 */
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
      // 优先 wrappedJSObject(iframe 原生对象,非 XPC 包装)
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

export function getPdfViewerApp(innerWin: Window): any | null {
  try {
    return searchIframesForApp(innerWin);
  } catch {
    return null;
  }
}

/**
 * 获取持有 PDFViewerApplication 的 iframe 原生 window(未 XPC 包装)。
 */
function getNativeViewerWindow(innerWin: Window): Window | null {
  try {
    // 递归找原生 window:contentWindow.wrappedJSObject 才是原生对象
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
 * 在 iframe 原生 window 上注入桥接函数。
 *
 * ⚠️ XPC 规则:chrome 上下文若 `await` iframe 函数返回的 Promise,其
 * resolve 值(data 含 overlays 的 DOM/函数引用)跨 XPC 边界深克隆必炸
 * ("The object could not be cloned")。已试过 wrappedJSObject / JSON
 * 序列化 / exportFunction 直接返回——全部无效。
 *
 * 终极方案:注入的函数【不返回 Promise】,而是把结果 JSON 字符串写入
 * iframe 全局属性;chrome 侧调用后【不 await 返回值】(void 调用),
 * 轮询读取字符串属性。跨边界只传字符串,物理上不可能克隆失败。
 */
const INJECTED_FN = "__hteFetchPageData";
const RESULT_PROP = "__htePageDataResult";
const READY_PROP = "__htePageDataReady";

function ensureInjected(nativeWin: Window): boolean {
  try {
    if ((nativeWin as any)[INJECTED_FN]) return true;

    // 用 iframe 原生 eval 定义函数——函数体、Promise 回调全部在 iframe
    // 上下文原生执行,不受 XPC 跨上下文回调限制。
    // 之前用 exportFunction 注入 chrome 函数,其 .then 回调是 chrome 代码,
    // iframe Promise resolve 时无法调度回 chrome 执行 → 永远不置 READY。
    // 注意:字符串用显式 concat 拼接变量名(esbuild 压缩会破坏模板字符串
    // 里的 ${...} 占位符,导致注入函数名变成字面 "${INJECTED_FN}")。
    const FN = INJECTED_FN;
    const RPY = READY_PROP;
    const RSP = RESULT_PROP;
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
              "chars.push({ c: ch.c, offset: (typeof ch.offset === 'number' && ch.offset >= 0 ? ch.offset : i), rect: [Number(ch.rect[0]), Number(ch.rect[1]), Number(ch.rect[2]), Number(ch.rect[3])], baseline: (typeof ch.baseline === 'number' ? ch.baseline : 0), fontSize: (typeof ch.fontSize === 'number' ? ch.fontSize : 0), rotation: (typeof ch.rotation === 'number' ? ch.rotation : 0), spaceAfter: !!(ch && ch.spaceAfter), lineBreakAfter: !!(ch && ch.lineBreakAfter) });" +
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
      // 优先 iframe 原生 eval(同步执行注入)
      if (typeof nw.eval === "function") {
        nw.eval(src);
        ok = !!nw[INJECTED_FN];
      }
    } catch { /* fall through */ }
    if (!ok) {
      // 兜底:exportFunction 注入(仅当 eval 不可用时)
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
                      offset: typeof ch.offset === "number" ? ch.offset : -1,
                      rect: [Number(ch.rect[0]), Number(ch.rect[1]), Number(ch.rect[2]), Number(ch.rect[3])],
                      baseline: typeof ch.baseline === "number" ? ch.baseline : 0,
                      fontSize: typeof ch.fontSize === "number" ? ch.fontSize : 0,
                      rotation: typeof ch.rotation === "number" ? ch.rotation : 0,
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

/** 等待 iframe 内处理完成(轮询 READY_PROP,超时 5s)。 */
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

/** 通过注入桥接获取纯 JSON(字符串跨边界,零克隆风险)。 */
async function fetchPageDataCompact(
  innerWin: Window,
  pageIndex: number,
): Promise<{ chars: any[]; viewBox: number[] | null; sample?: string } | null> {
  const nativeWin = getNativeViewerWindow(innerWin);
  if (!nativeWin) {
    logLocate(`fetchPageDataCompact: no native viewer window`);
    return null;
  }
  if (!ensureInjected(nativeWin)) {
    logLocate(`fetchPageDataCompact: inject failed`);
    return null;
  }
  try {
    // 重置 ready,void 调用(不 await 返回值);传入 nativeWin 供注入函数使用
    (nativeWin as any)[READY_PROP] = false;
    (nativeWin as any)[RESULT_PROP] = null;
    (nativeWin as any)[INJECTED_FN](pageIndex, nativeWin);
    const ready = await waitForReady(nativeWin);
    if (!ready) {
      logLocate(`fetchPageDataCompact: timeout waiting page ${pageIndex}`);
      return null;
    }
    const json = (nativeWin as any)[RESULT_PROP];
    if (typeof json !== "string" || !json) {
      logLocate(`fetchPageDataCompact: empty result page ${pageIndex}`);
      return null;
    }
    const parsed = JSON.parse(json);
    return {
      chars: Array.isArray(parsed?.chars) ? parsed.chars : [],
      viewBox: Array.isArray(parsed?.viewBox) ? parsed.viewBox : null,
      sample: typeof parsed?.sample === "string" ? parsed.sample : undefined,
    };
  } catch (e) {
    logLocate(`fetchPageDataCompact error: ${String((e as any)?.message || e)}`);
    return null;
  }
}

/**
 * 获取 iframe 原生 pdfDocument(未包装),使 getPageData 返回原生对象。
 * 在 chrome 特权上下文(chrome 全局 + wrappedJSObject)下,
 * 直接 await XPC 包装的 getPageData 会在返回时尝试深克隆整个 data
 * (含 overlays 的 DOM 引用),抛 "The object could not be cloned"。
 * 用 wrappedJSObject 拿到原生对象后调用,返回原生数据,可正常遍历。
 */
export function getPdfDocumentRaw(innerWin: Window): any | null {
  try {
    const app = getPdfViewerApp(innerWin);
    const doc = app?.pdfDocument ?? null;
    if (doc) return doc;
    // 兜底:从 wrapped window 直接取原生 document
    const w = (innerWin as any).wrappedJSObject ?? innerWin;
    return w?.PDFViewerApplication?.pdfDocument ?? null;
  } catch {
    return null;
  }
}

/** 取 pdfDocument(官方 API 入口)。 */
export function getPdfDocument(innerWin: Window): any | null {
  try {
    return getPdfViewerApp(innerWin)?.pdfDocument ?? null;
  } catch {
    return null;
  }
}

/** 当前页索引(0-based);取不到返回 -1。 */
export function currentPageIndexOf(innerWin: Window): number {
  try {
    const n = getPdfViewerApp(innerWin)?.pdfViewer?.currentPageNumber;
    return typeof n === "number" ? n - 1 : -1;
  } catch {
    return -1;
  }
}

/**
 * 从 A 的取词 Range 推导鼠标实际所在页(0-based)。
 *
 * ⚠️ 关键修正:Zotero reader 连续滚动下 `currentPageNumber` 是「焦点页」,
 * 鼠标可能悬停在相邻页(视口上/下方)。若按焦点页取 pageEl 做坐标转换,
 * 转换结果整体偏移(水平超出字符容差 → gap / 文本匹配锚点偏 → 同词选错)。
 * range 的 startContainer 位于鼠标实际命中的 textLayer 节点,向上找到
 * .page[data-page-number] 即为真实页。
 */
function findPageIndexFromRange(range: Range): number {
  try {
    let el: HTMLElement | null =
      (range.startContainer?.parentElement as HTMLElement | null) ?? null;
    while (el) {
      if (typeof el.matches === "function" && el.matches(".page[data-page-number]")) {
        const n = parseInt(el.getAttribute("data-page-number") || "", 10);
        return isNaN(n) ? -1 : n - 1;
      }
      el = el.parentElement as HTMLElement | null;
    }
  } catch {
    /* ignore */
  }
  return -1;
}

/**
 * 拉取一页字符定位数据(官方 getPageData,惰性 + 每 reader 每页缓存)。
 * 失败(API 缺失 / 无 chars / 异常)返回 null,调用方回退 A 通道。
 */
export async function getPageLocator(
  reader: object,
  innerWin: Window,
  pageIndex: number,
): Promise<PageLocator | null> {
  let pageMap = pageLocatorCache.get(reader);
  if (!pageMap) {
    pageMap = new Map();
    pageLocatorCache.set(reader, pageMap);
  }
  if (pageMap.has(pageIndex)) return pageMap.get(pageIndex)!;

  const promise = (async (): Promise<PageLocator | null> => {
    try {
      const compact = await fetchPageDataCompact(innerWin, pageIndex);
      const rawChars: any[] = compact?.chars ?? [];
      if (!rawChars.length) {
        logLocate(`getPageLocator: no chars for page ${pageIndex}`);
        return null;
      }

      const chars: WordChar[] = [];
      rawChars.forEach((ch: any, i: number) => {
        if (typeof ch?.c !== "string" || !Array.isArray(ch?.rect) || ch.rect.length < 4) {
          return;
        }
        chars.push({
          c: ch.c,
          offset: typeof ch.offset === "number" && ch.offset >= 0 ? ch.offset : i,
          rect: [ch.rect[0], ch.rect[1], ch.rect[2], ch.rect[3]],
          baseline: ch.baseline ?? 0,
          fontSize: ch.fontSize ?? 0,
          rotation: ch.rotation ?? 0,
          spaceAfter: !!ch.spaceAfter,
          lineBreakAfter: !!ch.lineBreakAfter,
        });
      });
      if (!chars.length) {
        logLocate(`getPageLocator: 0 valid chars from ${rawChars.length}`);
        return null;
      }
      chars.sort((a, b) => a.offset - b.offset);

      const viewBox: PdfRect | null =
        Array.isArray(compact?.viewBox) && compact.viewBox.length >= 4
          ? [compact.viewBox[0], compact.viewBox[1], compact.viewBox[2], compact.viewBox[3]]
          : null;

      logLocate(`getPageLocator: OK page ${pageIndex}, ${chars.length} chars, sample="${compact?.sample ?? ""}"`);
      // 页面文本:按 offset 序拼接 chars,spaceAfter/lineBreakAfter 展开为空格
      let pageText = "";
      const charTextStart: number[] = [];
      for (let i = 0; i < chars.length; i++) {
        charTextStart[i] = pageText.length;
        pageText += chars[i].c;
        if (chars[i].spaceAfter || chars[i].lineBreakAfter) pageText += " ";
      }
      const norm = normalizeTextWithMap(pageText);
      return {
        pageIndex,
        chars,
        viewBox,
        lines: groupLines(chars),
        pageText,
        normalizedText: norm.text,
        normalizedToOriginal: norm.map,
        charTextStart,
      };
    } catch (e) {
      logLocate(`getPageLocator error: ${String((e as any)?.message || e)}`);
      return null;
    }
  })();

  pageMap.set(pageIndex, promise);
  return promise;
}

/**
 * 命中点的 PDF 坐标 → 最近字符索引。
 *
 * 行级锁定优先(只在垂直最近的行内找,消除「词顶上方切上行词」的旧误判);
 * 本行无命中时(鼠标在行间隙 / 行首尾 / 该行该列无字符 / 小字号块边缘)
 * 回退全局欧氏最近字符——避免返回 -1 触发 gap 导致「高亮区域内移动但高亮
 * 消失」,由调用方的词一致性 / trust C 逻辑裁决结果。
 */
function closestCharIndex(locator: PageLocator, px: number, py: number): number {
  const chars = locator.chars;
  // 阶段 1:行级锁定,只在本行内找
  const line = locator.lines[nearestLineIndex(locator, py)];
  let best = -1;
  let bestDist = Infinity;
  for (const i of line) {
    const r = chars[i].rect;
    const cx = (r[0] + r[2]) / 2;
    const cy = (r[1] + r[3]) / 2;
    const dx = cx - px;
    const dy = cy - py;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best >= 0 && bestDist <= MAX_CLOSEST_DISTANCE * MAX_CLOSEST_DISTANCE) {
    return best;
  }
  // 阶段 2:本行无命中 → 全局欧氏兜底
  for (let i = 0; i < chars.length; i++) {
    const r = chars[i].rect;
    const cx = (r[0] + r[2]) / 2;
    const cy = (r[1] + r[3]) / 2;
    const dx = cx - px;
    const dy = cy - py;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return bestDist <= MAX_CLOSEST_DISTANCE * MAX_CLOSEST_DISTANCE ? best : -1;
}

/**
 * 按 baseline 把字符聚成行(行内字符 offset 连续)。
 * 行距通常 >= 1.2×字号,同行 baseline 浮动一般 < 0.5 PDF 单位,
 * 容差取 1.0 可稳定区分相邻行、同时容忍同行内字体大小混排。
 */
function groupLines(chars: WordChar[]): number[][] {
  const lines: number[][] = [];
  let cur: number[] = [];
  let curBaseline = NaN;
  for (let i = 0; i < chars.length; i++) {
    const b = chars[i].baseline;
    if (cur.length && Math.abs(b - curBaseline) > 1.0) {
      lines.push(cur);
      cur = [];
    }
    cur.push(i);
    curBaseline = b;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/** 行的垂直中心 y(行内字符 rect 中心的均值)。 */
function lineCenterY(chars: WordChar[], line: number[]): number {
  let sum = 0;
  for (const i of line) {
    const r = chars[i].rect;
    sum += (r[1] + r[3]) / 2;
  }
  return sum / line.length;
}

/**
 * 与 py 垂直距离最近的行索引。
 *
 * ⚠️ 行级锁定(修复「词顶上方回退 A」):旧实现用全局欧氏距离找最近字符,
 * 鼠标越过两行垂直中线后最近字符切到上一行的词 → located.word !==
 * hit.word(A 仍命中本行词)→ 回退 A。现在先锁定「垂直距离最近的行」,
 * 再在该行内定位——词顶上方/行间空白仍归属本行,词边界稳定,
 * 只有鼠标真正悬在上一行文字上才锁定上一行(此时 A 也命中上行词,一致)。
 */
function nearestLineIndex(locator: PageLocator, py: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let li = 0; li < locator.lines.length; li++) {
    const d = Math.abs(lineCenterY(locator.chars, locator.lines[li]) - py);
    if (d < bestDist) {
      bestDist = d;
      best = li;
    }
  }
  return best;
}

/** 常见拉丁连字(单码位 → 多字符),匹配前展开。 */
const TEXT_LIGATURES: Record<string, string> = {
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
};

/**
 * 文本规范化(小写 + 连字展开 + 零宽剔除 + 空白合并),带原始偏移映射。
 * 移植自 zotero-sentence-translator pdf-locator.normalizeWithMap(精简版)。
 * map[i] = 规范化文本第 i 个字符在原始 input 中的偏移。
 */
function normalizeTextWithMap(input: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpace: number | null = null;
  const pushSpace = () => {
    if (pendingSpace == null) return;
    if (chars.length > 0 && chars[chars.length - 1] !== " ") {
      chars.push(" ");
      map.push(pendingSpace);
    }
    pendingSpace = null;
  };
  let i = 0;
  while (i < input.length) {
    const cp = input.codePointAt(i);
    if (cp == null) break;
    const raw = String.fromCodePoint(cp);
    const len = raw.length;
    if (raw === "\u200b" || raw === "\u200c" || raw === "\u200d" || raw === "\ufeff") {
      i += len;
      continue;
    }
    if (/\s/u.test(raw)) {
      if (pendingSpace == null) pendingSpace = i;
      i += len;
      continue;
    }
    pushSpace();
    const expanded = TEXT_LIGATURES[raw] ?? raw.normalize("NFKC");
    for (const ch of expanded.toLowerCase()) {
      if (/\s/u.test(ch)) {
        if (pendingSpace == null) pendingSpace = i;
      } else {
        chars.push(ch);
        map.push(i);
      }
    }
    i += len;
  }
  if (chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }
  return { text: chars.join(""), map };
}

/** 取 pageText 偏移区间 [os, oe) 覆盖的字符索引(按 charTextStart 线性扫描)。 */
function charIndexRangeForTextRange(locator: PageLocator, os: number, oe: number): number[] {
  const sel: number[] = [];
  for (let i = 0; i < locator.chars.length; i++) {
    if (locator.charTextStart[i] >= oe) break;
    if (locator.charTextStart[i] >= os) sel.push(i);
  }
  return sel;
}

/**
 * A 的 range 在 textLayer 文本流中的「非空白字符」偏移。
 *
 * 方案 A 核心:textLayer 的文本流顺序与 chars 数据流一致(同一文本提取),
 * 用「去空白字符计数」对齐两条流。A 的 range 由 caretPositionFromPoint
 * 命中鼠标所指的词,其流内偏移能无歧义定位「哪个同词」——不受 textLayer
 * 几何错位 / 坐标转换偏差影响(悬停第 N 个同词 → 第 N 个)。
 * 返回非空白计数;失败返回 -1。
 */
function textLayerNonSpaceOffset(innerWin: Window, range: Range): number {
  try {
    const startNode = range.startContainer;
    if (!startNode || startNode.nodeType !== 3) return -1;
    let layer: Element | null = startNode.parentElement;
    while (layer && !layer.classList?.contains("textLayer")) {
      layer = layer.parentElement;
    }
    if (!layer) return -1;
    const doc = layer.ownerDocument;
    const win = (doc?.defaultView ?? innerWin) as any;
    if (!doc || !win?.NodeFilter) return -1;
    const walker = doc.createTreeWalker(layer, win.NodeFilter.SHOW_TEXT);
    const offset = range.startOffset;
    let count = 0;
    let node: Node | null = walker.nextNode();
    while (node) {
      const text = (node as Text).data || "";
      if (node === startNode) {
        for (let i = 0; i < offset && i < text.length; i++) {
          if (!/\s/.test(text[i])) count++;
        }
        return count;
      }
      for (let i = 0; i < text.length; i++) {
        if (!/\s/.test(text[i])) count++;
      }
      node = walker.nextNode();
    }
    return -1;
  } catch {
    return -1;
  }
}

/** pageText 中第 n 个非空白字符的偏移(0-based);不足返回 -1。 */
function nonSpaceToPageOffset(locator: PageLocator, n: number): number {
  if (n < 0) return -1;
  let count = 0;
  for (let i = 0; i < locator.pageText.length; i++) {
    if (/\s/.test(locator.pageText[i])) continue;
    if (count === n) return i;
    count++;
  }
  return -1;
}

/**
 * 文本匹配兜底:用取词文本在字符流中定位,不依赖鼠标坐标。
 * 移植自 sentence-translator 的 locate 精确匹配阶段——
 * 坐标转换失败(textLayer 错位 / 页偏移 / 数据偏差)时,只要 A 取到的词
 * 在 chars 里存在,就能拿回字符 rect,仍用 C 几何渲染(而非 A 的 range)。
 *
 * ⚠️ 同词多现:枚举全部出现位置,选离锚点最近的一个。锚点优先级:
 *   1. anchorPageOffset —— A 的 range 在 textLayer 文本流中的偏移
 *      (方案 A:不受几何错位/坐标偏差影响,悬停第 N 个同词 → 第 N 个);
 *   2. 鼠标 pdf 坐标最近字符(px,py) —— 回退;
 *   3. 均不可用 → 取第一个出现(数据缺失区)。
 */
function locateWordByText(
  locator: PageLocator,
  word: string,
  anchorPageOffset?: number,
  px?: number,
  py?: number,
): LocatedWord | null {
  const needle = normalizeTextWithMap(word).text;
  if (!needle) return null;
  // 参考锚点:优先文本流偏移;回退鼠标最近字符的页文本起始偏移
  let refOffset = -1;
  if (typeof anchorPageOffset === "number" && anchorPageOffset >= 0) {
    refOffset = anchorPageOffset;
  } else if (typeof px === "number" && typeof py === "number") {
    const refIdx = closestCharIndex(locator, px, py);
    if (refIdx >= 0) refOffset = locator.charTextStart[refIdx];
  }
  // 枚举 needle 的全部出现位置,选离参考锚点最近的一个
  let bestSel: number[] | null = null;
  let bestDist = Infinity;
  let searchFrom = 0;
  for (;;) {
    const idx = locator.normalizedText.indexOf(needle, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + 1;
    const os = locator.normalizedToOriginal[idx];
    const last = locator.normalizedToOriginal[idx + needle.length - 1];
    if (os == null || last == null) continue;
    const oe = last + 1; // 原始 pageText 区间 [os, oe)
    const sel = charIndexRangeForTextRange(locator, os, oe);
    if (!sel.length) continue;
    let dist: number;
    if (refOffset >= 0) {
      const startOff = locator.charTextStart[sel[0]];
      const endOff = locator.charTextStart[sel[sel.length - 1]];
      if (refOffset < startOff) dist = startOff - refOffset;
      else if (refOffset > endOff) dist = refOffset - endOff;
      else dist = 0; // 锚点落在该区间内
    } else {
      dist = 0; // 无参考锚点,取第一个出现
    }
    if (dist < bestDist) {
      bestDist = dist;
      bestSel = sel;
    }
  }
  if (!bestSel) return null;
  const matchedChars = bestSel.map((i) => locator.chars[i]);
  return {
    word: matchedChars.map((c) => c.c).join(""),
    rects: matchedChars.map((c) => c.rect),
    chars: matchedChars,
    locator,
  };
}

/** 字符是否为可组成单词的字母(含带重音的西欧字符)。 */
function isWordChar(c: string): boolean {
  if (!c || c === "undefined" || c === "null") return false;
  return /[A-Za-z\u00C0-\u024F]/.test(c);
}

/**
 * 从命中字符向两侧扩展连续字母(字符级词边界)。
 *
 * ⚠️ 关键认知(Zotero pdf.worker.mjs 源码 + pdf-worker DeepWiki 文档确认):
 * Zotero 生成 processed chars 时用 `glyph.unicode !== ' '` 排除空格字符,
 * 空格不存为独立字符,而是附着在前一字符的 `spaceAfter` 布尔标志上——
 * 这正是 Zotero 自己重建文本词边界的权威信号。
 *
 * 因此断词策略:
 *   1. 主信号:`spaceAfter === true`(该字符后是空格 → 词边界)
 *   2. 辅信号:`lineBreakAfter === true`(该字符后换行 → 词边界)
 *   3. 兜底:rect 间距(spaceAfter 字段缺失/异常时,字符间距 > 0.6×fontSize 视为空格)
 */
function expandWord(chars: WordChar[], centerIdx: number, currentBaseline: number): WordChar[] {
  const out = [chars[centerIdx]];

  // 向左扩展:检查 out[0](当前最左)的左侧字符 ch
  // 若 ch.spaceAfter === true,则 ch 和 out[0] 之间是空格 → 不包含 ch
  for (let i = centerIdx - 1; i >= 0; i--) {
    const ch = chars[i];
    if (!isWordChar(ch.c)) break;
    if (Math.abs(ch.baseline - currentBaseline) > 0.01) break;
    // 权威信号:ch 后是空格 → 词边界
    if (ch.spaceAfter || ch.lineBreakAfter) break;
    // 兜底:间距过大
    const next = out[0];
    const fs = Math.max(1, ch.fontSize || (ch.rect[2] - ch.rect[0]));
    const gap = next.rect[0] - ch.rect[2];
    if (gap > fs * 0.6) break;
    out.unshift(ch);
  }
  // 向右扩展:检查 out[last](当前最右)的右侧字符 ch
  // 若 out[last].spaceAfter === true,则 out[last] 和 ch 之间是空格 → 不包含 ch
  for (let i = centerIdx + 1; i < chars.length; i++) {
    const ch = chars[i];
    if (!isWordChar(ch.c)) break;
    if (Math.abs(ch.baseline - currentBaseline) > 0.01) break;
    // 权威信号:前一个已入词的字符后是空格 → 词边界
    const prev = out[out.length - 1];
    if (prev.spaceAfter || prev.lineBreakAfter) break;
    // 兜底:间距过大
    const fs = Math.max(1, prev.fontSize || (prev.rect[2] - prev.rect[0]));
    const gap = ch.rect[0] - prev.rect[2];
    if (gap > fs * 0.6) break;
    out.push(ch);
  }
  return out;
}

/**
 * C 通道核心:给定 PDF 命中点,在字符流里定位单词并返回字符 rect 列表。
 * 取词文本以 A 通道为准(调用方校验 found.word === hit.word),本函数只负责几何。
 */
export function locateWordAtPoint(
  locator: PageLocator,
  px: number,
  py: number,
): LocatedWord | null {
  const idx = closestCharIndex(locator, px, py);
  if (idx < 0) return null;
  const hit = locator.chars[idx];
  if (!isWordChar(hit.c)) return null;

  // 间隙判定:命中点必须落在该字符的水平范围附近(允许少量容差)才算
  // 「在词上」;悬停在词与词之间的空白处(间隙)时,px 落在两字符 rect
  // 之间的空白区,距离两个词都远 → 不高亮。容差取 0.25×fontSize
  // (约 1/4 字符宽)。
  const r = hit.rect;
  const tol = Math.max(1, hit.fontSize || (r[2] - r[0])) * 0.25;
  if (px < r[0] - tol || px > r[2] + tol) {
    logLocate(`locateWordAtPoint: gap (px=${px.toFixed(1)} outside char x[${r[0].toFixed(1)},${r[2].toFixed(1)}])`);
    return null;
  }

  const wordChars = expandWord(locator.chars, idx, hit.baseline);
  if (!wordChars.length) return null;

  return {
    word: wordChars.map((c) => c.c).join(""),
    rects: wordChars.map((c) => c.rect),
    chars: wordChars,
    locator,
  };
}

/**
 * PDF rect → page 局部 CSS 坐标(渲染方向)。
 * 主路径:viewport.convertToViewportPoint;兜底:viewBox 比例换算。
 * 返回 { rects, pageEl }:pageEl 是与 viewport 同源(page 局部坐标基准)
 * 的页面元素,渲染层必须把高亮挂到【这个 pageEl】上(而不是 range 的
 * pageEl)——否则坐标基准(document)不一致导致高亮整体偏移。
 */
export function pdfRectsToViewport(
  innerWin: Window,
  locator: PageLocator,
  rects: PdfRect[],
): { rects: { left: number; top: number; width: number; height: number }[]; pageEl: HTMLElement | null } {
  const out: { left: number; top: number; width: number; height: number }[] = [];
  let pageEl: HTMLElement | null = null;

  // 主路径:viewport 换算(viewport 来自 viewer iframe 的 page)
  try {
    const app = getPdfViewerApp(innerWin);
    const page = app?.pdfViewer?._pages?.[locator.pageIndex];
    const viewport = page?.viewport;
    pageEl = page?.div ?? null;
    if (!pageEl) {
      logLocate(`pdfRectsToViewport: no page.div for page ${locator.pageIndex} (fallback fixed)`);
    }
    if (viewport?.convertToViewportPoint) {
      for (const r of rects) {
        const [x1, y2] = viewport.convertToViewportPoint(r[0], r[1]);
        const [x2, y1] = viewport.convertToViewportPoint(r[2], r[3]);
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.max(1, Math.abs(x2 - x1));
        const height = Math.max(1, Math.abs(y2 - y1));
        if (isFinite(left) && isFinite(top) && isFinite(width) && isFinite(height)) {
          out.push({ left, top, width, height });
        }
      }
      if (out.length) {
        logLocate(`pdfRectsToViewport: page ${locator.pageIndex}, ${out.length} rects, first=(${out[0].left.toFixed(1)},${out[0].top.toFixed(1)},${out[0].width.toFixed(1)}x${out[0].height.toFixed(1)}), pageEl=${!!pageEl}`);
        return { rects: out, pageEl };
      }
    }
  } catch {
    /* fall through */
  }

  // 兜底:viewBox 比例(页面元素相对坐标,从 app 的 page div 取)
  try {
    if (!pageEl) {
      const app = getPdfViewerApp(innerWin);
      pageEl = app?.pdfViewer?._pages?.[locator.pageIndex]?.div ?? null;
    }
    const pr = pageEl?.getBoundingClientRect?.();
    const vb = locator.viewBox;
    if (pr && vb && vb[2] > vb[0] && vb[3] > vb[1]) {
      const w = vb[2] - vb[0];
      const h = vb[3] - vb[1];
      for (const r of rects) {
        out.push({
          left: ((r[0] - vb[0]) / w) * pr.width,
          top: ((vb[3] - r[3]) / h) * pr.height,
          width: Math.max(1, ((r[2] - r[0]) / w) * pr.width),
          height: Math.max(1, ((r[3] - r[1]) / h) * pr.height),
        });
      }
      return { rects: out, pageEl };
    }
  } catch {
    /* ignore */
  }
  return { rects: out, pageEl };
}

/**
 * 命中词包围盒(视口坐标,用于弹窗锚定)。
 * pdfRectsToViewport 返回的是 page 局部坐标,弹窗是 fixed 定位需要
 * 视口坐标,因此加上 page 元素的位置。返回 null 表示无可用几何。
 * 注意:x/left 语义与 hoverTranslate.positionPopup 的 anchor 一致。
 */
export function wordAnchorFromLocated(
  innerWin: Window,
  located: LocatedWord,
): { x: number; top: number; bottom: number } | null {
  const { rects: vp, pageEl } = pdfRectsToViewport(innerWin, located.locator, located.rects);
  if (!vp.length) return null;
  // page 局部 → 视口坐标(弹窗 fixed 定位需要视口坐标)
  let offX = 0, offY = 0;
  try {
    const pr = pageEl?.getBoundingClientRect?.();
    if (pr) { offX = pr.left; offY = pr.top; }
  } catch { /* ignore */ }
  const x = Math.min(...vp.map((r) => r.left)) + offX;
  const top = Math.min(...vp.map((r) => r.top)) + offY;
  const bottom = Math.max(...vp.map((r) => r.top + r.height)) + offY;
  return { x, top, bottom };
}

/** 释放某 reader 的定位器缓存(reader 关闭时调用)。 */
export function clearPageLocatorCache(reader: object): void {
  pageLocatorCache.delete(reader);
}

/** C 通道命中结果或「词间隙」标记(gap: true = 鼠标在词间空白处,不高亮)。 */
export type HybridResult = LocatedWord | null | { gap: true };

/**
 * 判断命中点是否落在字符间隙(词间空白)。
 *
 * 垂直窗口 ±2.5 字高(按最近行平均字号估算)内查找字符:
 *  - 窗口内无任何字符(行间隙 / 页边 / 该页 chars 数据缺失)→ 非 gap,
 *    回退 A 渲染,保证「高亮区域内移动时高亮不消失」;
 *  - 窗口内有字符但均不水平覆盖该点 → 词间空隙,判 gap(不高亮)。
 *
 * ⚠️ 演进:原实现只看最近行,鼠标在行间隙/小字号块边缘时切行误判 gap
 * → 高亮消失;恢复垂直窗口但引入「无字符 → 非 gap」判据,二者兼顾。
 */
function isInGap(locator: PageLocator, px: number, py: number): boolean {
  const chars = locator.chars;
  // 参考字号:取最近行的平均 fontSize
  const line = locator.lines[nearestLineIndex(locator, py)];
  let fsSum = 0;
  for (const i of line) fsSum += Math.max(1, chars[i].fontSize || (chars[i].rect[3] - chars[i].rect[1]));
  const refFs = fsSum / line.length || 10;
  const windowTol = Math.max(1, refFs) * 2.5;
  let foundAny = false;
  for (const ch of chars) {
    const r = ch.rect;
    const cy = (r[1] + r[3]) / 2;
    if (Math.abs(cy - py) > windowTol) continue;
    foundAny = true;
    // 与 locateWordAtPoint 一致的容差 0.25×fontSize
    const tol = Math.max(1, ch.fontSize || (r[2] - r[0])) * 0.25;
    if (px >= r[0] - tol && px <= r[2] + tol) return false; // 在某字符上
  }
  if (!foundAny) return false; // 窗口内无字符 → 非 gap → 回退 A 保高亮
  return true; // 有字符环绕但均不覆盖 → 词间空隙 → gap
}

/**
 * 命中辅助:优先 C 通道(字符 rect),失败回退 A 通道(range)。
 * 返回 LocatedWord = C 命中;{ gap: true } = 词间隙(不高亮);null = 回退 A。
 */
export async function locateWordHybrid(
  reader: object,
  innerWin: Window,
  hit: { word: string; range: Range },
  mouseX?: number,
  mouseY?: number,
): Promise<HybridResult> {
  // 页号:优先用 A 的 range 推导鼠标真实所在页(连续滚动下 currentPageNumber
  // 是焦点页,鼠标可能悬停相邻页 → 错页 pageEl 导致坐标/锚点整体偏移)。
  let pageIndex = currentPageIndexOf(innerWin);
  const rangePage = findPageIndexFromRange(hit.range);
  if (rangePage >= 0 && rangePage !== pageIndex) {
    logLocate(`locateWordHybrid: range page ${rangePage} vs currentPage ${pageIndex} → use ${rangePage}`);
    pageIndex = rangePage;
  }
  if (pageIndex < 0) {
    logLocate(`locateWordHybrid: no pageIndex (app=${!!getPdfViewerApp(innerWin)})`);
    return null;
  }
  const locator = await getPageLocator(reader, innerWin, pageIndex);
  if (!locator) {
    logLocate(`locateWordHybrid: locator null for page ${pageIndex} (fallback A)`);
    return null;
  }

  // 定位坐标:优先用鼠标事件坐标(与 A 的 range 无关,避免 A 的浏览器度量
  // 偏差传导到 C 定位——这正是 C 要消除的误差源)。
  try {
    let cx: number, cy: number;
    if (typeof mouseX === "number" && typeof mouseY === "number") {
      cx = mouseX;
      cy = mouseY;
    } else {
      const rect = hit.range.getBoundingClientRect();
      cx = rect.left + rect.width / 2;
      cy = rect.top + rect.height / 2;
    }
    const app = getPdfViewerApp(innerWin);
    const page = app?.pdfViewer?._pages?.[pageIndex];
    const viewport = page?.viewport;
    // page 元素位置:鼠标坐标(iframe viewport 系)→ page 相对坐标
    const pageEl = page?.div ?? (innerWin as any).document?.querySelector(
      `.page[data-page-number="${pageIndex + 1}"]`,
    );
    const pr = pageEl?.getBoundingClientRect?.();

    // 主路径:viewBox 比例换算(渲染像素尺寸 ↔ PDF 尺寸直接映射)。
    // ⚠️ 实测修正:convertToPdfPoint 在本环境系统性水平左偏(px 比字符
    // 左边界小 25-197 单位,均值 -129,且随位置变化 = 缩放不一致),导致
    // gap/text-match 大增、文本匹配锚点偏左(同词选错)。viewBox 比例用
    // pageEl 最终渲染尺寸映射,天然包含全部 CSS transform,与
    // annotationSync.domRectsToPdfRects / 高亮渲染同基准。
    let px: number, py: number;
    const relX = cx - pr.left;
    const relY = cy - pr.top;
    if (locator.viewBox && pr) {
      const vb = locator.viewBox;
      if (vb[2] > vb[0] && vb[3] > vb[1]) {
        px = vb[0] + (relX / Math.max(1, pr.width)) * (vb[2] - vb[0]);
        py = vb[3] - (relY / Math.max(1, pr.height)) * (vb[3] - vb[1]);
      } else {
        logLocate(`locateWordHybrid: no usable geometry (fallback A)`);
        return null;
      }
    } else if (viewport?.convertToPdfPoint && pr) {
      // 兜底:viewport 换算(无 viewBox 时)
      [px, py] = viewport.convertToPdfPoint(relX, relY);
    } else {
      logLocate(`locateWordHybrid: no viewport/pageEl (fallback A)`);
      return null;
    }

    const located = locateWordAtPoint(locator, px, py);
    // C 命中且词一致 → 标准 C 命中
    if (located && located.word === hit.word) {
      logLocate(`locateWordHybrid: C HIT "${located.word}" (${located.rects.length} rects) page=${pageIndex}`);
      return located;
    }
    // C 命中但词不一致 → 信任 C 的字符几何(不依赖 A 的 textLayer 度量)
    if (located) {
      logLocate(`locateWordHybrid: word mismatch "${located.word}" vs "${hit.word}" (trust C) page=${pageIndex} mouse=(${cx.toFixed(0)},${cy.toFixed(0)}) pdf=(${px.toFixed(1)},${py.toFixed(1)})`);
      return located;
    }
    // 坐标定位失败 → 文本匹配兜底:用 A 取词文本在字符流中定位。
    // 锚点优先取「A 的 range 在 textLayer 文本流中的偏移」(方案 A)——
    // textLayer 流与 chars 流同源,该偏移无歧义对应鼠标所指的词,
    // 不受 textLayer 几何错位 / 坐标偏差影响(悬停第 N 个同词 → 第 N 个)。
    let textAnchor = -1;
    try {
      const tlNonSpace = textLayerNonSpaceOffset(innerWin, hit.range);
      if (tlNonSpace >= 0) textAnchor = nonSpaceToPageOffset(locator, tlNonSpace);
    } catch {
      /* ignore */
    }
    const byText = locateWordByText(locator, hit.word, textAnchor, px, py);
    if (byText) {
      // 调试增强:打印匹配到的词在 PDF 的位置(at = 首字符 rect 左下角),
      // 与鼠标 pdf 点对比可判断锚点是否偏移、选中的是哪个同词。
      const r0 = byText.rects[0];
      const atStr = r0
        ? ` at=(${r0[0].toFixed(1)},${r0[1].toFixed(1)})`
        : " at=none";
      logLocate(`locateWordHybrid: text-match "${byText.word}" (${byText.rects.length} rects) page=${pageIndex}${atStr} mouse=(${cx.toFixed(0)},${cy.toFixed(0)}) pdf=(${px.toFixed(1)},${py.toFixed(1)})`);
      return byText;
    }
    // 文本匹配也失败 → 词间空隙判定(窗口内无字符 → 非 gap → 回退 A)
    if (isInGap(locator, px, py)) {
      logLocate(`locateWordHybrid: GAP (no highlight) page=${pageIndex} mouse=(${cx.toFixed(0)},${cy.toFixed(0)}) pdf=(${px.toFixed(1)},${py.toFixed(1)})`);
      return { gap: true as const };
    }
    logLocate(`locateWordHybrid: no located word (fallback A) page=${pageIndex} mouse=(${cx.toFixed(0)},${cy.toFixed(0)}) pdf=(${px.toFixed(1)},${py.toFixed(1)})`);
  } catch (e) {
    logLocate(`locateWordHybrid error: ${String((e as any)?.message || e)} (fallback A)`);
  }
  return null;
}

/** wordLocator 诊断日志(前缀 [hte-loc],Debug Output 可过滤)。 */
function logLocate(msg: string): void {
  try {
    (globalThis as any).Zotero?.debug?.(`[hte-loc] ${msg}`);
  } catch {
    /* ignore */
  }
}
