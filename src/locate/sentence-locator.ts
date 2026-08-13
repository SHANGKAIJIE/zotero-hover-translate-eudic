/**
 * sentence-locator.ts —— 句子定位（Phase 1，过渡锚点）。
 *
 * 参考 sentence-translator 的段落级句子分割：以 lineBreakAfter 分行、
 * paragraphBreakAfter/缩进断段，段内再按句号/问号/叹号切句子。
 * 输出句子的 anchor 区间与 words 词表——单词定位的候选空间。
 *
 * 定位主路径：鼠标坐标 → PDF 坐标 → 最近 anchor → 所在句子（单流数据，
 * 无 textLayer 参与）。
 *
 * 性能：句子切分结果是 O(页文本) 计算，而 mousemove 高频路径每次命中都
 * 会调用 sentenceAtPoint。PageBundle 一经构建不可变（getPageBundle 惰性
 * 缓存，同 reader 同页同一 bundle 对象），因此切分结果可按
 * (bundle, splitOptionsKey) 缓存——WeakMap 随 bundle 一起被 GC 回收。
 */

import type { CharAnchor, PageBundle, PdfRect, WordSpan } from "./types";
import { closestAnchorIndex, rectsForAnchors } from "./page-bundle";
import { splitSentences, type SplitOptions } from "./sentence-splitter";

export interface LocatedSentence {
  text: string;
  rects: PdfRect[];
  startAnchor: number;
  endAnchor: number;
  words: WordSpan[];
}

export interface SentenceSegment {
  text: string;
  startAnchor: number;
  endAnchor: number;
}

/** 句子切分缓存：PageBundle → (splitOptionsKey → segments)。 */
const segmentsCache = new WeakMap<PageBundle, Map<string, SentenceSegment[]>>();

/** splitOptions 的缓存键（exceptions 顺序无关序列化）。 */
function splitOptionsKey(splitOptions?: SplitOptions): string {
  const exceptions = splitOptions?.exceptions;
  if (!Array.isArray(exceptions) || exceptions.length === 0) return "";
  return [...new Set(exceptions)].sort().join("\u0001");
}

/** 段落级句子分割（按 bundle + splitOptions 缓存，多次调用零重复计算）。 */
export function sentenceSegmentsForPage(
  bundle: PageBundle,
  splitOptions?: SplitOptions,
): SentenceSegment[] {
  const key = splitOptionsKey(splitOptions);
  let cache = segmentsCache.get(bundle);
  if (cache) {
    const hit = cache.get(key);
    if (hit) return hit;
  } else {
    cache = new Map();
    segmentsCache.set(bundle, cache);
  }
  const segments = computeSentenceSegments(bundle, splitOptions);
  cache.set(key, segments);
  return segments;
}

function computeSentenceSegments(
  bundle: PageBundle,
  splitOptions?: SplitOptions,
): SentenceSegment[] {
  const paragraphs = paragraphAnchorRanges(bundle.anchors, bundle.pageText);
  const segments: SentenceSegment[] = [];
  for (const [paragraphStartAnchor, paragraphEndAnchor] of paragraphs) {
    const anchors = bundle.anchors.slice(
      paragraphStartAnchor,
      paragraphEndAnchor + 1,
    );
    const { text, anchorIndexByTextIndex } = segmenterTextForAnchors(
      bundle.pageText,
      anchors,
    );
    const raw = splitSentences(text, splitOptions).filter(
      (segment) => segment.end > segment.start && segment.text.trim(),
    );
    for (const sentence of raw) {
      const startAnchor = anchorIndexByTextRange(
        anchorIndexByTextIndex,
        sentence.start,
        sentence.end,
        true,
      );
      const endAnchor = anchorIndexByTextRange(
        anchorIndexByTextIndex,
        sentence.start,
        sentence.end,
        false,
      );
      if (startAnchor == null || endAnchor == null || endAnchor < startAnchor) {
        continue;
      }
      segments.push({
        text: sentence.text,
        startAnchor: paragraphStartAnchor + startAnchor,
        endAnchor: paragraphStartAnchor + endAnchor,
      });
    }
  }
  return segments;
}

/** 鼠标 PDF 坐标 → 所在句子（无命中返回 null）。 */
export function sentenceAtPoint(
  bundle: PageBundle,
  point: { x: number; y: number },
  splitOptions?: SplitOptions,
): LocatedSentence | null {
  const anchorIndex = closestAnchorIndex(bundle, point);
  if (anchorIndex == null) return null;
  const segments = sentenceSegmentsForPage(bundle, splitOptions);
  if (!segments.length) return null;
  const segment =
    segments.find(
      (entry) => anchorIndex >= entry.startAnchor && anchorIndex <= entry.endAnchor,
    ) ?? closestSentenceSegment(segments, anchorIndex);
  return segment ? locatedSentenceFromSegment(bundle, segment) : null;
}

/** 页内第 sentenceIndex 句。 */
export function sentenceAtIndex(
  bundle: PageBundle,
  sentenceIndex: number,
  splitOptions?: SplitOptions,
): LocatedSentence | null {
  const segment = sentenceSegmentsForPage(bundle, splitOptions)[sentenceIndex];
  return segment ? locatedSentenceFromSegment(bundle, segment) : null;
}

function locatedSentenceFromSegment(
  bundle: PageBundle,
  segment: SentenceSegment,
): LocatedSentence | null {
  const start = bundle.anchors[segment.startAnchor]?.startOffset;
  const end = bundle.anchors[segment.endAnchor]?.endOffset;
  if (start == null || end == null || end <= start) return null;
  const rects = rectsForAnchors(bundle, segment.startAnchor, segment.endAnchor);
  if (!rects.length) return null;
  const text = bundle.pageText.slice(start, end).replace(/\s+/g, " ").trim();
  const words = bundle.words.filter(
    (w) => w.startAnchor >= segment.startAnchor && w.endAnchor <= segment.endAnchor,
  );
  return {
    text: text || segment.text,
    rects,
    startAnchor: segment.startAnchor,
    endAnchor: segment.endAnchor,
    words,
  };
}

function closestSentenceSegment(
  segments: SentenceSegment[],
  anchorIndex: number,
): SentenceSegment | null {
  let best: SentenceSegment | null = null;
  let bestDistance = Infinity;
  for (const segment of segments) {
    const distance =
      anchorIndex < segment.startAnchor
        ? segment.startAnchor - anchorIndex
        : anchorIndex > segment.endAnchor
          ? anchorIndex - segment.endAnchor
          : 0;
    if (distance < bestDistance) {
      best = segment;
      bestDistance = distance;
    }
  }
  return best;
}

/** 段落区间（anchor 索引闭区间列表）。 */
function paragraphAnchorRanges(
  anchors: CharAnchor[],
  pageText: string,
): Array<[number, number]> {
  const lines: Array<{
    start: number;
    end: number;
    rect: PdfRect;
    text: string;
  }> = [];
  let lineStart = 0;
  const pushLine = (end: number) => {
    const lineAnchors = anchors.slice(lineStart, end + 1);
    const rects = lineAnchors.map(fullAnchorRect);
    lines.push({
      start: lineStart,
      end,
      rect: unionRects(rects),
      text: lineAnchors
        .map((anchor) => pageText.slice(anchor.startOffset, anchor.endOffset))
        .join("")
        .trim(),
    });
    lineStart = end + 1;
  };
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!;
    if (anchor.lineBreakAfter || i === anchors.length - 1) pushLine(i);
  }
  if (!lines.length) return [];

  const ranges: Array<[number, number]> = [];
  let startLine = 0;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1]!;
    const current = lines[i]!;
    const previousAnchor = anchors[prev.end]!;
    const isBreak =
      previousAnchor.paragraphBreakAfter ||
      (previousAnchor.lineBreakAfter &&
        current.rect[0] > prev.rect[0] + 10 &&
        lineEndsSentence(prev.text));
    const nextStartsLower = /^[a-z]/.test(current.text);
    if (isBreak && !nextStartsLower) {
      ranges.push([lines[startLine]!.start, prev.end]);
      startLine = i;
    }
  }
  ranges.push([lines[startLine]!.start, lines[lines.length - 1]!.end]);
  return ranges;
}

function lineEndsSentence(text: string): boolean {
  return /[.!?。？！][)"'\]\u2019\u201d]*$/.test(text.trim());
}

function unionRects(rects: PdfRect[]): PdfRect {
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}

function fullAnchorRect(anchor: CharAnchor): PdfRect {
  return [anchor.x, anchor.y, anchor.x + anchor.width, anchor.y + anchor.height];
}

/**
 * 把 anchor 序列拼成段文本，并记录「文本位置 → anchor 索引」映射。
 * gap（anchor.endOffset 与下一 anchor.startOffset 之间的空白）按原样保留。
 */
function segmenterTextForAnchors(
  pageText: string,
  anchors: CharAnchor[],
): {
  text: string;
  anchorIndexByTextIndex: number[];
} {
  const parts: string[] = [];
  const anchorIndexByTextIndex: number[] = [];
  let length = 0;
  anchors.forEach((anchor, index) => {
    const text = pageText.slice(anchor.startOffset, anchor.endOffset);
    for (let j = 0; j < text.length; j++) {
      anchorIndexByTextIndex[length + j] = index;
    }
    parts.push(text);
    length += text.length;

    const next = anchors[index + 1];
    const gap = next
      ? pageText.slice(anchor.endOffset, next.startOffset).replace(/\s/g, " ")
      : "";
    if (gap) {
      parts.push(gap);
      length += gap.length;
    }
  });
  return {
    text: parts.join(""),
    anchorIndexByTextIndex,
  };
}

function anchorIndexByTextRange(
  map: number[],
  start: number,
  end: number,
  forward: boolean,
): number | null {
  let i = forward ? start : end - 1;
  const step = forward ? 1 : -1;
  const stop = forward ? end : start - 1;
  for (; i !== stop; i += step) {
    if (map[i] !== undefined) return map[i]!;
  }
  return null;
}
