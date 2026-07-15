#!/usr/bin/env python3
"""
English word lemmatization utility using LemmInflect.

Companion reference implementation for the pure-JS lemmatizer in
src/modules/lemmatize.ts.  The JS version is used inside the Zotero
plugin; this Python version serves as a standalone tool for testing
accuracy and coverage (or as a pre-processor for external workflows).

Usage:
    python lemmatize.py models better went running meeting
    # Output:
    #   models   → model
    #   better   → good
    #   went     → go
    #   running  → run
    #   meeting  → meeting

Dependencies:
    pip install lemminflect
"""

import sys

try:
    import lemminflect
except ImportError:
    sys.exit(
        "lemminflect is not installed.\n"
        "Run: pip install lemminflect"
    )


def to_lemma(word: str) -> str:
    """Convert an inflected English word to its dictionary headword.

    Uses LemmInflect's getLemma with UPOS=NOUN fallback, then VERB,
    then ADJ.
    """
    lower = word.lower()
    # Try each POS; LemmInflect handles the deduplication internally
    for upos in ("NOUN", "VERB", "ADJ", "ADV"):
        lemmas = lemminflect.getLemma(lower, upos=upos)
        if lemmas:
            lemma = lemmas[0]
            if lemma != lower:
                return _preserve_case(word, lemma)
    # No transformation found
    return word


def _preserve_case(original: str, lemma: str) -> str:
    """Match the capitalisation pattern of the original word."""
    if not lemma:
        return original
    if original.isupper() and len(original) > 1:
        return lemma.upper()
    if original[0].isupper():
        return lemma[0].upper() + lemma[1:]
    return lemma


def main():
    if len(sys.argv) < 2:
        print("Usage: python lemmatize.py <word> [word ...]")
        print()
        print("Examples:")
        print("  python lemmatize.py models went better running children")
        print("  python lemmatize.py Models Went Better")  # preserves case
        sys.exit(1)

    # Align output columns
    max_len = max(len(w) for w in sys.argv[1:])
    for word in sys.argv[1:]:
        lemma = to_lemma(word)
        arrow = "→" if lemma.lower() != word.lower() else "="
        print(f"  {word:<{max_len}} {arrow} {lemma}")


if __name__ == "__main__":
    main()
