/**
 * Local CSV wordbook — stores words in a local CSV file.
 *
 * Columns: word, phon, exp, context_line, add_time
 * Encoding: UTF-8 with BOM (Excel-compatible)
 *
 * When localSavePath pref is empty, defaults to Zotero profile directory.
 */

import { getPref } from "../utils/prefs";

const DEFAULT_FILENAME = "hover-translate-eudic-wordbook.csv";
const CSV_HEADER = "word,phon,exp,add_time";

/* ------------------------------------------------------------------ */
/*  Path resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve the nsIFile for the local wordbook CSV.
 *
 * - If localSavePath is absolute and ends with a filename → use as-is.
 * - If localSavePath is a directory or ends with a separator → append DEFAULT_FILENAME.
 * - If localSavePath is empty → Zotero profile directory + DEFAULT_FILENAME.
 */
function getWordbookFile(): any {
  const savePath = (getPref("localSavePath") as string || "").trim();
  if (savePath) {
    const nsIFile = (Components as any).interfaces.nsIFile;
    const file = (Components as any).classes["@mozilla.org/file/local;1"]
      .createInstance(nsIFile);
    try {
      file.initWithPath(savePath);
      if (file.isDirectory() || savePath.endsWith("\\") || savePath.endsWith("/")) {
        file.append(DEFAULT_FILENAME);
      }
      return file;
    } catch {
      // Invalid path → fall through to default
    }
  }
  // Default: Zotero profile directory
  const dirSvc = (Components as any).classes["@mozilla.org/file/directory_service;1"]
    .getService((Components as any).interfaces.nsIProperties);
  const profileDir = dirSvc.get("ProfD", (Components as any).interfaces.nsIFile);
  profileDir.append(DEFAULT_FILENAME);
  return profileDir;
}

/* ------------------------------------------------------------------ */
/*  Low-level CSV I/O                                                  */
/* ------------------------------------------------------------------ */

/**
 * Read the full content of a file as a UTF-8 string.
 * Returns empty string if file doesn't exist or can't be read.
 */
async function readContent(file: any): Promise<string> {
  if (!file.exists()) return "";
  try {
    // Zotero 7+ async API
    return String(await Zotero.File.getContentsAsync(file)) || "";
  } catch {
    // Fallback: synchronous stream read
    try {
      const istream = (Components as any).classes["@mozilla.org/network/file-input-stream;1"]
        .createInstance((Components as any).interfaces.nsIFileInputStream);
      istream.init(file, 0x01, 0o444, 0);
      const content = Zotero.File.getContents(istream) as string || "";
      istream.close();
      return content;
    } catch {
      return "";
    }
  }
}

/** Escape a single CSV field. */
function esc(val: unknown): string {
  const s = val == null ? "" : String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Parse the first field (word) from a CSV line (handles quoting). */
function extractWordFromLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 1 ? trimmed.slice(1, end) : trimmed;
  }
  const comma = trimmed.indexOf(",");
  return comma > 0 ? trimmed.slice(0, comma).trim() : trimmed.trim();
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Append a word to the local CSV wordbook.
 * Deduplicates by case-insensitive word match.
 *
 * @returns true if the word was saved or already exists; false on error.
 */
export async function addWord(params: {
  word: string;
  phon?: string;
  exp?: string;
}): Promise<boolean> {
  try {
    const file = getWordbookFile();
    let content = await readContent(file);
    const existing = new Set<string>();

    if (content) {
      // Build set of existing words for dedup
      const lines = content.split("\n");
      let headerSeen = false;
      for (const line of lines) {
        if (!headerSeen && line.startsWith(CSV_HEADER)) {
          headerSeen = true;
          continue;
        }
        const w = extractWordFromLine(line).toLowerCase();
        if (w) existing.add(w);
      }
    }

    if (existing.has(params.word.toLowerCase())) {
      return true; // already present, not an error
    }

    const add_time = new Date().toISOString().replace("T", " ").slice(0, 19);
    const row = [
      esc(params.word),
      esc(params.phon || ""),
      esc(params.exp || ""),
      esc(add_time),
    ];
    const line = row.join(",");

    // Create content with BOM + header if new file
    if (!content) {
      content = "\uFEFF" + CSV_HEADER + "\n";
    }
    // Ensure trailing newline before appending
    if (!content.endsWith("\n")) content += "\n";
    content += line + "\n";

    await Zotero.File.putContentsAsync(file, content, "UTF-8");
    Zotero.debug(`[hover-translate-eudic/local] saved word: "${params.word}"`);
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/local] addWord error: ${e?.message || e}`);
    return false;
  }
}

/**
 * Read all entries from the local CSV wordbook.
 * Returns an empty array if the file doesn't exist.
 */
export async function getWords(): Promise<
  { word: string; phon: string; exp: string; add_time: string }[]
> {
  const file = getWordbookFile();
  const content = await readContent(file);
  if (!content) return [];

  const lines = content.split("\n");
  const results: any[] = [];
  let headerSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!headerSeen && trimmed.startsWith(CSV_HEADER)) {
      headerSeen = true;
      continue;
    }
    if (!headerSeen) continue;

    // Simple CSV line split (handles basic quoting)
    const cols: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inQ) {
        if (ch === '"') {
          if (i + 1 < trimmed.length && trimmed[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQ = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ",") {
        cols.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur);

    results.push({
      word: cols[0] || "",
      phon: cols[1] || "",
      exp: cols[2] || "",
      add_time: cols[3] || "",
    });
  }
  return results;
}
