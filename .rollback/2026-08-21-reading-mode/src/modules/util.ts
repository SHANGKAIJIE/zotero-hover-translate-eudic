/**
 * Shared helpers for word extraction & validation.
 */

/**
 * Regex for a maximal run of word characters.
 *
 * Includes not only ASCII letters but also:
 * - Latin-1 Supplement + Latin Extended letters (U+00C0–U+024F): covers
 *   accented letters like é ü ñ Å — without this, "café" would be split at é.
 * - Latin ligatures (U+FB00–U+FB06): ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ — PDF text layers often
 *   emit these as single code points; without including them in the run,
 *   "classiﬁcation" would be split at ﬁ into "classi" + "cation", causing
 *   half-word highlighting + half-word translation (bug B root cause).
 *
 * The ligatures are expanded to their multi-char equivalents (ﬁ→fi) before
 * being sent to translation APIs via {@link expandLigatures}; the raw form
 * is retained for DOM range consistency (range.toString must match word).
 */
const WORD_RUN = /[A-Za-z\u00C0-\u024F\uFB00-\uFB06]+/g;

/** 单字符是否属于词字符（ASCII 字母 + Latin-1/扩展 + 连字）。与 WORD_RUN 同源。 */
export function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9\u00C0-\u024F\uFB00-\uFB06]/.test(ch);
}

/**
 * Common Latin ligatures that PDF text layers may emit as single code points.
 * Kept in sync with `LIGATURES` in `src/locate/page-bundle.ts` so that
 * `expandLigatures(word) === normalizeWord(word)` (case-insensitively) for
 * any word containing ligatures.
 */
const LIGATURES: Record<string, string> = {
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
};

/**
 * Expand Latin ligature code points to their multi-letter equivalents
 * (ﬁ→fi, ﬂ→fl, ﬃ→ffi, …). Non-ligature characters pass through unchanged.
 *
 * Use this to normalize a word before sending it to a translation API or
 * dictionary lookup: most APIs cannot find "classiﬁcation" (with the ﬁ
 * ligature) but can find "classification". The raw word (with the ligature)
 * must be kept for DOM Range operations where `range.toString()` must match.
 *
 * This is the inverse of the splitting that `/[A-Za-z]+/` (without ligature
 * support) would do — by including ligatures in {@link WORD_RUN} we keep the
 * word intact during extraction, then expand here for downstream use.
 */
export function expandLigatures(text: string): string {
  if (!text) return text;
  let result = "";
  for (const ch of text) {
    result += LIGATURES[ch] ?? ch;
  }
  return result;
}

/**
 * Check whether `text` is exactly a single pure English word (>= 2 letters,
 * no spaces, digits, or symbols). Used to decide whether to show the
 * "+生词本" button. Ligatures are expanded first so "classiﬁcation" (with ﬁ)
 * is recognized as a valid English word.
 */
export function isSingleEnglishWord(text: string): boolean {
  if (!text) return false;
  const t = expandLigatures(text.trim());
  return /^[A-Za-z]{2,}$/.test(t);
}

/**
 * Extract the English word containing the character at `offset` within
 * `text`. Returns null if the character is not part of a valid English word.
 * Highlights any word ≥ 1 letter; "+生词本" button requires ≥ 2 via
 * isSingleEnglishWord.
 */
export function wordAtOffset(text: string, offset: number): string | null {
  if (!text || offset < 0 || offset > text.length) return null;
  let matches: RegExpExecArray | null;
  WORD_RUN.lastIndex = 0;
  while ((matches = WORD_RUN.exec(text)) !== null) {
    const start = matches.index;
    const end = start + matches[0].length;
    if (offset >= start && offset <= end) {
      const word = matches[0];
      return word.length >= 1 ? word : null;
    }
  }
  return null;
}

/**
 * Get the word and its character range [start, end) within `text` at offset.
 */
export function wordRangeAtOffset(
  text: string,
  offset: number,
): { word: string; start: number; end: number } | null {
  if (!text || offset < 0 || offset > text.length) return null;
  let matches: RegExpExecArray | null;
  WORD_RUN.lastIndex = 0;
  while ((matches = WORD_RUN.exec(text)) !== null) {
    const start = matches.index;
    const end = start + matches[0].length;
    if (offset >= start && offset <= end) {
      const word = matches[0];
      if (word.length >= 1) {
        return { word, start, end };
      }
      return null;
    }
  }
  return null;
}

/**
 * 用 Intl.Segmenter（UAX#29 Unicode 词边界）精确判断 offset 所在 segment
 * 是否为词，借鉴 Zotero reader.js `_getTouchAnnotationStartPosition` 的词
 * 边界 snap 实现。
 *
 * 与 {@link wordRangeAtOffset} 的关键差异：
 * - `wordRangeAtOffset` 用正则 `[A-Za-z...]+` 匹配，`offset <= end` 条件
 *   使得词尾后一位仍匹配该词 → 词边缘外可能误取。
 * - `snapWordAtOffset` 用 `Intl.Segmenter.containing(offset)` 精确判断：
 *   - offset 在词 segment 内（`isWordLike`）→ 取完整词（含连字，用正则
 *     在 segment 范围内匹配确保 U+FB00–FB06 被包含）
 *   - offset 在非词 segment（空格/标点/行间）→ **返回 null**，不误取
 *     相邻词
 * - `Intl.Segmenter` 不可用时降级到 `wordRangeAtOffset`。
 *
 * 解决问题A词边缘场景：`caretPositionFromPoint` 在词边缘可能返回相邻词
 * 的 offset（WebKit bug #30034/#30689），`Intl.Segmenter` 从源头精确
 * 判断 offset 所属 segment，避免误取相邻词。
 *
 * @param text 文本节点内容
 * @param offset caret offset
 * @param lang 语言标签（可选，影响 UAX#29 词边界判定）
 */
export function snapWordAtOffset(
  text: string,
  offset: number,
  lang?: string,
): { word: string; start: number; end: number } | null {
  if (!text || offset < 0 || offset > text.length) return null;

  // 优先用 Intl.Segmenter（UAX#29，借鉴 Zotero reader.js）
  if ("Segmenter" in Intl) {
    try {
      const segmenter = new Intl.Segmenter(lang, { granularity: "word" });
      const segIter = segmenter.segment(text) as any;
      const segment = segIter.containing(offset);
      if (segment) {
        if (segment.isWordLike) {
          // caret 在词内 → 在 segment 范围内用正则取完整词（确保连字
          // U+FB00–FB06 被包含，Intl.Segmenter 可能不认连字为词字符）
          const segStart = segment.index;
          const segEnd = segStart + segment.segment.length;
          WORD_RUN.lastIndex = segStart;
          let m: RegExpExecArray | null;
          while ((m = WORD_RUN.exec(text)) !== null) {
            const s = m.index;
            const e = s + m[0].length;
            if (offset >= s && offset <= e) {
              return { word: m[0], start: s, end: e };
            }
            if (s > segEnd) break;
          }
          // 正则在 segment 范围未匹配到（连字导致 Segmenter 边界与正则
          // 不一致）→ 降级到 segment 本身
          return {
            word: segment.segment,
            start: segStart,
            end: segEnd,
          };
        } else {
          // caret 在非词 segment（空格/标点/行间）→ 不取词
          return null;
        }
      }
    } catch {
      // Intl.Segmenter 异常 → 降级到正则
    }
  }

  // 降级：正则 wordRangeAtOffset（原有逻辑）
  return wordRangeAtOffset(text, offset);
}
