/**
 * page-bundle.ts —— 页面数据模型（重构核心，单流构建）。
 *
 * 只基于官方 getPageData chars 构建：
 *  - pageText：官方 getTextFromChars 语义（跳过 ignorable，空格由标志展开）
 *  - normalizedText + normalizedToOriginal：匹配用（-\n 连字符特判）
 *  - anchors：非 ignorable 字符渲染锚点（inlineRect 优先）
 *  - words：官方 wordBreakAfter 切词的预分词表（坐标→词 O(W)）
 *
 * 彻底废除旧版 textLayer↔chars 两流计数对齐（seqToPage/alignSafeUntil 等）。
 */

import type {
  CharAnchor,
  PageBundle,
  PdfRect,
  WordChar,
  WordSpan,
} from "./types";
import { fetchPageDataCompact, rawCharToWordChar } from "./pdf-access";

/**
 * 每 reader × 每窗口 × 每页缓存（v0.3.5 加固）：
 *   reader → innerWin → { pageIndex → Promise<PageBundle | null> }
 * 双层 key 防御「同 reader 换文档」：文档替换若重建 viewer iframe，
 * innerWin 变化 → 自动落到新缓存；配合 hoverTranslate 的 documentinit
 * 事件清理，双保险覆盖窗口不变的场景。
 */
const pageBundleCache = new WeakMap<
  object,
  Map<Window, Map<number, Promise<PageBundle | null>>>
>();

/** 拉取一页单流数据（官方 getPageData，惰性 + 每 reader 每窗口每页缓存）。 */
export function getPageBundle(
  reader: object,
  innerWin: Window,
  pageIndex: number,
): Promise<PageBundle | null> {
  let winMap = pageBundleCache.get(reader);
  if (!winMap) {
    winMap = new Map();
    pageBundleCache.set(reader, winMap);
  }
  let pageMap = winMap.get(innerWin);
  if (!pageMap) {
    pageMap = new Map();
    winMap.set(innerWin, pageMap);
  }
  if (pageMap.has(pageIndex)) return pageMap.get(pageIndex)!;

  const promise = (async (): Promise<PageBundle | null> => {
    try {
      const compact = await fetchPageDataCompact(innerWin, pageIndex);
      if (!compact || !compact.chars?.length) return null;
      const wordChars: WordChar[] = [];
      compact.chars.forEach((raw, i) => {
        const ch = rawCharToWordChar(raw, i);
        if (ch) wordChars.push(ch);
      });
      return buildPageBundle(
        pageIndex,
        wordChars,
        compact.viewBox && compact.viewBox.length >= 4
          ? [compact.viewBox[0], compact.viewBox[1], compact.viewBox[2], compact.viewBox[3]]
          : null,
      );
    } catch (e) {
      logBundle(`getPageBundle error: ${String((e as any)?.message || e)}`);
      return null;
    }
  })();

  pageMap.set(pageIndex, promise);
  return promise;
}

/** 清除某 reader 的页缓存（文档切换/重建/关闭时调用）。 */
export function clearPageBundleCache(reader: object): void {
  pageBundleCache.delete(reader);
}

function logBundle(msg: string): void {
  try {
    (globalThis as any).Zotero?.debug?.(`[hte-loc] ${msg}`);
  } catch {
    /* ignore */
  }
}

/** 常见拉丁连字（textLayer 与 chars 流可能以单码位输出）。 */
const LIGATURES: Record<string, string> = {
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
};

/** 归一化 + 偏移回映（移植自 sentence-translator pdf-locator.normalizeWithMap）。 */
export function normalizeWithMap(input: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpaceOffset: number | null = null;
  let index = 0;

  const pushSpace = () => {
    if (pendingSpaceOffset == null) return;
    if (chars.length > 0 && chars[chars.length - 1] !== " ") {
      chars.push(" ");
      map.push(pendingSpaceOffset);
    }
    pendingSpaceOffset = null;
  };

  while (index < input.length) {
    const hyphenBreakEnd = hyphenBreakEndAt(input, index);
    if (hyphenBreakEnd > index) {
      index = hyphenBreakEnd;
      continue;
    }

    const codePoint = input.codePointAt(index);
    if (codePoint == null) break;
    const rawChar = String.fromCodePoint(codePoint);
    const charLength = rawChar.length;

    if (isZeroWidth(rawChar)) {
      index += charLength;
      continue;
    }

    if (/\s/u.test(rawChar)) {
      if (pendingSpaceOffset == null) pendingSpaceOffset = index;
      index += charLength;
      continue;
    }

    pushSpace();
    for (const char of expandNormalizedChar(rawChar)) {
      if (/\s/u.test(char)) {
        if (pendingSpaceOffset == null) pendingSpaceOffset = index;
      } else {
        chars.push(char);
        map.push(index);
      }
    }
    index += charLength;
  }

  if (chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }

  return { text: chars.join(""), map };
}

function hyphenBreakEndAt(input: string, index: number): number {
  if (input[index] !== "-") return -1;
  let cursor = index + 1;
  while (cursor < input.length && isHorizontalSpace(input[cursor])) cursor++;
  const newlineEnd = newlineEndAt(input, cursor);
  if (newlineEnd < 0) return -1;
  cursor = newlineEnd;
  while (cursor < input.length && /\s/u.test(input[cursor])) cursor++;
  return cursor;
}

function newlineEndAt(input: string, index: number): number {
  if (input[index] === "\r" && input[index + 1] === "\n") return index + 2;
  if (input[index] === "\r" || input[index] === "\n") return index + 1;
  return -1;
}

function isHorizontalSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\f" || char === "\v";
}

function expandNormalizedChar(char: string): string[] {
  const expanded = LIGATURES[char] ?? char.normalize("NFKC");
  const lower = expanded.toLowerCase();
  const output: string[] = [];
  for (const normalizedChar of Array.from(lower)) {
    output.push(...Array.from(LIGATURES[normalizedChar] ?? normalizedChar));
  }
  return output;
}

function isZeroWidth(char: string): boolean {
  return (
    char === "\u200b" ||
    char === "\u200c" ||
    char === "\u200d" ||
    char === "\ufeff"
  );
}

/** 页内单词的规范化文本（用于与 A 通道取词比较）。 */
export function normalizeWord(word: string): string {
  return expandNormalizedChar(word).join("").toLowerCase();
}

/**
 * 从 RawChar 数组构建单流 PageBundle。
 * 失败（无 chars / 无有效 anchor）返回 null。
 */
export function buildPageBundle(
  pageIndex: number,
  rawChars: WordChar[],
  viewBox: PdfRect | null,
): PageBundle | null {
  if (!rawChars.length) return null;

  // 按 offset 排序（官方已有序，防御性排序）
  const chars = rawChars
    .slice()
    .sort((a, b) => a.offset - b.offset)
    .filter((ch) => typeof ch.c === "string" && ch.c.length > 0);

  if (!chars.length) return null;

  let pageText = "";
  const anchors: CharAnchor[] = [];
  const charsByOffset = new Map<number, WordChar>();
  for (const ch of chars) charsByOffset.set(ch.offset, ch);

  chars.forEach((char) => {
    if (char.ignorable) return;
    const start = pageText.length;
    pageText += char.c;
    const end = start + char.c.length;
    const rect = char.inlineRect ?? char.rect;
    anchors.push({
      charIndex: char.offset,
      startOffset: start,
      endOffset: end,
      x: rect[0],
      y: rect[1],
      width: Math.max(0, rect[2] - rect[0]),
      height: Math.max(0, rect[3] - rect[1]),
      lineBreakAfter: !!char.lineBreakAfter,
      paragraphBreakAfter: !!char.paragraphBreakAfter,
      wordBreakAfter: !!char.wordBreakAfter,
    });
    if (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) {
      pageText += " ";
    }
  });

  if (!pageText || anchors.length === 0) return null;

  const normalized = normalizeWithMap(pageText);
  const words = buildWordSpans(anchors, pageText);

  return {
    pageIndex,
    chars,
    viewBox,
    pageText,
    normalizedText: normalized.text,
    normalizedToOriginal: normalized.map,
    anchors,
    words,
  };
}

/** 按官方 wordBreakAfter 切词（getClosestWord 的词表）。 */
function buildWordSpans(anchors: CharAnchor[], pageText: string): WordSpan[] {
  const words: WordSpan[] = [];
  let start = 0;
  const pushWord = (end: number) => {
    const wordAnchors = anchors.slice(start, end + 1);
    if (wordAnchors.length) {
      words.push({
        startAnchor: start,
        endAnchor: end,
        text: wordAnchors
          .map((a) => pageText.slice(a.startOffset, a.endOffset))
          .join(""),
        rect: unionRects(wordAnchors.map(fullAnchorRect)),
      });
    }
    start = end + 1;
  };
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].wordBreakAfter) pushWord(i);
  }
  if (start < anchors.length) pushWord(anchors.length - 1);
  return words;
}

/**
 * 官方 getClosestWord 语义复刻（reader.js）：以 wordBreakAfter 切词，
 * 取与 rect（PDF 坐标）距离最近的词。
 */
export function getClosestWord(bundle: PageBundle, rect: PdfRect): WordSpan | null {
  let best: WordSpan | null = null;
  let bestDistance = Infinity;
  for (const word of bundle.words) {
    const distance = rectsDist(rect, word.rect);
    if (distance < bestDistance) {
      best = word;
      bestDistance = distance;
    }
  }
  return best;
}

/** 取 anchorIndex 所在词（wordBreakAfter 边界）。 */
export function wordContainingAnchor(bundle: PageBundle, anchorIndex: number): WordSpan | null {
  const words = bundle.words;
  // words 有序，二分或线性
  for (const word of words) {
    if (anchorIndex >= word.startAnchor && anchorIndex <= word.endAnchor) return word;
  }
  return null;
}

/** 前后 n 词的上下文文本（不含当前词）。返回 [prevN..prev1, next1..nextN] 拼合。 */
export function contextAroundWord(
  bundle: PageBundle,
  word: WordSpan,
  n: number,
): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  const idx = bundle.words.indexOf(word);
  if (idx >= 0) {
    for (let i = 1; i <= n; i++) {
      const prev = bundle.words[idx - i];
      if (prev) before.unshift(prev.text);
      else break;
    }
    for (let i = 1; i <= n; i++) {
      const next = bundle.words[idx + i];
      if (next) after.push(next.text);
      else break;
    }
  }
  return {
    before: before.join(" ").toLowerCase(),
    after: after.join(" ").toLowerCase(),
  };
}

/** 按 PDF 坐标取最近 anchor。 */
export function closestAnchorIndex(bundle: PageBundle, point: { x: number; y: number }): number | null {
  let bestIndex: number | null = null;
  let bestDistance = Infinity;
  const pointRect: PdfRect = [point.x, point.y, point.x, point.y];
  bundle.anchors.forEach((anchor, index) => {
    const distance = rectsDist(fullAnchorRect(anchor), pointRect);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });
  return bestIndex;
}

/** anchor 完整 rect（inlineRect 已含行高）。 */
export function fullAnchorRect(anchor: CharAnchor): PdfRect {
  return [anchor.x, anchor.y, anchor.x + anchor.width, anchor.y + anchor.height];
}

/** 合并 anchor 范围为多块 PDF rect（按行分组 + 行内合并）。 */
export function rectsForAnchors(
  bundle: PageBundle,
  startAnchor: number,
  endAnchor: number,
): PdfRect[] {
  const parts: Array<{ rect: PdfRect; index: number }> = [];
  for (let i = startAnchor; i <= endAnchor; i++) {
    const anchor = bundle.anchors[i];
    if (anchor) parts.push({ rect: fullAnchorRect(anchor), index: i });
  }
  if (!parts.length) return [];
  return mergeRectParts(parts);
}

interface RectPart {
  rect: PdfRect;
  index: number;
}

function mergeRectParts(parts: RectPart[]): PdfRect[] {
  const LINE_Y_TOLERANCE = 2;
  const rows: Array<{ y: number; parts: RectPart[] }> = [];
  const sorted = parts
    .slice()
    .sort(
      (a, b) =>
        rectMidY(b.rect) - rectMidY(a.rect) ||
        a.rect[0] - b.rect[0] ||
        a.index - b.index,
    );
  for (const part of sorted) {
    const y = rectMidY(part.rect);
    const row = rows.find((candidate) => Math.abs(candidate.y - y) <= LINE_Y_TOLERANCE);
    if (row) row.parts.push(part);
    else rows.push({ y, parts: [part] });
  }

  const rects: PdfRect[] = [];
  for (const row of rows) {
    const rowParts = row.parts.slice().sort((a, b) => a.rect[0] - b.rect[0] || a.index - b.index);
    let current: PdfRect | null = null;
    for (const part of rowParts) {
      if (current && shouldMergeInline(current, part.rect)) {
        current = unionRect(current, part.rect);
        continue;
      }
      if (current) rects.push(roundRect(current));
      current = part.rect;
    }
    if (current) rects.push(roundRect(current));
  }
  return rects;
}

function shouldMergeInline(left: PdfRect, right: PdfRect): boolean {
  const gap = right[0] - left[2];
  const height = Math.max(rectHeight(left), rectHeight(right), 1);
  return gap <= Math.max(2, height * 1.5);
}

function unionRects(rects: PdfRect[]): PdfRect {
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}

function unionRect(a: PdfRect, b: PdfRect): PdfRect {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

function rectMidY(rect: PdfRect): number {
  return (rect[1] + rect[3]) / 2;
}

function rectHeight(rect: PdfRect): number {
  return Math.abs(rect[3] - rect[1]);
}

function roundRect(rect: PdfRect): PdfRect {
  return rect.map((value) => Number(value.toFixed(3))) as PdfRect;
}

/** 两 rect 欧氏距离（分离时）。 */
export function rectsDist(a: PdfRect, b: PdfRect): number {
  const left = b[2] < a[0];
  const right = a[2] < b[0];
  const bottom = b[3] < a[1];
  const top = a[3] < b[1];

  if (top && left) return Math.hypot(a[0] - b[2], b[1] - a[3]);
  if (left && bottom) return Math.hypot(a[0] - b[2], a[1] - b[3]);
  if (bottom && right) return Math.hypot(a[2] - b[0], a[1] - b[3]);
  if (right && top) return Math.hypot(b[0] - a[2], b[1] - a[3]);
  if (left) return a[0] - b[2];
  if (right) return b[0] - a[2];
  if (bottom) return a[1] - b[3];
  if (top) return b[1] - a[3];
  return 0;
}
