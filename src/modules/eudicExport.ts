/**
 * Eudic (欧路词典) wordbook export module.
 *
 * Fetches all words from a selected wordbook via the Eudic OpenAPI and
 * saves them in the user's chosen format. All output is UTF-8 encoded.
 *
 * Supported formats:
 *   - csv:  comma-separated, quoted fields (Excel/WPS compatible)
 *   - tsv:  tab-separated (Anki-compatible)
 *   - txt:  human-readable plain text
 *   - json: full structured data
 */

import { EudicClient, EudicWordEntry } from "./eudic";

const EXPORT_FILENAME = "eudic-wordbook";

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Strip HTML tags from a string (for plain-text export formats). */
function stripHtml(val: unknown): string {
  if (val == null) return "";
  return String(val)
    .replace(/<[^>]+>/g, "")   // remove tags
    .replace(/&nbsp;/g, " ")   // decode common entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Ensure an nsIFile can be written to.  If the file exists and is locked
 * (e.g. opened by Excel), append a timestamp suffix to avoid the conflict.
 */
function ensureWritable(file: any): void {
  if (!file.exists()) return;
  try {
    file.remove(false);
  } catch {
    // File is locked — generate a unique name
    const leaf = file.leafName;
    const dot = leaf.lastIndexOf(".");
    const base = dot > 0 ? leaf.slice(0, dot) : leaf;
    const ext = dot > 0 ? leaf.slice(dot) : "";
    const now = Date.now();
    file.leafName = `${base}-${now}${ext}`;
  }
}

/**
 * Clean a word entry for plain-text export: strip HTML from text fields.
 * The original entry is not mutated.
 */
function cleanEntry(w: EudicWordEntry): {
  word: string; phon: string; exp: string; context: string; add_time: string; star: number | undefined;
} {
  return {
    word: stripHtml(w.word),
    phon: stripHtml(w.phon),
    exp: stripHtml(w.exp),
    context: stripHtml(w.context_line),
    add_time: (w.add_time || "").trim(),
    star: w.star,
  };
}

/* ------------------------------------------------------------------ */
/*  Format conversion                                                  */
/* ------------------------------------------------------------------ */

/** Escape a CSV/TSV field: wrap in quotes if it contains delimiter, quote, or newline. */
function esc(val: unknown, delim: string): string {
  const s = val == null ? "" : String(val);
  if (s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsv(words: EudicWordEntry[]): string {
  const header = ["word", "phon", "exp", "context_line", "add_time", "star"];
  const rows = [header.join(",")];
  for (const w of words) {
    const c = cleanEntry(w);
    rows.push(
      [
        esc(c.word, ","),
        esc(c.phon, ","),
        esc(c.exp, ","),
        esc(c.context, ","),
        esc(c.add_time, ","),
        esc(c.star ?? "", ","),
      ].join(","),
    );
  }
  return rows.join("\n");
}

function toTsv(words: EudicWordEntry[]): string {
  const header = ["word", "phon", "exp", "context_line", "add_time", "star"];
  const rows = [header.join("\t")];
  for (const w of words) {
    const c = cleanEntry(w);
    rows.push(
      [
        esc(c.word, "\t"),
        esc(c.phon, "\t"),
        esc(c.exp, "\t"),
        esc(c.context, "\t"),
        esc(c.add_time, "\t"),
        esc(c.star ?? "", "\t"),
      ].join("\t"),
    );
  }
  return rows.join("\n");
}

function toTxt(words: EudicWordEntry[]): string {
  const lines: string[] = [];
  for (const w of words) {
    const c = cleanEntry(w);
    const parts = [c.word];
    if (c.phon) parts.push(`[${c.phon}]`);
    if (c.exp) parts.push(c.exp);
    if (c.context) parts.push(`— ${c.context}`);
    lines.push(parts.join("  "));
  }
  return lines.join("\n\n");
}

function toJson(words: EudicWordEntry[]): string {
  return JSON.stringify(
    {
      export_time: new Date().toISOString(),
      total: words.length,
      words,
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/*  File saving                                                        */
/* ------------------------------------------------------------------ */

type ExportFormat = "csv" | "tsv" | "txt" | "json";

const FORMAT_META: Record<
  ExportFormat,
  { ext: string; label: string; mime: string }
> = {
  csv: { ext: "csv", label: "CSV (Comma Separated)", mime: "text/csv" },
  tsv: { ext: "tsv", label: "TSV (Tab Separated)", mime: "text/tab-separated-values" },
  txt: { ext: "txt", label: "Plain Text", mime: "text/plain" },
  json: { ext: "json", label: "JSON", mime: "application/json" },
};

const CONVERTERS: Record<ExportFormat, (w: EudicWordEntry[]) => string> = {
  csv: toCsv,
  tsv: toTsv,
  txt: toTxt,
  json: toJson,
};

/**
 * Fetch all words from a wordbook and save to file.
 *
 * @param client     Authenticated EudicClient
 * @param categoryId Target wordbook id
 * @param format     Export format
 * @param opts       Optional settings
 * @returns A status message.
 */
export async function exportWordbook(
  client: EudicClient,
  categoryId: string,
  format: ExportFormat,
  opts?: {
    /** If provided, save directly to this nsIFile (user chose via save dialog). */
    outFile?: any;
    /** If true, try to reveal the saved file in the platform file manager. */
    autoReveal?: boolean;
  },
): Promise<string> {
  const meta = FORMAT_META[format];
  const converter = CONVERTERS[format];

  // 1. Fetch all words from API.
  let words: EudicWordEntry[];
  try {
    words = await client.getWords(categoryId);
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/export] getWords error: ${e?.message}`);
    throw new Error(`获取生词本失败：${e?.message || "网络错误"}`);
  }

  if (words.length === 0) {
    throw new Error("该生词本中没有任何单词");
  }

  // 2. Convert to chosen format.
  const content = converter(words);

  // 3. Determine target file.
  let outFile: any;
  if (opts?.outFile) {
    // User chose a file via save dialog
    outFile = opts.outFile;
  } else {
    // Fallback: Zotero profile temp directory
    const dirSvc = (Components as any).classes["@mozilla.org/file/directory_service;1"]
      .getService((Components as any).interfaces.nsIProperties);
    const profileDir = dirSvc.get("ProfD", (Components as any).interfaces.nsIFile);
    const exportDir = profileDir.clone();
    exportDir.append("zotero-export");
    if (!exportDir.exists()) {
      exportDir.create((Components as any).interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    }
    outFile = exportDir.clone();
    outFile.append(`${EXPORT_FILENAME}.${meta.ext}`);
  }

  // 4. Ensure the target file is writable (may be locked by Excel etc.).
  ensureWritable(outFile);

  // 5. Write file with UTF-8 BOM for Excel compatibility.
  const bom = "\uFEFF";
  await Zotero.File.putContentsAsync(outFile, bom + content, "UTF-8");

  // 6. Auto-reveal in file manager (if opted in).
  if (opts?.autoReveal) {
    try {
      outFile.reveal();
    } catch {
      // Fallback: open the containing folder
      try {
        const parentDir = outFile.parent;
        if (parentDir) (parentDir as any).launch();
      } catch { /* ignore */ }
    }
  }

  const count = words.length;
  Zotero.debug(
    `[hover-translate-eudic/export] Saved ${count} words to ${outFile.path} (${format})`,
  );
  return `已导出生词本，共 ${count} 个单词\n\n文件保存至：${outFile.path}`;
}
