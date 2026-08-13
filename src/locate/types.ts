/**
 * locate/ 共享类型定义 —— 取词高亮定位模块（重构版，v0.4.0）。
 *
 * 架构原则（对应重构报告 §6）：
 *  - 单流数据：只基于 getPageData chars，绝不与 textLayer DOM 流做计数对齐；
 *  - 官方信号优先：词边界用官方 wordBreakAfter；坐标→词复刻官方 getClosestWord 语义；
 *  - 句子定位 → 单词定位（句内消歧），UI 只高亮单词。
 */

/** PDF user-space rect: [x1, y1, x2, y2]（原点左下，y 向上）。 */
export type PdfRect = [number, number, number, number];

/** 单个字符（从官方 getPageData chars 精简）。 */
export interface WordChar {
  c: string;
  /** 官方原始 unicode 串（连字时完整串如 "fi"）。 */
  u?: string;
  /** 官方 offset（split 后的顺序索引）。 */
  offset: number;
  /** 字符原始 box（PDF 坐标）。 */
  rect: PdfRect;
  /** 行对齐 box（官方 split 生成，vertical 取列宽、horizontal 取行高）——渲染首选。 */
  inlineRect?: PdfRect;
  baseline: number;
  fontSize: number;
  rotation: number;
  spaceAfter: boolean;
  lineBreakAfter: boolean;
  /** 官方 ignorable（行尾连字符）：getTextFromChars 重建文本时跳过。 */
  ignorable?: boolean;
  paragraphBreakAfter?: boolean;
  /** 官方词边界信号（split() 按间距阈值/标点/baseline 差生成）——单词定位权威来源。 */
  wordBreakAfter?: boolean;
}

/** 页面数据模型（单流构建，无任何 DOM 侧计数）。 */
export interface PageBundle {
  pageIndex: number;
  /** 全部字符（含 ignorable），按 offset 序。 */
  chars: WordChar[];
  viewBox: PdfRect | null;
  /** 页面文本：官方 getTextFromChars 语义（跳过 ignorable，space/lineBreak 展开空格）。 */
  pageText: string;
  /** 规范化文本（小写 + 连字展开 + 空白合并 + -\n 连字符特判）。 */
  normalizedText: string;
  /** normalizedText 第 i 字符 → pageText 偏移。 */
  normalizedToOriginal: number[];
  /** 非 ignorable 字符的渲染 anchor（inlineRect 优先）。 */
  anchors: CharAnchor[];
  /** 预计算词表（按官方 wordBreakAfter 切词）——getClosestWord O(W) 命中。 */
  words: WordSpan[];
}

/** 单字符渲染锚点。 */
export interface CharAnchor {
  /** chars 内索引（itemIndex 语义，用于注释 sortIndex 对齐）。 */
  charIndex: number;
  /** pageText 内起始偏移。 */
  startOffset: number;
  /** pageText 内结束偏移（开区间）。 */
  endOffset: number;
  x: number;
  y: number;
  width: number;
  height: number;
  lineBreakAfter: boolean;
  paragraphBreakAfter: boolean;
  wordBreakAfter: boolean;
}

/** 预分词（wordBreakAfter 驱动的词跨度）。 */
export interface WordSpan {
  /** anchors 内闭区间 [startAnchor, endAnchor]。 */
  startAnchor: number;
  endAnchor: number;
  /** 词文本（原样，未规范化）。 */
  text: string;
  /** 包围盒（inlineRect union）。 */
  rect: PdfRect;
}

/** 单词定位结果（对外契约，hoverTranslate 渲染/弹窗锚定用）。 */
export interface LocatedWord {
  word: string;
  /** PDF 坐标 rect（可多块，如跨列/换行）。 */
  rects: PdfRect[];
  /** 命中的字符。 */
  chars: WordChar[];
  /** 页面数据（含 viewBox/pageIndex，供坐标转换）。 */
  bundle: PageBundle;
}

/** 句子定位结果（过渡锚点，UI 不直接使用）。 */
export interface LocatedSentence {
  text: string;
  rects: PdfRect[];
  startAnchor: number;
  endAnchor: number;
  /** 句内词序列（wordBreakAfter 切分，单词定位的候选空间）。 */
  words: WordSpan[];
}
