/**
 * Shared helpers for word extraction & validation.
 */

/** Regex for a maximal run of ASCII letters. */
const WORD_RUN = /[A-Za-z]+/g;

/**
 * Check whether `text` is exactly a single pure English word (>= 2 letters,
 * no spaces, digits, or symbols). Used to decide whether to show the
 * "+生词本" button.
 */
export function isSingleEnglishWord(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  return /^[A-Za-z]{2,}$/.test(t);
}

/**
 * Extract the English word (>=2 letters) containing the character at
 * `offset` within `text`. Returns null if the character is not part of a
 * valid English word.
 */
export function wordAtOffset(text: string, offset: number): string | null {
  if (!text || offset < 0 || offset > text.length) return null;
  let matches: RegExpExecArray | null;
  WORD_RUN.lastIndex = 0;
  while ((matches = WORD_RUN.exec(text)) !== null) {
    const start = matches.index;
    const end = start + matches[0].length;
    // offset may be at end boundary; treat end as inclusive of the run
    if (offset >= start && offset <= end) {
      const word = matches[0];
      return word.length >= 2 ? word : null;
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
      if (word.length >= 2) {
        return { word, start, end };
      }
      return null;
    }
  }
  return null;
}
