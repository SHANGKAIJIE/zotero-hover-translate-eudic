import { config } from "../../package.json";

/**
 * Get all currently open reader instances.
 * Defensive: tries several Zotero reader access paths across versions.
 */
export function getAllReaders(): _ZoteroTypes.ReaderInstance[] {
  const R: any = (Zotero as any).Reader;
  if (!R) return [];
  if (typeof R.getReaders === "function") {
    try {
      return R.getReaders() || [];
    } catch {
      /* fall through */
    }
  }
  if (Array.isArray(R._readers)) {
    return R._readers;
  }
  return [];
}

/**
 * Get a reader instance by tab id (defensive).
 */
export function getReaderByTabID(
  tabID: string | number,
): _ZoteroTypes.ReaderInstance | undefined {
  const R: any = (Zotero as any).Reader;
  if (!R) return undefined;
  if (typeof R.getByTabID === "function") {
    try {
      return R.getByTabID(tabID);
    } catch {
      /* fall through */
    }
  }
  return getAllReaders().find(
    (r: any) => r.tabID === tabID || r._tabID === tabID,
  );
}

/**
 * Get the internal iframe window of a reader (the pdf.js viewer document).
 *
 * Zotero 7 reader instances expose `_iframeWindow` directly (the preferred,
 * ready-to-use inner Window). We fall back to `_iframe.contentWindow` for
 * older builds. See zotero-types `ReaderInstance`.
 */
export function getReaderInnerWindow(
  reader: _ZoteroTypes.ReaderInstance,
): Window | undefined {
  const r = reader as any;
  if (r._iframeWindow && r._iframeWindow.document) {
    return r._iframeWindow;
  }
  const iframe = r._iframe as HTMLIFrameElement | undefined;
  return iframe?.contentWindow || undefined;
}

/**
 * Build the chrome URL for an addon asset.
 */
export function getChromeURL(relPath: string): string {
  return `chrome://${config.addonRef}/content/${relPath}`;
}

/**
 * [v0.4.x P5] 直接从 Reader 实例读取阅读模式(SDT)视图的内部 iframe 窗口。
 *
 * Zotero 10 阅读模式 = SDTView,挂在 reader._primarySDTView /
 * _secondarySDTView(私有属性,阅读模式开启时非空),其 _iframeWindow 即
 * SDT iframe 的 contentWindow(加载 srcdoc 渲染的 #sdt-content HTML)。
 *
 * 这是 collectWindows(MutationObserver 链路)之外的第二条注册路径:
 * collectWindows 依赖「reader.html 顶层 document 能枚举到 SDT iframe」,
 * 若该链路在某版本/场景下失效,此处直接从 Reader 对象拿 iframe,不经过 DOM
 * 枚举。Zotero 9 无这些属性,返回空数组(天然兼容)。
 */
export function getSDTViewWindows(
  reader: _ZoteroTypes.ReaderInstance,
): Window[] {
  const out: Window[] = [];
  try {
    const r = reader as any;
    for (const view of [r._primarySDTView, r._secondarySDTView]) {
      try {
        const w: Window | undefined = view?._iframeWindow;
        if (w && w.document) out.push(w);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * [v0.4.x 阅读模式适配] SDT(阅读模式)DOM Range → PDF source 坐标。
 *
 * Zotero 10 SDTView 暴露官方映射通道 toSelector(range)（reader.js 内部
 * _rangeToSDTPosition → PDFPositionMapper.sdtToSourcePosition），返回
 * { pageIndex, rects [, nextPageRects] }，rects 为 PDF 用户坐标两点式
 * [x1,y1,x2,y2]，与注释 position.rects / zotero://open-pdf position 参数
 * 完全同源 —— 可直接用于：
 *  - AnnotationContext.pdfRects（「加入生词本时同步添加到注释」）
 *  - buildSourceLink({pageIndex, rects})（生词表 src 跳转链接）
 *
 * 匹配规则（2026-08-22 第三轮改为自验证）：不按 document 引用路由 ——
 * Debug Output 实测 collectWindows 枚举的 SDT iframe window 与
 * _primarySDTView._iframeWindow 是两个不同 Window 引用，严格比较必然失配。
 * 现对每个可用 SDTView 直接调用 toSelector(range)：异文档 range 在其内部
 * _domPositionToPoint 找不到 [data-text-index] → 安全返回 null；首个有效
 * 结果即为正确视图。Zotero 9 无这些属性，返回 null（天然兼容）。
 */
export function sdtRangeToSourcePosition(
  reader: _ZoteroTypes.ReaderInstance,
  range: Range,
): { pageIndex: number; rects: [number, number, number, number][] } | null {
  try {
    const r = reader as any;
    if (!r || !range) return null;
    const sc = range.startContainer as Node | null;
    if (!sc) return null;
    if (!sc.ownerDocument && sc.nodeType !== 9) return null;

    const views = [r._primarySDTView, r._secondarySDTView];
    for (const view of views) {
      try {
        if (!view || typeof view.toSelector !== "function") continue;
        const sel = view.toSelector(range);
        if (
          sel &&
          Number.isInteger(sel.pageIndex) &&
          sel.pageIndex >= 0 &&
          Array.isArray(sel.rects) &&
          sel.rects.length > 0
        ) {
          return { pageIndex: sel.pageIndex, rects: sel.rects };
        }
      } catch { /* 异文档 range 在该 view 内部定位失败 → 尝试下一个视图 */ }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * [v0.4.x] 读取 reader 当前页码（0-based），多路径防御。
 *
 * 用途：src 跳转链接的 page 兜底 —— SDT mapper(toSelector) 失败时，
 * 至少生成 `zotero://open-pdf/...?page=N` 定位到当前页，而不是无参数
 * 裸链接（点击只打开 PDF 不定位）。
 *
 * 路径说明：
 *  - Zotero 7-9：reader.state.pageIndex（实例属性）；
 *  - Zotero 10：实例上【没有】state.pageIndex（2026-08-22 实测确认，
 *    feature/describe 词条 src 连 page 都没有的根因之一），内部状态在
 *    _internalReader._state；再兜底隐藏存活的 pdf.js viewer iframe 的
 *    currentPageNumber（阅读模式下 PDF iframe 仅 visibility:hidden，
 *    页码状态保持）。
 */
export function getReaderCurrentPageIndex(
  reader: _ZoteroTypes.ReaderInstance,
): number | undefined {
  const r = reader as any;
  // 1) Zotero 7-9：reader.state.pageIndex
  try {
    const p = r?.state?.pageIndex;
    if (Number.isInteger(p) && p >= 0) return p;
  } catch { /* ignore */ }
  // 2) Zotero 10：_internalReader._state（结构跨版本可能变化，多字段探测）
  try {
    const st = r?._internalReader?._state;
    const candidates = [
      st?.primary?.pageIndex,
      st?.pageIndex,
      st?.primaryViewState?.pageIndex,
    ];
    for (const p of candidates) {
      if (Number.isInteger(p) && (p as number) >= 0) return p as number;
    }
  } catch { /* ignore */ }
  // 3) pdf.js viewer 当前页（1-based → 转 0-based）
  const wins = [
    r?._internalReader?._primaryView?._iframeWindow,
    r?._internalReader?._iframeWindow,
    r?._iframeWindow,
  ];
  for (const w of wins) {
    try {
      const app =
        w?.PDFViewerApplication || w?.wrappedJSObject?.PDFViewerApplication;
      const n = app?.pdfViewer?.currentPageNumber;
      if (Number.isInteger(n) && n >= 1) return n - 1;
      const c = app?.pdfViewer?._currentPage;
      if (Number.isInteger(c) && c >= 1) return c - 1;
    } catch { /* ignore */ }
  }
  return undefined;
}
