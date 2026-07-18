/**
 * PDF page text & coordinate cache for precise hover highlighting.
 *
 * Uses _primaryView._pdfPages[i].chars (Zotero 8/9 synchronous per-page data)
 * for per-character PDF-space bounding boxes. Converts to CSS via
 * PDFViewerApplication.pdfViewer._pages[i].viewport.convertToViewportPoint().
 *
 * Same architectural approach as zotero-ai-sidebar.
 */

export interface CharAnchor {
  char: string;
  x: number;
  y: number;
  w: number;
  h: number;
  textOffset: number;
}

export interface PdfRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PageTextBundle {
  text: string;
  anchors: CharAnchor[];
  pageIndex: number;
}

/* ---------- helpers ---------- */

function numberValue(v: unknown): number | undefined {
  if (typeof v !== "number") return undefined;
  return Number.isFinite(v) ? v : undefined;
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\uFB00-\uFB06]/g, (m) => {
      const MAP: Record<string, string> = {
        "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl",
        "\uFB03": "ffi", "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st",
      };
      return MAP[m] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- cache ---------- */

const pageCache = new Map<number, PageTextBundle>();

export function clearPageDataCache() { pageCache.clear(); }
export function getPageData(pageIndex: number): PageTextBundle | null {
  return pageCache.get(pageIndex) ?? null;
}

/* ---------- load page data ---------- */

export function loadPageDataSync(reader: any, pageIndex: number): PageTextBundle | null {
  if (pageCache.has(pageIndex)) return pageCache.get(pageIndex)!;

  try {
    // Access _pdfPages dict on the primary view
    const pv = reader?._internalReader?._primaryView;
    const pages = pv?._pdfPages;
    const page = pages?.[pageIndex] ?? pages?.[String(pageIndex)];
    if (!page?.chars?.length) return null;

    const chars: CharAnchor[] = [];
    let textOffset = 0;
    for (const ch of page.chars) {
      const c: string = ch.c ?? "";
      if (!c) { textOffset++; continue; }
      const rect = ch.inlineRect ?? ch.rect;
      if (!rect || rect.length < 4) { textOffset++; continue; }
      const x = numberValue(rect[0]) ?? 0;
      const y = numberValue(rect[1]) ?? 0;
      const w = numberValue(rect[2]) ? (rect[2] as number) - x : 0;
      const h = numberValue(rect[3]) ? (rect[3] as number) - y : 0;
      if (w <= 0 || h <= 0) { textOffset++; continue; }
      chars.push({ char: c, x, y, w, h, textOffset });
      textOffset++;
    }
    if (chars.length === 0) return null;

    const text = normalizeText(chars.map((ch) => ch.char).join(""));
    const bundle: PageTextBundle = { text, anchors: chars, pageIndex };
    pageCache.set(pageIndex, bundle);
    return bundle;
  } catch {
    return null;
  }
}

/* ---------- word matching ---------- */

export function findWordRects(word: string, bundle: PageTextBundle): PdfRect[] {
  const normWord = normalizeText(word);
  const idx = bundle.text.indexOf(normWord);
  if (idx < 0) return [];

  const endIdx = idx + normWord.length;
  const matched = bundle.anchors.filter(
    (a) => a.textOffset >= idx && a.textOffset < endIdx,
  );
  if (matched.length === 0) return [];

  // Group by row (Y within 2 PDF units)
  const rows: CharAnchor[][] = [];
  for (const a of matched) {
    const last = rows[rows.length - 1];
    if (last?.length && Math.abs(a.y - last[0].y) < 2) {
      last.push(a);
    } else {
      rows.push([a]);
    }
  }

  const rects: PdfRect[] = [];
  for (const row of rows) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const a of row) {
      if (a.x < x0) x0 = a.x;
      if (a.y < y0) y0 = a.y;
      if (a.x + a.w > x1) x1 = a.x + a.w;
      if (a.y + a.h > y1) y1 = a.y + a.h;
    }
    rects.push({ x0, y0, x1, y1 });
  }
  return rects;
}

/* ---------- viewport conversion ---------- */

function getPageViewport(
  innerWin: Window,
  pageIndex: number,
): { convertToViewportPoint: (x: number, y: number) => [number, number] } | null {
  try {
    const win = (innerWin as any).wrappedJSObject ?? innerWin;
    const app = win.PDFViewerApplication;
    const pageView = app?.pdfViewer?._pages?.[pageIndex];
    const vp = pageView?.viewport;
    return typeof vp?.convertToViewportPoint === "function" ? vp : null;
  } catch {
    return null;
  }
}

export function pdfRectsToCssRects(
  rects: PdfRect[],
  bundle: PageTextBundle,
  pageEl: HTMLElement,
  innerWin: Window,
): CssRect[] {
  const viewport = getPageViewport(innerWin, bundle.pageIndex);
  const pageRect = pageEl.getBoundingClientRect();
  const out: CssRect[] = [];

  if (viewport) {
    // Path 1: pdf.js viewport — pixel-perfect alignment with canvas
    for (const r of rects) {
      try {
        const [vx1, vy2] = viewport.convertToViewportPoint(r.x0, r.y0);
        const [vx2, vy1] = viewport.convertToViewportPoint(r.x1, r.y1);
        out.push({
          left: Math.min(vx1, vx2) - pageRect.left,
          top: Math.min(vy1, vy2) - pageRect.top,
          width: Math.max(1, Math.abs(vx2 - vx1)),
          height: Math.max(1, Math.abs(vy2 - vy1)),
        });
      } catch { /* ignore */ }
    }
    return out;
  }

  // Path 2: fallback via pageEl viewBox ratio (used when viewport unavailable)
  const svg = pageEl.querySelector("svg");
  const vb = (svg?.getAttribute("viewBox") ?? "").split(/\s+/).map(Number);
  const x0 = vb[0] ?? 0, y0 = vb[1] ?? 0;
  const vw = vb[2] ?? (pageRect.width || 1), vh = vb[3] ?? (pageRect.height || 1);
  const w = Math.max(1, vw - x0), h = Math.max(1, vh - y0);

  for (const r of rects) {
    out.push({
      left: ((r.x0 - x0) / w) * pageRect.width,
      top: ((vh - r.y1) / h) * pageRect.height,
      width: Math.max(1, ((r.x1 - r.x0) / w) * pageRect.width),
      height: Math.max(1, ((r.y1 - r.y0) / h) * pageRect.height),
    });
  }
  return out;
}
