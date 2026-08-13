/**
 * sentence-splitter.ts —— 句子切分（移植自 zotero-sentence-translator，
 * 处理缩写 / 属名缩写 / acronym 例外，支持用户自定义例外词）。
 */

export interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

const DIVIDERS = new Set([".", "?", "!", "。", "？", "！"]);

const ABBREVIATIONS = new Set<string>([
  "a.m.", "p.m.", "vol.", "inc.", "jr.", "dr.", "tex.", "co.",
  "prof.", "rev.", "revd.", "hon.", "v.s.", "i.e.", "ie.",
  "eg.", "e.g.", "al.", "st.", "ph.d.", "capt.", "mr.", "mrs.", "ms.", "fig.",
]);

export interface SplitOptions {
  /** 以句号结尾但不结束句子的用户例外 token（如 "sp", "spp", "var"）。 */
  exceptions?: string[];
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

function endsWithAbbreviation(
  text: string,
  dotIndex: number,
  exceptions?: Set<string>,
): boolean {
  const chunk = text.slice(0, dotIndex + 1);
  const tokens = chunk.split(/\s+/);
  const last = tokens[tokens.length - 1]?.toLowerCase();
  if (!last) return false;

  // Strip leading punctuation so "(Fig." matches "fig." in ABBREVIATIONS.
  const clean = last.replace(/^[^a-z0-9]+/, "");

  if (ABBREVIATIONS.has(last)) return true;
  if (clean !== last && ABBREVIATIONS.has(clean)) return true;

  // PDF text extraction often places the period as a separate token with
  // whitespace between the word and the dot (e.g. "Fig . 1").
  if (tokens.length >= 2) {
    const prev = tokens[tokens.length - 2]!.toLowerCase();
    const combined = prev + ".";
    if (ABBREVIATIONS.has(combined)) return true;
    const prevClean = prev.replace(/^[^a-z0-9]+/, "").replace(/\.+$/, "");
    if (prevClean && exceptions?.has(prevClean)) return true;
  }

  const stem = clean.replace(/\.+$/, "");
  return exceptions?.has(stem) ?? false;
}

/** Genus-abbreviation pattern: "A. japonicus", "E. coli". */
function isGenusAbbreviation(text: string, dotIndex: number): boolean {
  if (dotIndex < 1) return false;
  const prev = text[dotIndex - 1]!;
  if (!/[A-Z]/.test(prev)) return false;
  if (dotIndex > 1 && !isWhitespace(text[dotIndex - 2]!)) return false;
  for (let i = dotIndex + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (isWhitespace(ch)) continue;
    return /[a-z]/.test(ch);
  }
  return false;
}

// U.S.A.-style acronyms: period is part of a token of >=2 dot-separated
// alphabetic segments each <=2 chars.
function isAcronymPeriod(text: string, dotIndex: number): boolean {
  let start = dotIndex;
  while (start > 0 && !isWhitespace(text[start - 1]!)) start--;
  let end = dotIndex + 1;
  while (end < text.length && !isWhitespace(text[end]!)) end++;
  const token = text.slice(start, end);
  const segments = token.split(".").filter(Boolean);
  if (segments.length < 2) return false;
  return segments.every((seg) => seg.length <= 2 && /^[A-Za-z]+$/.test(seg));
}

export function splitSentences(
  text: string,
  options?: SplitOptions,
): SentenceSpan[] {
  const exceptions = options?.exceptions?.length
    ? new Set(options.exceptions.map((e) => e.toLowerCase()))
    : undefined;

  const out: SentenceSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!DIVIDERS.has(ch)) continue;

    if (ch === ".") {
      const next = text[i + 1];
      if (next !== undefined && !isWhitespace(next)) continue;
      if (endsWithAbbreviation(text, i, exceptions)) continue;
      if (isAcronymPeriod(text, i) && !startsLikelyNextSentence(text, i + 1))
        continue;
      if (isGenusAbbreviation(text, i)) continue;
    }

    const slice = text.slice(cursor, i + 1).trim();
    if (slice) {
      const start = skipLeadingWhitespace(text, cursor, i + 1);
      out.push({ text: slice, start, end: start + slice.length });
    }
    cursor = i + 1;
  }
  const tail = text.slice(cursor).trim();
  if (tail) {
    const start = skipLeadingWhitespace(text, cursor, text.length);
    out.push({ text: tail, start, end: start + tail.length });
  }
  return out;
}

function startsLikelyNextSentence(text: string, from: number): boolean {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (isWhitespace(ch)) continue;
    return /[A-Z\u4e00-\u9fff]/.test(ch);
  }
  return false;
}

function skipLeadingWhitespace(
  text: string,
  from: number,
  to: number,
): number {
  let i = from;
  while (i < to && isWhitespace(text[i]!)) i++;
  return i;
}

export function sentenceAt(
  text: string,
  offset: number,
  options?: SplitOptions,
): SentenceSpan | null {
  if (offset < 0 || offset > text.length) return null;
  const spans = splitSentences(text, options);
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) return span;
  }
  return null;
}
