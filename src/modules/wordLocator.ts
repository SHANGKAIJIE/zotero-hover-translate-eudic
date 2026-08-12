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
  /** Zotero 官方原始 unicode 串(连字时是完整串如 "fi",官方 getMatchPositions
   *  计数规则 total += u.length - 1 的依据;aOff 对齐的权威来源)。 */
  u?: string;
  offset: number;
  rect: PdfRect;
  baseline: number;
  fontSize: number;
  rotation: number;
  /** Zotero processed chars 自带:该字符后是否有空格(词边界权威信号)。 */
  spaceAfter: boolean;
  /** 该字符后是否有换行(行边界)。 */
  lineBreakAfter: boolean;
  /** Zotero 官方 ignorable 标记(行尾连字符等):textLayer 渲染时被跳过,
   *  两流对齐时必须同样跳过(官方 getTextParts/buildSegmenterText 均
   *  `if (char.ignorable) continue`)。此前 seqToPage/pageText 未跳过 →
   *  每出现一个 ignorable 字符,textLayer 计数与 chars 流计数永久错位 +1。 */
  ignorable?: boolean;
  /** 该字符后是否有段落断行(官方计数规则计入,getTextFromChars 展开为空格)。 */
  paragraphBreakAfter?: boolean;
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
  /** 非空白序号 → pageText 偏移(预计算,nonSpaceToPageOffset O(1) 查表)。
   *  第 n 个「展开后」非空白字符对应 seqToPage[n](连字展开多个序号映射同一偏移)。 */
  seqToPage: number[];
  /** 两流(textLayer 渲染 vs chars 流)安全对齐的 pageText 偏移上界。
   *  公式区等特殊排版处 textLayer 含 chars 流没有的字符(组合标记/上下标),
   *  从该偏移往后 aOff 计数不可靠 → 实例校验应跳过。默认 = pageText.length。 */
  alignSafeUntil: number;
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
              "chars.push({ c: ch.c, u: (typeof ch.u === 'string' ? ch.u : ch.c), offset: (typeof ch.offset === 'number' && ch.offset >= 0 ? ch.offset : i), rect: [Number(ch.rect[0]), Number(ch.rect[1]), Number(ch.rect[2]), Number(ch.rect[3])], baseline: (typeof ch.baseline === 'number' ? ch.baseline : 0), fontSize: (typeof ch.fontSize === 'number' ? ch.fontSize : 0), rotation: (typeof ch.rotation === 'number' ? ch.rotation : 0), spaceAfter: !!(ch && ch.spaceAfter), lineBreakAfter: !!(ch && ch.lineBreakAfter), ignorable: !!(ch && ch.ignorable), paragraphBreakAfter: !!(ch && ch.paragraphBreakAfter) });" +
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
                      u: typeof ch.u === "string" ? ch.u : ch.c,
                      offset: typeof ch.offset === "number" ? ch.offset : -1,
                      rect: [Number(ch.rect[0]), Number(ch.rect[1]), Number(ch.rect[2]), Number(ch.rect[3])],
                      baseline: typeof ch.baseline === "number" ? ch.baseline : 0,
                      fontSize: typeof ch.fontSize === "number" ? ch.fontSize : 0,
                      rotation: typeof ch.rotation === "number" ? ch.rotation : 0,
                      spaceAfter: !!(ch && ch.spaceAfter),
                      lineBreakAfter: !!(ch && ch.lineBreakAfter),
                      ignorable: !!(ch && ch.ignorable),
                      paragraphBreakAfter: !!(ch && ch.paragraphBreakAfter),
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
          u: typeof ch.u === "string" ? ch.u : ch.c,
          offset: typeof ch.offset === "number" && ch.offset >= 0 ? ch.offset : i,
          rect: [ch.rect[0], ch.rect[1], ch.rect[2], ch.rect[3]],
          baseline: ch.baseline ?? 0,
          fontSize: ch.fontSize ?? 0,
          rotation: ch.rotation ?? 0,
          spaceAfter: !!ch.spaceAfter,
          lineBreakAfter: !!ch.lineBreakAfter,
          ignorable: !!ch.ignorable,
          paragraphBreakAfter: !!ch.paragraphBreakAfter,
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
      // 页面文本:按 offset 序拼接 chars,spaceAfter/lineBreakAfter 展开为空格。
      // ⚠️ 官方对齐:ignorable 字符(textLayer 渲染时被跳过,见 pdfWorker
      // getTextParts / buildSegmenterText 的 `if (char.ignorable) continue`)
      // 不进入 pageText —— 否则 textLayer 计数与 chars 流计数永久错位 +1,
      // 该字符之后所有 aOff(纯偏移定位 + 文本匹配锚点)整体漂移,
      // 同词多现时选中相邻错误实例("the"→另一个 the、"a"→range 里的 a)。
      let pageText = "";
      const charTextStart: number[] = [];
      for (let i = 0; i < chars.length; i++) {
        charTextStart[i] = pageText.length;
        if (chars[i].ignorable) continue;
        pageText += chars[i].c;
        if (chars[i].spaceAfter || chars[i].lineBreakAfter) pageText += " ";
      }
      const norm = normalizeTextWithMap(pageText);
      // 预计算「展开后非空白序号 → pageText 偏移」表(nonSpaceToPageOffset O(1))。
      // 2026-08-12 官方对齐:按 Zotero 官方 getMatchPositions 计数规则构建——
      // 每个字符占 u.length 个位置(连字 u="fi"→2、重音分解 u="e\u0301"→2),
      // 空白字符跳过。u 缺省时回退 expandedCharLen(c)(旧逻辑兜底)。
      const seqToPage: number[] = [];
      {
        // 2026-08-12 官方对齐:优先用官方 u 字段(原始 unicode 串)展开计数,
        // 与 DOM 侧 textLayerNonSpaceOffset 共用 expandedCharLen,保证两流一致。
        // u 缺省时回退 c。注意不能直接 u.length——官方注释:u 有时是分解
        // 连字 "fi"(2)、有时是单连字 "ﬁ"(1),必须统一走展开函数。
        // ⚠️ ignorable 字符与 DOM textLayer 计数同步跳过(官方渲染跳过),
        // 否则两侧计数从该字符起永久错位。
        const expandLen = (s: string): number => {
          let t = 0;
          for (const cc of s) t += expandedCharLen(cc);
          return t;
        };
        for (let ci = 0; ci < chars.length; ci++) {
          const ch = chars[ci];
          if (ch.ignorable || /\s/.test(ch.c)) continue;
          const src = ch.u && ch.u.length > 0 ? ch.u : ch.c;
          const len = expandLen(src);
          if (len <= 0) continue;
          const off = charTextStart[ci];
          for (let k = 0; k < len; k++) seqToPage.push(off);
        }
      }
      // 计算两流安全对齐上界(alignSafeUntil):展开序列第一个差异之前都可靠。
      // 公式区/上下标/组合标记差异会让 textLayer 计数与 chars 流累积错位,
      // 该偏移之后的 aOff 不可信 → 实例校验跳过(信任 C + 几何交叉验证兜底)。
      let alignSafeUntil = pageText.length;
      try {
        const docA = innerWin.document;
        const pageElA = docA.querySelector(`.page[data-page-number="${pageIndex + 1}"]`);
        const layerA = (pageElA?.querySelector(".textLayer") ?? docA.querySelector(".textLayer")) as HTMLElement | null;
        if (layerA) {
          const winA = (docA.defaultView ?? innerWin) as any;
          const walkerA = docA.createTreeWalker(layerA, winA.NodeFilter.SHOW_TEXT);
          let tlAll = "";
          let ndA: Node | null = walkerA.nextNode();
          while (ndA) { tlAll += (ndA as Text).data || ""; ndA = walkerA.nextNode(); }
          const expandS = (s: string) => {
            let o = "";
            for (const ch of s) {
              if (/\s/.test(ch)) continue;
              if (/\p{M}/u.test(ch)) continue;
              if (ch === "\u200b" || ch === "\u200c" || ch === "\u200d" || ch === "\ufeff" || ch === "\u00ad") continue;
              o += TEXT_LIGATURES[ch] ?? ch.normalize("NFKC");
            }
            return o;
          };
          const tlS = expandS(tlAll);
          const pgS = expandS(pageText);
          let firstDiff = -1;
          const minL = Math.min(tlS.length, pgS.length);
          for (let i = 0; i < minL; i++) {
            if (tlS[i] !== pgS[i]) { firstDiff = i; break; }
          }
          if (firstDiff >= 0) {
            alignSafeUntil = seqToPage[firstDiff] ?? pageText.length;
            logLocate(`alignSafe: page ${pageIndex} firstDiff@${firstDiff} alignSafeUntil=${alignSafeUntil}/${pageText.length}`);
          }
        }
      } catch {
        /* ignore */
      }
      const locator: PageLocator = {
        pageIndex,
        chars,
        viewBox,
        lines: groupLines(chars),
        pageText,
        normalizedText: norm.text,
        normalizedToOriginal: norm.map,
        charTextStart,
        seqToPage,
        alignSafeUntil,
      };
      return locator;
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
    // 2026-08-12 修复:组合标记跳过(与 expandedCharLen 的 \p{M}→0 同语义)。
    // 逐字符 NFKC 无法合成分解组合序列(需整串规范化),直接跳过避免
    // normalizedText 与 seqToPage 计数/文本匹配语义不一致。
    if (/\p{M}/u.test(raw)) {
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
    if (locator.chars[i].ignorable) continue; // 行尾连字符不进文本,也不进选择
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
/**
 * 在指定 textLayer 内计算「节点 node 第 offset 个字符」前的非空白展开计数。
 * 使用 tlIndexCache 索引(每 textLayer 构建一次,查询 O(节点数))。
 */
function nonSpaceCountInLayer(
  layer: Element,
  node: Node,
  offset: number,
  innerWin: Window,
): number {
  // 索引缓存:每 textLayer 构建一次「文本节点 + 节点前缀非空白计数」,
  // 查询 O(节点数)。DOM 重建时首节点脱离 → 失效重建。
  let idx = tlIndexCache.get(layer);
  if (!idx || !idx.nodes.length || !layer.contains(idx.nodes[0])) {
    const doc2 = layer.ownerDocument;
    const win2 = (doc2?.defaultView ?? innerWin) as any;
    if (!doc2 || !win2?.NodeFilter) return -1;
    const walker2 = doc2.createTreeWalker(layer, win2.NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const texts: string[] = [];
    const prefix: number[] = [];
    let running = 0;
    let n: Node | null = walker2.nextNode();
    while (n) {
      nodes.push(n as Text);
      texts.push((n as Text).data || "");
      n = walker2.nextNode();
    }
    // 先收集全部文本(行尾连字符判断需跨节点看下一节点开头是否 \n),
    // 再逐节点累计前缀计数(与 chars 流 ignorable 语义对齐)。
    for (let i = 0; i < nodes.length; i++) {
      prefix.push(running);
      running += nonSpaceExpandedCount(texts, i, texts[i].length);
    }
    idx = { nodes, prefix, texts };
    tlIndexCache.set(layer, idx);
  }
  let count = 0;
  for (let i = 0; i < idx.nodes.length; i++) {
    if (idx.nodes[i] === node) {
      count += idx.prefix[i];
      count += nonSpaceExpandedCount(idx.texts, i, offset);
      return count;
    }
  }
  return -1;
}

/**
 * 行尾连字符集合(2026-08-12 修改 B)。与官方 pdfWorker 的 dashChars
 * (worker.js:64599)一致:行尾连字符在 chars 流中被标记 ignorable 并跳过,
 * 但 pdf.js textLayer 渲染保留了它 → DOM 侧计数必须同步跳过,否则两流
 * 从第一处断行连字符起永久错位(实测该 PDF diff=-33,alignSafeUntil
 * 仅 330/4767,93% 区域 aOff 不可信 → C 通道全失败 → 全 A 通道)。
 */
const DASH_CHARS = new Set([
  "\x2D", "\u058A", "\u05BE", "\u1400", "\u1806", "\u2010", "\u2011",
  "\u2012", "\u2013", "\u2014", "\u2015", "\u2E17", "\u2E1A", "\u2E3A",
  "\u2E3B", "\u301C", "\u3030", "\u30A0", "\uFE31", "\uFE32", "\uFE58",
  "\uFE63", "\uFF0D",
]);

/**
 * 判断 textLayer 文本流中 (nodeIdx, unitPos) 处字符是否为「行尾连字符」:
 * 字符属于 DASH_CHARS 且其后(同节点或下一节点开头)紧跟空白(空格或 \n)。
 *
 * ⚠️ 2026-08-12 修复:官方语义是 `lineBreakAfter && dashChars.has(c)`,
 * 且官方 getTextParts(worker.js:107401)把 lineBreakAfter 渲染为【空格 ' '】,
 * 不是 \n。此前判断 `=== "\n"` 恒 false → 连字符从不被跳过 → diff=-33 依旧
 * → alignSafeUntil 仍 330/4767 → 同词错位复发。改为 /\s/ 后正确跳过。
 */
function isHyphenationDash(texts: string[], nodeIdx: number, unitPos: number): boolean {
  const text = texts[nodeIdx];
  if (unitPos < 0 || unitPos >= text.length) return false;
  const ch = text[unitPos];
  if (!DASH_CHARS.has(ch)) return false;
  if (unitPos + 1 < text.length) {
    return /\s/.test(text[unitPos + 1]);
  }
  // 节点末尾 → 看下一节点开头是否空白
  const next = texts[nodeIdx + 1];
  return !!next && next.length > 0 && /\s/.test(next[0]);
}

/**
 * 统计 textLayer 文本流中「节点 nodeIdx 前 unitLimit 个 UTF-16 code unit」
 * 的「非空白、非行尾连字符的展开计数」。
 *
 * ⚠️ 遍历按 code point 推进(而非 code unit):chars 流侧 expandLen 按
 * `for (const cc of s)`(code point)迭代,若这里按 code unit 对代理对
 * 逐半计 1(共 2),而 chars 侧完整字符 expandedCharLen→1,两流对非 BMP
 * 字符(emoji / 扩展区汉字)永久错位 → 必须同标尺。offset(unitLimit)
 * 是 caret 的 code unit 边界,落在代理对中间时按「未进入该字符」处理
 * (浏览器 caret 不会落在代理对内部,此分支仅防御)。
 *
 * 2026-08-12 修改 B:跳过行尾连字符(isHyphenationDash),与 chars 流
 * ignorable 语义对齐 —— 修复 textLayer 计数与 chars 流计数永久错位
 * (diff=-33),使 alignSafeUntil 恢复接近全页。
 */
function nonSpaceExpandedCount(
  texts: string[],
  nodeIdx: number,
  unitLimit: number,
): number {
  const text = texts[nodeIdx];
  let count = 0;
  let i = 0;
  const lim = Math.min(unitLimit, text.length);
  while (i < lim) {
    const cp = text.codePointAt(i);
    if (cp == null) break;
    const ch = String.fromCodePoint(cp);
    const unitLen = ch.length;
    // 字符整体必须在 limit 内才计入(避免代理对后半部分被半计)
    if (i + unitLen <= lim && !/\s/.test(ch) && !isHyphenationDash(texts, nodeIdx, i)) {
      count += expandedCharLen(ch);
    }
    i += unitLen;
  }
  return count;
}

function textLayerNonSpaceOffset(innerWin: Window, range: Range): number {
  try {
    const startNode = range.startContainer;
    if (!startNode || startNode.nodeType !== 3) return -1;
    let layer: Element | null = startNode.parentElement;
    while (layer && !layer.classList?.contains("textLayer")) {
      layer = layer.parentElement;
    }
    if (!layer) return -1;
    return nonSpaceCountInLayer(layer, startNode, range.startOffset, innerWin);
  } catch {
    return -1;
  }
}

/**
 * caretPositionFromPoint 取词(2026-08-12):浏览器原生「坐标→文本节点+偏移」,
 * Zotero 官方 setCaretPosition(reader.js)同款。从鼠标视口坐标直接返回
 * textLayer 内精确字符的非空白偏移——消灭自研 range 的滞后/脱节与 aOff 噪声。
 * 返回非空白计数(需经 nonSpaceToPageOffset 转页偏移);失败返回 -1。
 */
function caretNonSpaceOffset(
  innerWin: Window,
  clientX: number,
  clientY: number,
): number {
  try {
    const doc = innerWin.document;
    if (!doc) return -1;
    const docAny = doc as any;
    let node: Node | null = null;
    let offset = 0;
    // 2026-08-12 修改 3(caret 遮挡一致):与 getWordAtPoint 同款 —— Zotero
    // 的 annotationLayer(SVG 覆盖)会拦截 caretPositionFromPoint 命中测试,
    // 返回 annotation 元素而非文本节点(词边缘/标点旁尤其常见,正是用户
    // 报告的「微移切 A 通道」的触发点)。取词期间临时禁用 pointer-events,
    // 取词后立即恢复。
    const layers = doc.querySelectorAll(".annotationLayer") as NodeListOf<HTMLElement>;
    const prevPointerEvents: string[] = [];
    layers.forEach((el: HTMLElement) => {
      prevPointerEvents.push(el.style.pointerEvents);
      el.style.pointerEvents = "none";
    });
    try {
      if (typeof docAny.caretPositionFromPoint === "function") {
        const pos = docAny.caretPositionFromPoint(clientX, clientY);
        if (pos) {
          node = pos.offsetNode ?? null;
          offset = typeof pos.offset === "number" ? pos.offset : 0;
        } else if (!caretDiagOnce) {
          logLocate(`caret: caretPositionFromPoint=null at (${clientX},${clientY}) (first)`);
          caretDiagOnce = true;
        }
      } else if (typeof docAny.caretRangeFromPoint === "function") {
        const r = docAny.caretRangeFromPoint(clientX, clientY);
        if (r) {
          node = r.startContainer ?? null;
          offset = typeof r.startOffset === "number" ? r.startOffset : 0;
        } else if (!caretDiagOnce) {
          logLocate(`caret: caretRangeFromPoint=null at (${clientX},${clientY}) (first)`);
          caretDiagOnce = true;
        }
      } else if (!caretDiagOnce) {
        logLocate(`caret: no caret API in doc (first)`);
        caretDiagOnce = true;
      }
    } finally {
      layers.forEach((el: HTMLElement, i: number) => {
        el.style.pointerEvents = prevPointerEvents[i];
      });
    }
    if (!node || node.nodeType !== 3) {
      if (!caretDiagOnce) {
        logLocate(`caret: node=${node?.nodeName ?? "null"} not TEXT_NODE (first)`);
        caretDiagOnce = true;
      }
      return -1;
    }
    // 光标语义(2026-08-12):caret offset 是「光标位置」(字符后边界)。
    // 鼠标悬停词末字符时,光标落在词后 → offset 指向空格/下一词首字符,
    // 直接计数会让 expandWord 扩展出相邻词(表现为「鼠标微移跳词」)。
    // 命中字符回退规则:offset 处非词字符且前一字符是词字符 → 用前一字符。
    const text = (node as Text).data || "";
    let hitOffset = offset;
    if (hitOffset >= text.length && text.length > 0) hitOffset = text.length - 1;
    if (hitOffset > 0 && !isWordChar(text[hitOffset]) && isWordChar(text[hitOffset - 1])) {
      hitOffset -= 1;
    }
    let layer: Element | null = (node as Text).parentElement;
    while (layer && !layer.classList?.contains("textLayer")) {
      layer = layer.parentElement;
    }
    if (!layer) {
      if (!caretDiagOnce) {
        logLocate(`caret: node not in textLayer (first)`);
        caretDiagOnce = true;
      }
      return -1;
    }
    return nonSpaceCountInLayer(layer, node, hitOffset, innerWin);
  } catch {
    return -1;
  }
}

/** caret 诊断日志只打一次(避免刷屏)。 */
let caretDiagOnce = false;

/** textLayer 偏移索引缓存:WeakMap<textLayer, { 文本节点, 节点前缀非空白计数 }>。 */
const tlIndexCache = new WeakMap<Element, { nodes: Text[]; prefix: number[]; texts: string[] }>();

/**
 * 字符的「规范化展开长度」:textLayer DOM 与 chars 流 pageText 的对齐标尺。
 * - 连字 `ﬁ`(U+FB01)→ "fi"(2 字符)
 * - 组合标记 `̌`/`̇`(Unicode \p{M})→ 0(附着在前一字符上,不单独计数;
 *   与 textLayer 预组合 `š`=1 对齐)
 * - 普通 ASCII → 1(快速路径)
 * 注:逐字符 NFKC 无法合成「分解组合序列」(s+̌ → š 需整串规范化),因此
 * 组合标记走「跳过」策略而不是 NFKC 合并。
 */
function expandedCharLen(ch: string): number {
  if (ch.length !== 1) return 1;
  if (/\p{M}/u.test(ch)) return 0; // 组合标记:不计,附着前字符
  if (ch === "\u200b" || ch === "\u200c" || ch === "\u200d" || ch === "\ufeff" || ch === "\u00ad") {
    return 0; // 零宽/软连字符:textLayer 渲染层有,chars 流无 → 不计(与 normalizeTextWithMap 一致)
  }
  const mapped = TEXT_LIGATURES[ch];
  if (mapped) return mapped.length;
  if (ch.charCodeAt(0) < 0x80) return 1; // ASCII 快速路径
  return ch.normalize("NFKC").length;
}

/** pageText 中第 n 个「规范化展开」非空白字符的偏移(0-based);不足返回 -1。
 *  查表 O(1):locator.seqToPage 构建时预计算(与原扫描语义一致,已双路径校验)。 */
function nonSpaceToPageOffset(locator: PageLocator, n: number): number {
  if (n < 0) return -1;
  const arr = locator.seqToPage;
  return n < arr.length ? arr[n] : -1;
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
  // 参考锚点:优先文本流偏移;回退鼠标最近字符的页文本起始偏移。
  // ⚠️ 锚点可信性(2026-08-12 修复):文本流锚点仅在「安全对齐区」内可信;
  // 超出 alignSafeUntil(公式区等两流不一致处)时锚点带累积偏移,上下文
  // 比较与距离都会误导 → 视为无锚点,退化为坐标锚点 / 第一个出现。
  let refOffset = -1;
  const anchorTrusted =
    typeof anchorPageOffset === "number" &&
    anchorPageOffset >= 0 &&
    anchorPageOffset < locator.alignSafeUntil;
  if (anchorTrusted) {
    refOffset = anchorPageOffset;
  } else if (typeof px === "number" && typeof py === "number") {
    const refIdx = closestCharIndex(locator, px, py);
    if (refIdx >= 0) refOffset = locator.charTextStart[refIdx];
  }
  // 枚举 needle 的全部出现位置。
  // 选择策略(2026-08-12 第三轮):aOff 已精确(±1),上下文辅助安全。
  // 候选上下文(前2后2词,4 词唯一性极高)与鼠标所指处匹配得分优先,
  // 同分取距离最近——aOff 精确时远处候选上下文不可能匹配,不会强制选错。
  // 2026-08-12 修复:
  //   1) 词边界验证——needle 必须独占一个词(前后是空白/标点/行界),
  //      杜绝 "a" 匹配进 "range"/"data" 内部(单字母词错位到词内字母);
  //   2) 上下文得分仅在锚点可信(安全对齐区内)时启用,否则只看距离,
  //      避免漂移锚点的上下文误导选择(同词多现选相邻错误实例)。
  let bestSel: number[] | null = null;
  let bestDist = Infinity;
  let bestScore = -1;
  let searchFrom = 0;
  const nText = locator.normalizedText;
  const nLen = nText.length;
  const aCtx = refOffset >= 0 && anchorTrusted
    ? wordsAroundOffset(locator.pageText, refOffset, 2)
    : null;
  for (;;) {
    const idx = locator.normalizedText.indexOf(needle, searchFrom);
    if (idx < 0) break;
    searchFrom = idx + 1;
    // 词边界验证:匹配段前后必须不是字母(独立成词)。
    // "a" → "range" 内 a 前后是字母 → 排除;独立 "a" 前后是空格 → 通过。
    const before = idx > 0 ? nText[idx - 1] : "";
    const after = idx + needle.length < nLen ? nText[idx + needle.length] : "";
    if (before && isWordChar(before)) continue;
    if (after && isWordChar(after)) continue;
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
    // 上下文得分:候选前2/后2词与鼠标所指处逐词比较(仅非空词,各 +1)
    // 仅在锚点可信时启用(见上):漂移锚点的上下文会误导选择。
    let score = 0;
    if (aCtx) {
      const cCtx = wordsAroundOffset(locator.pageText, os, 2);
      if (cCtx.prev2 && cCtx.prev2 === aCtx.prev2) score++;
      if (cCtx.prev1 && cCtx.prev1 === aCtx.prev1) score++;
      if (cCtx.next1 && cCtx.next1 === aCtx.next1) score++;
      if (cCtx.next2 && cCtx.next2 === aCtx.next2) score++;
    }
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      bestScore = score;
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

/** 行片段区间(2026-08-13 句内定位:以 chars 流 lineBreakAfter 为边界)。 */
interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

/** 句内定位:定位 pageOffset 所在「行片段」区间 [start, end)(pageText 偏移)。 */
function sentenceSpanAtPageOffset(
  locator: PageLocator,
  pageOffset: number,
): { start: number; end: number } | null {
  const chars = locator.chars;
  if (!chars.length) return null;
  // 找 pageOffset 落在哪个字符(二分 charTextStart)
  let idx = -1;
  {
    let lo = 0, hi = chars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (locator.charTextStart[mid] <= pageOffset) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
  }
  if (idx < 0) return null;
  // 行片段起点:向前找第一个 lineBreakAfter 字符之后
  let s = idx;
  while (s > 0 && !chars[s - 1].lineBreakAfter) s--;
  // 行片段终点:向后找第一个 lineBreakAfter 字符(含)
  let e = idx;
  while (e < chars.length && !chars[e].lineBreakAfter) e++;
  const start = locator.charTextStart[s];
  const end = e < chars.length
    ? locator.charTextStart[e] + (chars[e].c.length)
    : locator.pageText.length;
  if (end <= start) return null;
  return { start, end };
}

/**
 * 定位 pageOffset 所在的「行片段」区间 [start, end)(pageText 偏移)。
 *
 * 2026-08-13 修复:以 chars 流 lineBreakAfter 为硬边界 —— 行片段天然不跨行,
 * 避免「句子过大 → 行间距/词边缘距离裁决跨行错位」。行内再按鼠标距离选。
 * 返回 null 表示无法定位(调用方回退原链)。
 */
/**
 * 取 pageText 中 offset 位置「前 n 词 / 当前词 / 后 n 词」(规范化小写)。
 * 用于上下文辅助定位:同词多实例时,比较鼠标所指处的上下文与候选词的
 * 上下文(前2后2 = 4 词,唯一性极高)。aOff 精确时上下文取词可靠。
 */
function wordsAroundOffset(
  text: string,
  offset: number,
  n: number,
): { prev1: string; prev2: string; curr: string; next1: string; next2: string } {
  const norm = (s: string) => s.toLowerCase();
  const len = text.length;
  // 当前词区间 [cs, ce)
  let cs = Math.min(Math.max(0, offset), len);
  while (cs > 0 && !/\s/.test(text[cs - 1])) cs--;
  let ce = cs;
  while (ce < len && !/\s/.test(text[ce])) ce++;
  // 向前收集 n 个词
  const prevs: string[] = [];
  {
    let p = cs;
    for (let k = 0; k < n; k++) {
      while (p > 0 && /\s/.test(text[p - 1])) p--;
      let s = p;
      while (s > 0 && !/\s/.test(text[s - 1])) s--;
      if (s === p) break;
      prevs.push(norm(text.slice(s, p)));
      p = s;
    }
  }
  // 向后收集 n 个词
  const nexts: string[] = [];
  {
    let q = ce;
    for (let k = 0; k < n; k++) {
      while (q < len && /\s/.test(text[q])) q++;
      let e = q;
      while (e < len && !/\s/.test(text[e])) e++;
      if (e === q) break;
      nexts.push(norm(text.slice(q, e)));
      q = e;
    }
  }
  return {
    prev2: prevs[1] ?? "",
    prev1: prevs[0] ?? "",
    curr: norm(text.slice(cs, ce)),
    next1: nexts[0] ?? "",
    next2: nexts[1] ?? "",
  };
}

/**
 * 从 A 通道 range 的 DOM 文本提取上下文(前2后2词,小写规范化)。
 *
 * 2026-08-12 指纹预检:A 通道 range 来自 caretPositionFromPoint(浏览器原生
 * 「鼠标→字符」映射),其【词文本归属】始终正确(鼠标在下一行 → 文本节点
 * 就是下一行的),只有渲染位置(getClientRects)带偏差。因此从 range 的
 * startContainer 文本节点向前后兄弟 span 扩展,可拿到鼠标所指实例的真实
 * 上下文 —— 独立于 aOff / 坐标换算 / 几何度量,不受 alignSafeUntil 限制。
 * 返回 null 表示无法提取(调用方回退原链)。
 */
function wordsAroundRange(
  innerWin: Window,
  range: Range,
): { prev2: string; prev1: string; curr: string; next1: string; next2: string } | null {
  try {
    const node = range.startContainer;
    if (!node || node.nodeType !== 3) return null;
    const text = (node as Text).data || "";
    // 当前词在 node 内的边界(基于 range.startOffset)
    let cs = Math.min(Math.max(0, range.startOffset), text.length);
    let ce = cs;
    while (cs > 0 && isWordChar(text[cs - 1])) cs--;
    while (ce < text.length && isWordChar(text[ce])) ce++;
    const curr = text.slice(cs, ce).toLowerCase();
    if (!curr) return null;

    // 前文:node 内 [0, cs) + 前面兄弟 span 的文本(向前最多 200 字符)。
    // ⚠️ 2026-08-12 修复:跨 span 拼接必须补空格分隔 —— 否则词被粘粘
    // ("in"+"eq"→"ineq"、"scale"+"c"→"scalerc"、"radius"+"re"+"traces"
    // →"radiusretraces"),ref 上下文词与 pageText 候选不一致 → 匹配失败
    // → ctx-fp 命中率仅 22%。textLayer span 是行片段,span 边界即词界。
    let beforeText = text.slice(0, cs);
    let el = (node as Text).parentElement;
    let prev = el?.previousElementSibling;
    while (prev && beforeText.length < 200) {
      beforeText = (prev.textContent || "").replace(/[ \t]+$/, "") + " " + beforeText;
      prev = prev.previousElementSibling;
    }
    // 后文:node 内 [ce, end) + 后面兄弟 span 的文本(向后最多 200 字符)
    let afterText = text.slice(ce);
    let next = el?.nextElementSibling;
    while (next && afterText.length < 200) {
      afterText += " " + (next.textContent || "").replace(/^[ \t]+/, "");
      next = next.nextElementSibling;
    }

    // 从 beforeText 提取前2词(从后往前)
    const prevs: string[] = [];
    {
      let p = beforeText.replace(/\s+$/, "");
      for (let k = 0; k < 2; k++) {
        const m = p.match(/[A-Za-z\u00C0-\u024F]+$/);
        if (!m) break;
        prevs.push(m[0].toLowerCase());
        p = p.slice(0, p.length - m[0].length).replace(/\s+$/, "");
      }
    }
    // 从 afterText 提取后2词(从前往后)
    const nexts: string[] = [];
    {
      let q = afterText.replace(/^\s+/, "");
      for (let k = 0; k < 2; k++) {
        const m = q.match(/^[A-Za-z\u00C0-\u024F]+/);
        if (!m) break;
        nexts.push(m[0].toLowerCase());
        q = q.slice(m[0].length).replace(/^\s+/, "");
      }
    }
    return {
      prev2: prevs[1] ?? "",
      prev1: prevs[0] ?? "",
      curr,
      next1: nexts[0] ?? "",
      next2: nexts[1] ?? "",
    };
  } catch {
    return null;
  }
}

/** 上下文词规范化:去标点/大小写(候选 pageText 词可能带逗号等标点)。 */
function cleanCtxWord(s: string): string {
  return (s || "").toLowerCase().replace(/[^A-Za-z\u00C0-\u024F]/g, "");
}

/**
 * 上下文指纹预检(2026-08-12):
 * A 通道 range 的 DOM 上下文 vs chars 流候选实例上下文,全等且唯一 →
 * 直接锁定该实例。这是独立于 aOff / 坐标 / 几何的第三定位维度,专门解决
 * 「文字一致但实例错位」—— 垂直行错位(坐标残差命中相邻行同词)、几何
 * 误杀(aCenter 带 textLayer 偏差)都绕开。
 *
 * 返回 LocatedWord = 指纹唯一锁定;null = 取不到 / 不唯一 → 调用方回退原链。
 */
function locateWordByContext(
  innerWin: Window,
  locator: PageLocator,
  hit: { word: string; range: Range },
  mouseY?: number,
): LocatedWord | null {
  try {
    const ref = wordsAroundRange(innerWin, hit.range);
    if (!ref) return null;
    // 当前词文本应与 hit.word 一致(防御:range 归属异常时不预检)
    const refCurr = cleanCtxWord(ref.curr);
    const hitNorm = cleanCtxWord(hit.word);
    if (!refCurr || !hitNorm || refCurr !== hitNorm) return null;

    const needle = normalizeTextWithMap(hit.word).text;
    if (!needle) return null;
    let matchSel: number[] | null = null;
    let matchCount = 0;
    const nText = locator.normalizedText;
    const nLen = nText.length;
    let searchFrom = 0;
    for (;;) {
      const idx = nText.indexOf(needle, searchFrom);
      if (idx < 0) break;
      searchFrom = idx + 1;
      // 词边界验证:匹配段前后必须不是字母(独立成词)
      const before = idx > 0 ? nText[idx - 1] : "";
      const after = idx + needle.length < nLen ? nText[idx + needle.length] : "";
      if (before && isWordChar(before)) continue;
      if (after && isWordChar(after)) continue;
      const os = locator.normalizedToOriginal[idx];
      const last = locator.normalizedToOriginal[idx + needle.length - 1];
      if (os == null || last == null) continue;
      const oe = last + 1;
      const sel = charIndexRangeForTextRange(locator, os, oe);
      if (!sel.length) continue;
      // 候选实例上下文 vs 参考上下文(全等 → 命中)
      const cCtx = wordsAroundOffset(locator.pageText, os, 2);
      if (
        cleanCtxWord(cCtx.prev1) === cleanCtxWord(ref.prev1) &&
        cleanCtxWord(cCtx.prev2) === cleanCtxWord(ref.prev2) &&
        cleanCtxWord(cCtx.next1) === cleanCtxWord(ref.next1) &&
        cleanCtxWord(cCtx.next2) === cleanCtxWord(ref.next2)
      ) {
        matchCount++;
        matchSel = sel;
      }
    }
    if (matchCount !== 1 || !matchSel) return null; // 不唯一 → 回退原链
    const matchedChars = matchSel.map((i) => locator.chars[i]);
    // ── 2026-08-12 鼠标行归属校验 ──
    // 上下文指纹唯一锁定后,再做一道「行校验」:锁定实例的渲染中心
    // (cChannelCenter,数据驱动)必须与鼠标 Y 同处一行(垂直差 ≤ 半行高 +
    // 容差)。防止「上下文碰巧相同但错行」(如两行都有 "the soliton"
    // 且上下文恰好一致的极端场景)被指纹误锁。鼠标坐标不可用时跳过。
    if (typeof mouseY === "number") {
      try {
        const cC = cChannelCenter(innerWin, locator, {
          word: matchedChars.map((c) => c.c).join(""),
          rects: matchedChars.map((c) => c.rect),
          chars: matchedChars,
          locator,
        });
        if (cC) {
          const dy = Math.abs(mouseY - cC.y);
          const rowThr = Math.max(16, cC.h * 1.8);
          if (dy > rowThr) {
            logLocate(
              `ctx-fp: "${hit.word}" row-check FAIL dy=${dy.toFixed(1)} thr=${rowThr.toFixed(1)} → fallback`,
            );
            return null;
          }
        }
      } catch { /* ignore */ }
    }
    return {
      word: matchedChars.map((c) => c.c).join(""),
      rects: matchedChars.map((c) => c.rect),
      chars: matchedChars,
      locator,
    };
  } catch {
    return null;
  }
}

/**
 * 句内定位(2026-08-13,移植 zotero-sentence-translator 思路):
 * 先定鼠标所指的【句子】(pageText 中按标点切分,10-40 词长文本唯一性极高),
 * 再在句子内找 hit.word 实例。句子内唯一 → 直接锁定;句子内重复 → 用鼠标
 * 坐标距离(真实指向)选最近。天然区分跨行场景(两行是不同句子),且不依赖
 * 两流对齐 / ctx-fp 上下文唯一性。
 *
 * 锚点:caret 精确字符 → textLayer 非空白序号 → chars 流偏移 aOff。
 * aOff 不可信(>= alignSafeUntil)时退化为坐标锚点,仍可切句。
 *
 * 返回 LocatedWord = 句内锁定;null = 无法切句 / 句子内找不到 → 回退原链。
 */
function locateWordBySentence(
  innerWin: Window,
  locator: PageLocator,
  hit: { word: string; range: Range },
  mouseX?: number,
  mouseY?: number,
): LocatedWord | null {
  try {
    // 1. 锚点偏移:caret 精确(优先)/ A range 文本流(回退)
    let n = -1;
    if (typeof mouseX === "number" && typeof mouseY === "number") {
      n = caretNonSpaceOffset(innerWin, mouseX, mouseY);
    }
    if (n < 0) {
      const tlNonSpace = textLayerNonSpaceOffset(innerWin, hit.range);
      if (tlNonSpace >= 0) n = tlNonSpace;
    }
    if (n < 0) return null;
    const aOff = nonSpaceToPageOffset(locator, n);
    if (aOff < 0) return null;

    // 2. 定位所在「行片段」:以 chars 流 lineBreakAfter 为硬边界。
    //    ⚠️ 2026-08-13 修复:原用 pageText 标点切句,但 pageText 构建把
    //    lineBreakAfter 压成空格 → 行边界丢失 → "句子"过大(整页头并一起)
    //    → 行间距/词边缘场景句内 hits 多 → 距离裁决跨行错位。改用 chars
    //    流的 lineBreakAfter 切分:行片段天然不跨行,同词一行内多现概率更低。
    const span = sentenceSpanAtPageOffset(locator, aOff);
    if (!span) return null;

    // 3. 句内枚举 hit.word 全部实例(词边界验证)
    const needle = normalizeTextWithMap(hit.word).text;
    if (!needle) return null;
    const sText = locator.pageText.slice(span.start, span.end);
    const sTextLower = sText.toLowerCase();
    const needleLower = needle.toLowerCase();
    const hits: { sel: number[]; os: number }[] = [];
    let searchFrom = 0;
    for (;;) {
      const rel = sTextLower.indexOf(needleLower, searchFrom);
      if (rel < 0) break;
      searchFrom = rel + 1;
      const absStart = span.start + rel;
      // 词边界验证(句子文本内)
      const before = rel > 0 ? sText[rel - 1] : " ";
      const after = rel + needle.length < sText.length ? sText[rel + needle.length] : " ";
      if (before && isWordChar(before)) continue;
      if (after && isWordChar(after)) continue;
      // 原始偏移 → chars 索引
      const sel = charIndexRangeForTextRange(locator, absStart, absStart + needle.length);
      if (!sel.length) continue;
      hits.push({ sel, os: absStart });
    }
    if (!hits.length) return null;

    // 4. 句子内唯一 → 直接锁定;重复 → 鼠标坐标距离选最近
    let best: { sel: number[]; os: number } | null = null;
    if (hits.length === 1) {
      best = hits[0];
    } else if (typeof mouseX === "number" && typeof mouseY === "number") {
      let bestDist = Infinity;
      for (const h of hits) {
        const chars = h.sel.map((i) => locator.chars[i]);
        const cC = cChannelCenter(innerWin, locator, {
          word: chars.map((c) => c.c).join(""),
          rects: chars.map((c) => c.rect),
          chars,
          locator,
        });
        if (!cC) continue;
        const dist = Math.hypot(mouseX - cC.x, mouseY - cC.y);
        if (dist < bestDist) {
          bestDist = dist;
          best = h;
        }
      }
    }
    if (!best) return null;

    // 5. 行归属校验(防句内相邻词被距离误判)
    const matchedChars = best.sel.map((i) => locator.chars[i]);
    if (typeof mouseY === "number") {
      try {
        const cC = cChannelCenter(innerWin, locator, {
          word: matchedChars.map((c) => c.c).join(""),
          rects: matchedChars.map((c) => c.rect),
          chars: matchedChars,
          locator,
        });
        if (cC) {
          const dy = Math.abs(mouseY - cC.y);
          const rowThr = Math.max(16, cC.h * 1.8);
          if (dy > rowThr) {
            logLocate(
              `sent: "${hit.word}" row-check FAIL dy=${dy.toFixed(1)} thr=${rowThr.toFixed(1)} → fallback`,
            );
            return null;
          }
        }
      } catch { /* ignore */ }
    }
    logLocate(
      `sent: "${hit.word}" in span[${span.start},${span.end}) "${locator.pageText.slice(span.start, span.end).slice(0, 50)}${locator.pageText.slice(span.start, span.end).length > 50 ? "…" : ""}" hits=${hits.length} → lock`,
    );
    return {
      word: matchedChars.map((c) => c.c).join(""),
      rects: matchedChars.map((c) => c.rect),
      chars: matchedChars,
      locator,
    };
  } catch {
    return null;
  }
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
 * 字符 offset(getPageData 的 offset 字段,单调递增)→ locator.chars 数组索引。
 * 二分查找;未命中返回 -1。
 */
function charIndexAtOffset(locator: PageLocator, offset: number): number {
  let lo = 0;
  let hi = locator.chars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = locator.chars[mid].offset;
    if (o === offset) return mid;
    if (o < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * C 命中词在页文本流(pageText)中的偏移区间 [start, end)。
 * 基于 charTextStart:字符索引 → 页文本偏移;词尾 = 末字符起始 + 1。
 * 返回 null 表示无法计算(字符索引缺失)。
 */
function locatedOffsetRange(
  locator: PageLocator,
  located: LocatedWord,
): [number, number] | null {
  const cs = located.chars;
  if (!cs.length) return null;
  const s = charIndexAtOffset(locator, cs[0].offset);
  const e = charIndexAtOffset(locator, cs[cs.length - 1].offset);
  if (s < 0 || e < 0 || e < s) return null;
  const start = locator.charTextStart[s];
  const end = locator.charTextStart[e] + 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return [start, end];
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
 * A 通道 range 的视口坐标包围盒中心(caretPositionFromPoint 精确命中的
 * 字符在浏览器渲染层的位置)。用于与 C 通道坐标交叉验证(方案 B/C)。
 * 返回 null 表示无法取得(空 rect / 异常)。
 */
function aChannelCenter(
  innerWin: Window,
  range: Range,
): { x: number; y: number; w: number; h: number } | null {
  try {
    const rects = range.getClientRects();
    if (!rects?.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const rc of rects) {
      if (rc.width === 0 && rc.height === 0) continue;
      l = Math.min(l, rc.left); t = Math.min(t, rc.top);
      r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
    }
    if (!isFinite(l) || !isFinite(t)) return null;
    return { x: (l + r) / 2, y: (t + b) / 2, w: r - l, h: b - t };
  } catch {
    return null;
  }
}

/**
 * C 通道命中字符渲染到视口后的包围盒中心。
 * pdfRectsToViewport 返回 page 局部坐标(挂 pageEl 的 position:absolute),
 * 需加 pageEl 的视口偏移还原为视口坐标,与 A 通道中心同坐标系比较。
 * pageEl 为 null 时 rect 已是 position:fixed 视口坐标(偏移 0,一致)。
 * 返回 null 表示无法取得。
 */
function cChannelCenter(
  innerWin: Window,
  locator: PageLocator,
  located: LocatedWord,
): { x: number; y: number; w: number; h: number } | null {
  try {
    const { rects, pageEl } = pdfRectsToViewport(innerWin, locator, located.rects);
    if (!rects.length) return null;
    const pel = pageEl?.getBoundingClientRect?.();
    const ox = pel?.left ?? 0;
    const oy = pel?.top ?? 0;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const rc of rects) {
      l = Math.min(l, ox + rc.left); t = Math.min(t, oy + rc.top);
      r = Math.max(r, ox + rc.left + rc.width); b = Math.max(b, oy + rc.top + rc.height);
    }
    if (!isFinite(l)) return null;
    return { x: (l + r) / 2, y: (t + b) / 2, w: r - l, h: b - t };
  } catch {
    return null;
  }
}

/**
 * pageText 偏移 → 该偏移所在字符的 chars 数组索引(二分 charTextStart)。
 * charTextStart 单调递增;返回「最后一个 start <= offset」的索引;未命中 -1。
 */
function charIndexAtPageOffset(locator: PageLocator, pageOffset: number): number {
  let lo = 0;
  let hi = locator.chars.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (locator.charTextStart[mid] <= pageOffset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * 纯数据流定位(根治同词错位):给定 pageText 偏移,直接在 chars 流中
 * 确定该字符并扩展成完整单词。不经过坐标换算、不依赖"最近字符"匹配——
 * 偏移来自 caretPositionFromPoint(浏览器原生「鼠标→字符」精确映射),
 * 实例身份由偏移唯一决定,同词错位在数学上不可能发生。
 */
function locateWordAtPageOffset(
  locator: PageLocator,
  pageOffset: number,
): LocatedWord | null {
  const idx = charIndexAtPageOffset(locator, pageOffset);
  if (idx < 0) return null;
  const hit = locator.chars[idx];
  if (!isWordChar(hit.c)) return null; // 该偏移落在空格/符号上
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
 * byText 兜底结果的几何确认(2026-08-12 修复):
 * 文本匹配可能选到相邻同词实例(锚点漂移时),返回前必须确认候选实例
 * 渲染到视口后的中心与 A range 中心重合。阈值收紧至 ×0.6(原 ×0.9 会
 * 放过相隔 1-2 词的相邻实例)。几何中心不可用时不拦截(维持原行为)。
 * 拒绝时返回 false,调用方回退 A 通道(文本正确、几何略偏可接受,
 * 远好于高亮错误实例)。
 */
function byTextGeomOk(
  innerWin: Window,
  locator: PageLocator,
  byText: LocatedWord,
  hit: { word: string; range: Range },
): boolean {
  try {
    const aC = aChannelCenter(innerWin, hit.range);
    const cC = cChannelCenter(innerWin, locator, byText);
    if (aC && cC) {
      const dist = Math.hypot(aC.x - cC.x, aC.y - cC.y);
      const thr = Math.max(6, (aC.w + cC.w) * 0.6);
      if (dist <= thr) return true;
      logLocate(`byText GEO-REJECT "${byText.word}" d=${dist.toFixed(1)} thr=${thr.toFixed(1)} → fallback A`);
      return false;
    }
  } catch {
    /* ignore */
  }
  return true;
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

  // ── 2026-08-13 句内定位(最高优先级)──
  // 先定鼠标所指的【句子】(pageText 按标点切分,10-40 词长文本唯一性极高),
  // 再在句子内找 hit.word —— 句子内唯一直接锁,重复用鼠标距离选最近。
  // 天然区分跨行场景(两行是不同句子),不依赖两流对齐/上下文唯一性。
  // 无法切句 / 句内找不到 → 回退下方 ctx-fp / 几何链。
  try {
    const sentHit = locateWordBySentence(innerWin, locator, hit, mouseX, mouseY);
    if (sentHit) return sentHit;
  } catch { /* ignore */ }

  // ── 2026-08-12 上下文指纹预检(主定位路径,独立于 aOff/坐标/几何)──
  // A 通道 range(caretPositionFromPoint 原生映射)的词文本归属始终正确,
  // 取其 DOM 上下文(前2后2词)与 chars 流候选实例比较,全等且唯一 →
  // 直接锁定该实例。专门解决垂直行错位(坐标残差命中相邻行同词)、几何
  // 误杀(aCenter 带 textLayer 偏差)。不唯一 / 取不到 → 回退下方原链。
  try {
    const ctxHit = locateWordByContext(innerWin, locator, hit, mouseY);
    if (ctxHit) {
      return ctxHit;
    }
  } catch { /* ignore */ }

  // ── 2026-08-12 停用 pure-offset 主路径 ──
  // 该路径依赖「textLayer 与 chars 流两流计数对齐」(aOff < alignSafeUntil)。
  // 用户 PDF 的 textLayer 行尾连字符直接接下一词(diff=-33 无法修复),两流
  // 从第 280 字符起永久错位,alignSafeUntil 仅 330/4767 → 93% 区域 aOff 不可信
  // → pure-offset 在此 PDF 上 0 命中,纯属无效计算。直接跳过,由 ctx-fp
  // (主)与坐标路径(兜底)接管。其他 PDF 若两流对齐,下方坐标路径仍可工作。
  // 原 pure-offset 代码(caret→aOff→词扩展 + aCenter 几何确认)已整体移除,
  // 需要恢复时从 git 历史 .backup-2026-08-12-twofold 取回。

  // 定位坐标:优先鼠标原始坐标(caret 取词已精确;textLayer 的浏览器几何
  // aCenter 存在字体 fallback/百分比舍入偏差,不应作为 C 通道定位锚点——
  // C 定位必须基于 PDF 数据坐标,几何交叉验证(cCenter vs aCenter)单独使用)。
  try {
    let cx: number, cy: number;
    const aCenter = aChannelCenter(innerWin, hit.range);
    if (typeof mouseX === "number" && typeof mouseY === "number") {
      cx = mouseX;
      cy = mouseY;
    } else if (aCenter) {
      cx = aCenter.x;
      cy = aCenter.y;
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
        return null;
      }
    } else if (viewport?.convertToPdfPoint && pr) {
      // 兜底:viewport 换算(无 viewBox 时)
      [px, py] = viewport.convertToPdfPoint(relX, relY);
    } else {
      return null;
    }

    const located = locateWordAtPoint(locator, px, py);
    // ── 实例校验(方案 B/C 增强版,2026-08-12 第二轮):同词多实例防错位 ──
    // C 命中只保证「词文本一致」,不保证是鼠标所指的【那个】实例。
    // 校验手段(按可靠度):
    //   A. 文本流偏移(与坐标无关,最可靠)——多字符词主用(原阶段3);
    //   B. A/C 通道坐标交叉验证(新增):C 命中字符渲染到视口后的位置
    //      应与 A 通道 range(caretPositionFromPoint 精确命中)的渲染位置
    //      重合;偏差超阈值 → C 选错实例(坐标换算残差)。
    //  - 多字符词:文本流校验优先,坐标交叉验证作兜底裁决;
    //  - 单字符词(a/i):原跳过(文本流偏移噪声 2-12 必然超 1 字符区间),
    //    改为坐标邻近校验——C 与 A 重合则信任 C,严重不一致则修正/回退 A。
    // aCenter 已在锚点段提前计算(方案 A 复用)。
    if (located) {
      // aOff:优先 caretPositionFromPoint(鼠标坐标,浏览器原生精确字符,
      // 官方 setCaretPosition 同款,消灭 aOff 噪声);回退 range 文本流偏移。
      let n = -1;
      if (typeof mouseX === "number" && typeof mouseY === "number") {
        n = caretNonSpaceOffset(innerWin, mouseX, mouseY);
      }
      if (n < 0) {
        const tlNonSpace = textLayerNonSpaceOffset(innerWin, hit.range);
        if (tlNonSpace >= 0) n = tlNonSpace;
      }
      const aOff = n >= 0 ? nonSpaceToPageOffset(locator, n) : -1;
      const rng = locatedOffsetRange(locator, located);
      // 文本流校验仅在「安全对齐区」内可信:公式区等两流不一致处,
      // aOff 带累积偏差 → 跳过文本流校验,交由几何交叉验证/信任 C。
      // ±2 容差:caretPositionFromPoint 的 offset 是光标位置(字符后边界),
      // 数 offset 前字符时系统性多 1;真正错位的实例间距远大于 2,不受影响。
      const textMismatch =
        aOff >= 0 && rng && aOff < locator.alignSafeUntil &&
        (aOff < rng[0] - 2 || aOff >= rng[1] + 2);
      const cCenter = cChannelCenter(innerWin, locator, located);
      if (located.word.length > 1) {
        // 多字符词:文本流校验(原逻辑)
        if (textMismatch) {
          const byText = locateWordByText(locator, hit.word, aOff, px, py);
          // 2026-08-12 不再 byTextGeomOk 拦截(见 byText final 注释)
          if (byText) return byText;
        }
        // 坐标交叉验证兜底:文本流一致但坐标严重偏离(转换偏差极端场景)。
        // 2026-08-12 基准修正:aCenter(range.getClientRects,textLayer 浏览器
        // 度量)带偏差会误杀 → 改用【鼠标坐标】与 C 渲染中心比较(真实指向)。
        if (!textMismatch && typeof mouseY === "number" && cCenter) {
          const dy = Math.abs(mouseY - cCenter.y);
          const rowThr = Math.max(16, cCenter.h * 1.8);
          if (dy > rowThr) {
            const byText = locateWordByText(
              locator, hit.word, aOff >= 0 ? aOff : undefined, px, py,
            );
            // 2026-08-12 信任 byText;失败信任 located(word 已一致)
            if (byText) return byText;
            return located;
          }
        }
      } else {
        // 单字符词:鼠标邻近校验(替代原 aCenter 基准 —— 带 textLayer 偏差)
        if (typeof mouseY === "number" && cCenter) {
          const dy = Math.abs(mouseY - cCenter.y);
          const rowThr = Math.max(16, cCenter.h * 1.8);
          if (dy > rowThr) {
            // C 与鼠标严重不一致 → 尝试文本流修正;失败信任 located
            if (aOff >= 0) {
              const byText = locateWordByText(locator, hit.word, aOff, px, py);
              if (byText) return byText; // 2026-08-12 信任 byText
            }
            return located; // 2026-08-12 信任 C,不回退 A
          }
        }
      }
    }
    // C 命中 → 信任 C 的字符几何,但先做【鼠标行归属校验】。
    // 2026-08-12:word 一致 ≠ 实例一致 —— 词边缘/行间时,坐标残差让
    // locateWordAtPoint 命中相邻词实例,located.word === hit.word 直接放行
    // → 同词错位。此处用鼠标坐标(真实指向,无 textLayer 偏差)与 located
    // 渲染中心(cChannelCenter,数据驱动)比较:垂直差 > 行高×1.2 说明命中
    // 了相邻行/相邻词实例 → 尝试 byText 修正(锚点=鼠标,找正确实例);
    // 修正失败才信任 located 保底(至少 word 正确,优于不高亮)。
    if (located) {
      if (typeof mouseY === "number") {
        try {
          const cC = cChannelCenter(innerWin, locator, located);
          if (cC) {
            const dy = Math.abs(mouseY - cC.y);
            const rowThr = Math.max(16, cC.h * 1.8);
            if (dy > rowThr) {
              const byText = locateWordByText(locator, hit.word, undefined, px, py);
              if (byText) return byText;
              return located;
            }
          }
        } catch { /* ignore */ }
      }
      logLocate(`C-HIT "${located.word}" (${located.rects.length} rects) trust-C`);
      return located;
    }
    // 坐标定位失败 → 文本匹配兜底:用 A 取词文本在字符流中定位。
    // 锚点优先取「A 的 range 在 textLayer 文本流中的偏移」(方案 A)——
    // textLayer 流与 chars 流同源,该偏移无歧义对应鼠标所指的词,
    // 不受 textLayer 几何错位 / 坐标偏差影响(悬停第 N 个同词 → 第 N 个)。
    // ⚠️ 2026-08-12 修复:锚点超出安全对齐区(alignSafeUntil)时,
    // textAnchor 已带累积偏移,不再可信 → 不传入(退化为坐标锚点)。
    let textAnchor = -1;
    try {
      const tlNonSpace = textLayerNonSpaceOffset(innerWin, hit.range);
      if (tlNonSpace >= 0) {
        const ta = nonSpaceToPageOffset(locator, tlNonSpace);
        if (ta >= 0 && ta < locator.alignSafeUntil) textAnchor = ta;
      }
    } catch {
      /* ignore */
    }
    const byText = locateWordByText(
      locator,
      hit.word,
      textAnchor >= 0 ? textAnchor : undefined,
      px,
      py,
    );
    if (byText) {
      // 2026-08-12 不再 GEO-REJECT:byText 已过词边界验证(indexOf + 前后
      // isWordChar,杜绝 "a" 匹配进单词内),文本正确性有保障。此前几何确认
      // (aCenter 带 textLayer 偏差)拒绝 → 回退 A → A 已隐藏 → 不高亮。
      // 权衡:信任 byText 至少显示高亮(词对),远好于干脆不显示。
      const r0 = byText.rects[0];
      const atStr = r0
        ? ` at=(${r0[0].toFixed(1)},${r0[1].toFixed(1)})`
        : " at=none";
      return byText;
    }
    // 文本匹配也失败 → 词间空隙判定(窗口内无字符 → 非 gap → 回退 A)
    if (isInGap(locator, px, py)) {
      return { gap: true as const };
    }
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
