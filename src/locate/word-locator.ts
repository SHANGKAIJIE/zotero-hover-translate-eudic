/**
 * word-locator.ts —— 单词定位（Phase 2，对外主入口）。
 *
 * 定位管线（单流数据，无 textLayer↔chars 两流对齐）：
 *  1. A 通道 range 推导真实悬停页（findPageIndexFromRange）；
 *  2. 鼠标坐标 → PDF 坐标（viewBox 比例主 / convertToPdfPoint 兜底）；
 *  3. 句子定位（过渡锚点）：sentenceAtPoint 把候选空间缩窄到句内 words；
 *  4. 单词定位（句内三重消歧）：
 *     ① 官方 wordBreakAfter 词边界内 normalizeWord 文本匹配；
 *     ② 前后 2 词上下文指纹（A 侧 DOM vs C 侧 chars 流）——唯一 → 锁定；
 *     ③ 鼠标坐标距离（rect 中心）——多候选时取最近；
 *     （外加行归属校验兜底：候选中心与鼠标 Y 差 ≤ 1.8×行高）
 *  5. 零文本候选（A 词与 chars 流不一致：ignorable/连字/拼写）→ 官方
 *     getClosestWord 语义取最近词 + 词相似度宽松校验。
 */

import type {
  LocatedWord,
  PageBundle,
  PdfRect,
  WordSpan,
} from "./types";
import {
  contextAroundWord,
  fullAnchorRect,
  getClosestWord,
  getPageBundle,
  normalizeWord,
  rectsDist,
  rectsForAnchors,
} from "./page-bundle";
import { sentenceAtPoint } from "./sentence-locator";

export type { LocatedWord } from "./types";

export interface LocateWordInput {
  /** reader 实例（页缓存 key）。 */
  reader: object;
  /** 事件窗口（reader.html），用于 XPC 桥接与 DOM 查询。 */
  innerWin: Window;
  /** A 通道取词文本。 */
  word: string;
  /** A 通道 range（真实页推导 + A 侧上下文词）。 */
  range: Range;
  /** 鼠标坐标（iframe viewport 系）。 */
  mouseX?: number;
  mouseY?: number;
}

/** 定位结果：命中词 / 词间隙（词间空白处）/ 失败。 */
export type LocateResult = LocatedWord | null | { gap: true };

/** 上下文指纹（A 侧 DOM 提取）。 */
interface DomContext {
  prev2: string;
  prev1: string;
  curr: string;
  next1: string;
  next2: string;
}

/**
 * 单词定位主入口。返回：
 *  - LocatedWord：命中；
 *  - { gap: true }：鼠标在词间空白处（不高亮、不显示弹窗）；
 *  - null：定位失败（调用方走既有兜底）。
 */
export async function locateWord(
  input: LocateWordInput,
): Promise<LocateResult> {
  const { reader, innerWin, word, range, mouseX, mouseY } = input;
  try {
    // 1. 真实悬停页（range 推导，非焦点页）
    const pageIndex = findPageIndexFromRange(range);
    if (pageIndex < 0) {
      logLocate(`locateWord: no page from range`);
      return null;
    }

    // 2. 单流页面数据
    const bundle = await getPageBundle(reader, innerWin, pageIndex);
    if (!bundle) {
      logLocate(`locateWord: no bundle page ${pageIndex}`);
      return null;
    }

    // 3. 鼠标 → PDF 坐标
    let px: number | undefined;
    let py: number | undefined;
    if (typeof mouseX === "number" && typeof mouseY === "number") {
      const pt = clientPointToPdfPoint(innerWin, pageIndex, mouseX, mouseY, bundle);
      if (pt) {
        px = pt.x;
        py = pt.y;
      }
    }

    // 4+5. 句子过渡锚点 + 句内单词消歧
    const located = locateWordOnPage(bundle, word, range, innerWin, px, py);
    if (located) {
      return located;
    }

    // 6. 词间隙判定（有坐标且落在字符空隙 → gap，调用方清除高亮）
    if (px !== undefined && py !== undefined && isInGap(bundle, px, py)) {
      return { gap: true };
    }
    return null;
  } catch (e) {
    logLocate(`locateWord error: ${String((e as any)?.message || e)}`);
    return null;
  }
}

/**
 * 页面级单词定位：句子内三重消歧。
 */
export function locateWordOnPage(
  bundle: PageBundle,
  hitWord: string,
  range: Range,
  innerWin: Window,
  px?: number,
  py?: number,
): LocatedWord | null {
  const normHit = normalizeWord(hitWord);
  if (!normHit) return null;

  // 候选空间：句内 words（坐标可用时）；坐标不可用退化为全页。
  let sentence = null as { words: WordSpan[] } | null;
  if (px !== undefined && py !== undefined) {
    sentence = sentenceAtPoint(bundle, { x: px, y: py });
  }
  const space = sentence?.words?.length ? sentence.words : bundle.words;
  if (!space.length) return null;

  // ① 官方词边界内文本匹配。
  // A 通道取词只含连续字母段（"prior-based" → "prior"），而 C 通道
  // wordBreakAfter 把连字符词切为整词（"prior-based"）。因此候选匹配
  // 支持「hitWord 是候选词的连字符段之一」。
  const hitSegments = wordSegments(hitWord);
  let candidates = space.filter((w) => {
    if (normalizeWord(w.text) === normHit) return true;
    return wordSegments(w.text).some((seg) => hitSegments.includes(seg));
  });

  if (candidates.length === 1) {
    return toLocated(bundle, candidates[0], px);
  }

  // ② 多候选 → 上下文指纹（A 侧 DOM 前2后2 vs C 侧 chars 流）
  if (candidates.length > 1) {
    const aCtx = wordsAroundRange(innerWin, range);
    if (aCtx && cleanCtx(aCtx.curr) === normHit) {
      const matched = candidates.filter((w) => {
        const cCtx = contextAroundWord(bundle, w, 2);
        return (
          cleanCtx(cCtx.before) === cleanCtx(`${aCtx.prev2} ${aCtx.prev1}`) &&
          cleanCtx(cCtx.after) === cleanCtx(`${aCtx.next1} ${aCtx.next2}`)
        );
      });
      if (matched.length === 1) return toLocated(bundle, matched[0], px);
      if (matched.length > 1) candidates = matched; // 指纹缩窄后仍多 → 坐标裁决
    }
  }

  // ③ 多候选 → 鼠标坐标距离（rect 中心 vs 鼠标）
  if (candidates.length > 1 && px !== undefined && py !== undefined) {
    let best: WordSpan | null = null;
    let bestDist = Infinity;
    for (const w of candidates) {
      const d = rectsDist(w.rect, [px, py, px, py]);
      if (d < bestDist) {
        bestDist = d;
        best = w;
      }
    }
    if (best) {
      // 行归属校验兜底：候选中心与鼠标 Y 严重不符（不同行）→ 拒绝
      if (typeof py === "number" && typeof best === "object") {
        const cy = (best.rect[1] + best.rect[3]) / 2;
        const rowThr = Math.max(16, (best.rect[3] - best.rect[1]) * 1.8);
        if (Math.abs(py - cy) > rowThr) {
          return null;
        }
      }
      return toLocated(bundle, best, px);
    }
  }

  // ④ 零文本候选（A 词与 chars 流不一致）→ 官方 getClosestWord + 词相似度
  if (px !== undefined && py !== undefined) {
    const closest = getClosestWord(bundle, [px, py, px, py]);
    if (closest && wordSimilarEnough(normHit, normalizeWord(closest.text))) {
      return toLocated(bundle, closest, px);
    }
  }

  return null;
}

/** 构造对外 LocatedWord。
 *  px 可用且候选词为复合词（含分隔符）时，按鼠标 X 位置拆分到所属段
 *  （"geometry-limited" 指向 geometry 段 → 只高亮 geometry）——
 *  翻译仍用 A 通道原始词，不受影响。 */
function toLocated(
  bundle: PageBundle,
  word: WordSpan,
  px?: number,
): LocatedWord {
  const seg = pickSegment(bundle, word, px);
  const startAnchor = seg?.startAnchor ?? word.startAnchor;
  const endAnchor = seg?.endAnchor ?? word.endAnchor;
  const rects = rectsForAnchors(bundle, startAnchor, endAnchor);
  const chars = bundle.chars.filter(
    (ch) =>
      ch.offset >= bundle.anchors[startAnchor]?.charIndex &&
      ch.offset <= bundle.anchors[endAnchor]?.charIndex,
  );
  return {
    word: seg ? chars.map((c) => c.c).join("") : word.text,
    rects,
    chars,
    bundle,
  };
}

/** 复合词按鼠标 X 选段。非复合词（≤1 段）或 px 不可用返回 null（整词）。
 *  段边界 = 非字母字符（- + / 等分隔符）；鼠标落在分隔符上时取最近段。 */
function pickSegment(
  bundle: PageBundle,
  word: WordSpan,
  px?: number,
): { startAnchor: number; endAnchor: number } | null {
  if (px === undefined) return null;
  const anchors = bundle.anchors;
  // 词内 anchor 按字母段分组（分隔符字符为切分点）
  const segments: Array<Array<{ index: number; char: string }>> = [];
  let current: Array<{ index: number; char: string }> = [];
  const flush = () => {
    if (current.length) {
      segments.push(current);
      current = [];
    }
  };
  for (let i = word.startAnchor; i <= word.endAnchor; i++) {
    const anchor = anchors[i];
    if (!anchor) break;
    const ch = bundle.chars[anchor.charIndex];
    const c = ch?.c ?? "";
    if (/[A-Za-z0-9\u00C0-\u024F]/.test(c)) {
      current.push({ index: i, char: c });
    } else {
      flush();
    }
  }
  flush();
  if (segments.length <= 1) return null; // 非复合词 → 整词

  // 选 px 所在段（X 覆盖；否则取最近段）
  let best: Array<{ index: number; char: string }> | null = null;
  let bestDist = Infinity;
  for (const seg of segments) {
    const xs = seg.map((s) => anchors[s.index]);
    const x0 = Math.min(...xs.map((a) => a.x));
    const x1 = Math.max(...xs.map((a) => a.x + a.width));
    if (px >= x0 && px <= x1) {
      return {
        startAnchor: seg[0].index,
        endAnchor: seg[seg.length - 1].index,
      };
    }
    const dist = px < x0 ? x0 - px : px - x1;
    if (dist < bestDist) {
      bestDist = dist;
      best = seg;
    }
  }
  if (!best) return null;
  return {
    startAnchor: best[0].index,
    endAnchor: best[best.length - 1].index,
  };
}

/** 词相似度宽松校验（前缀或编辑距离 ≤ 30%）。 */
function wordSimilarEnough(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) {
    return true;
  }
  const dist = levenshtein(a, b);
  return dist <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.3));
}

function levenshtein(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + cost,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/** 从 A 通道 range 的 DOM 文本提取上下文（前2后2词，小写规范化）。 */
function wordsAroundRange(
  innerWin: Window,
  range: Range,
): DomContext | null {
  try {
    const node = range.startContainer;
    if (!node || node.nodeType !== 3) return null;
    const text = (node as Text).data || "";
    let cs = Math.min(Math.max(0, range.startOffset), text.length);
    let ce = cs;
    while (cs > 0 && isWordChar(text[cs - 1])) cs--;
    while (ce < text.length && isWordChar(text[ce])) ce++;
    const curr = text.slice(cs, ce).toLowerCase();
    if (!curr) return null;

    let beforeText = text.slice(0, cs);
    let el = (node as Text).parentElement;
    let prev = el?.previousElementSibling;
    while (prev && beforeText.length < 200) {
      beforeText =
        (prev.textContent || "").replace(/[ \t]+$/, "") + " " + beforeText;
      prev = prev.previousElementSibling;
    }
    let afterText = text.slice(ce);
    let next = el?.nextElementSibling;
    while (next && afterText.length < 200) {
      afterText += " " + (next.textContent || "").replace(/^[ \t]+/, "");
      next = next.nextElementSibling;
    }

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

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9\u00C0-\u024F]/.test(ch);
}

/** 上下文词规范化：去标点/大小写。 */
function cleanCtx(s: string): string {
  return (s || "").toLowerCase().replace(/[^A-Za-z\u00C0-\u024F]/g, "");
}

/** 按非字母分隔符切段（"prior-based" → ["prior","based"]）。 */
function wordSegments(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z\u00C0-\u024F]+/)
    .filter((seg) => seg.length > 0);
}

/**
 * 从 A 通道 range 推导鼠标实际所在页（0-based）。
 * range.startContainer 位于鼠标命中的 textLayer 节点，向上找 .page。
 */
function findPageIndexFromRange(range: Range): number {
  try {
    let el: HTMLElement | null =
      (range.startContainer?.parentElement as HTMLElement | null) ?? null;
    while (el) {
      if (
        typeof el.matches === "function" &&
        el.matches(".page[data-page-number]")
      ) {
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
 * 鼠标视口坐标 → PDF 用户坐标。
 * 主路径：viewBox 比例映射（pageEl 渲染尺寸 ↔ viewBox 线性映射，天然包含
 * 全部 CSS transform，与高亮渲染同基准，无 convertToPdfPoint 左偏问题）。
 * 兜底：viewport.convertToPdfPoint。
 */
export function clientPointToPdfPoint(
  innerWin: Window,
  pageIndex: number,
  clientX: number,
  clientY: number,
  bundle: PageBundle,
): { x: number; y: number } | null {
  try {
    const doc = innerWin.document;
    const pageEl = doc.querySelector(
      `.page[data-page-number="${pageIndex + 1}"]`,
    ) as HTMLElement | null;
    if (!pageEl) return null;
    const pr = pageEl.getBoundingClientRect();
    if (!pr || pr.width <= 0 || pr.height <= 0) return null;
    const relX = clientX - pr.left;
    const relY = clientY - pr.top;

    const vb = bundle.viewBox;
    if (vb && vb[2] > vb[0] && vb[3] > vb[1]) {
      const px = vb[0] + (relX / pr.width) * (vb[2] - vb[0]);
      const py = vb[3] - (relY / pr.height) * (vb[3] - vb[1]);
      return { x: px, y: py };
    }

    // 兜底：pdf.js viewport 换算
    const app = (innerWin as any).wrappedJSObject?.PDFViewerApplication
      ?? (innerWin as any).PDFViewerApplication;
    const viewport = app?.pdfViewer?._pages?.[pageIndex]?.viewport;
    if (viewport?.convertToPdfPoint) {
      const [px, py] = viewport.convertToPdfPoint(relX, relY);
      if (Number.isFinite(px) && Number.isFinite(py)) return { x: px, y: py };
    }
    return null;
  } catch {
    return null;
  }
}

function logLocate(msg: string): void {
  try {
    (globalThis as any).Zotero?.debug?.(`[hte-loc] ${msg}`);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * 渲染辅助（视口坐标换算 / 弹窗锚定）—— 供 hoverTranslate 渲染层使用。
 * ------------------------------------------------------------------ */

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * PDF rects → page 局部视口坐标（挂 pageEl position:absolute 直接使用）。
 * 主路径：pdf.js viewport.convertToViewportPoint（与 canvas 像素对齐）；
 * 兜底：viewBox 比例映射（pageEl 渲染尺寸）。
 */
export function pdfRectsToViewport(
  innerWin: Window,
  bundle: PageBundle,
  rects: PdfRect[],
): { rects: ViewportRect[]; pageEl: HTMLElement | null } {
  const out: ViewportRect[] = [];
  let pageEl: HTMLElement | null = null;

  try {
    const app = (innerWin as any).wrappedJSObject?.PDFViewerApplication
      ?? (innerWin as any).PDFViewerApplication;
    const page = app?.pdfViewer?._pages?.[bundle.pageIndex];
    const viewport = page?.viewport;
    pageEl = page?.div ?? null;
    if (viewport?.convertToViewportPoint) {
      for (const r of rects) {
        const [x1, y2] = viewport.convertToViewportPoint(r[0], r[1]);
        const [x2, y1] = viewport.convertToViewportPoint(r[2], r[3]);
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.max(1, Math.abs(x2 - x1));
        const height = Math.max(1, Math.abs(y2 - y1));
        if (
          isFinite(left) && isFinite(top) && isFinite(width) && isFinite(height)
        ) {
          out.push({ left, top, width, height });
        }
      }
      if (out.length) return { rects: out, pageEl };
    }
  } catch {
    /* fall through */
  }

  try {
    if (!pageEl) {
      const app = (innerWin as any).wrappedJSObject?.PDFViewerApplication
        ?? (innerWin as any).PDFViewerApplication;
      pageEl = app?.pdfViewer?._pages?.[bundle.pageIndex]?.div ?? null;
    }
    const pr = pageEl?.getBoundingClientRect?.();
    const vb = bundle.viewBox;
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
 * 命中词包围盒（视口坐标，弹窗锚定用）。
 * 跨行词（行尾断词 obscurer → ob 一块 + scurer 一块）时,若提供 mouseY,
 * 选鼠标所在的那一块作为锚点——弹窗贴近鼠标指向的行,而非两行的并集
 * （并集会弹窗悬在两行中间/距词过远）。无 mouseY 或单块时退化为并集。
 * 返回 null 表示无可用几何。
 */
export function wordAnchorFromLocated(
  innerWin: Window,
  located: LocatedWord,
  mouseY?: number,
): { x: number; top: number; bottom: number } | null {
  const { rects: vp, pageEl } = pdfRectsToViewport(
    innerWin,
    located.bundle,
    located.rects,
  );
  if (!vp.length) return null;
  let offX = 0;
  let offY = 0;
  try {
    const pr = pageEl?.getBoundingClientRect?.();
    if (pr) {
      offX = pr.left;
      offY = pr.top;
    }
  } catch {
    /* ignore */
  }
  // 跨行多块：按鼠标 Y 选最近块（视口坐标比较）
  let chosen = vp;
  if (vp.length > 1 && typeof mouseY === "number") {
    let best = null as typeof vp[0] | null;
    let bestDist = Infinity;
    for (const r of vp) {
      const midY = r.top + r.height / 2 + offY;
      const d = Math.abs(mouseY - midY);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    if (best) chosen = [best];
  }
  const x = Math.min(...chosen.map((r) => r.left)) + offX;
  const top = Math.min(...chosen.map((r) => r.top)) + offY;
  const bottom = Math.max(...chosen.map((r) => r.top + r.height)) + offY;
  return { x, top, bottom };
}

/** 判断命中点是否落在字符间隙（词间空白）。
 *  行锁定：只在命中点所在行（±1.2 字高窗口）内查找字符——邻行字符
 *  不得参与覆盖判定；行内无字符（行间隙/页边）→ 非 gap（保高亮）。 */
export function isInGap(
  bundle: PageBundle,
  px: number,
  py: number,
): boolean {
  const chars = bundle.chars;
  let foundAny = false;
  for (const ch of chars) {
    const r = ch.rect;
    const cy = (r[1] + r[3]) / 2;
    const fontSize = Math.max(1, ch.fontSize || (r[3] - r[1]));
    // 行窗口：半行裕量（同行字符中心差 ≤ ~0.6×fs；邻行间距 ~1.5-2×fs）
    if (Math.abs(cy - py) > fontSize * 1.2) continue;
    foundAny = true;
    const tol = Math.max(1, fontSize) * 0.25;
    if (px >= r[0] - tol && px <= r[2] + tol) return false;
  }
  if (!foundAny) return false;
  return true;
}
