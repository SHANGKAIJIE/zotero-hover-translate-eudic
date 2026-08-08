/**
 * Local CSV wordbook — stores words in a local CSV file.
 *
 * Columns: word, phon, exp, add_time, status, tries, src
 *   - status: 翻译状态（"failed" 失败待补全；空/其他 = 正常）
 *   - tries:   已重试次数（用于限制最多重试 3 次）
 *   - src:     原文跳转链接（zotero://open-pdf/...，v0.3.2 新增，生词本面板跳转用）
 *   - 兼容旧 4/6 列文件：旧行无 status/tries/src 列，按 exp 为空判定待补全。
 * Encoding: UTF-8 with BOM (Excel-compatible)
 *
 * When localSavePath pref is empty, defaults to Zotero profile directory.
 *
 * 重启后自动重试补全：翻译失败的行（exp 为空且 tries<3）会在 Zotero
 * 重启、Translate for Zotero 就绪后自动重新翻译并回填（retryFailedLocalWords）。
 */

import { getPref } from "../utils/prefs";
import { translateWordStandalone } from "./zoteroNote";

const DEFAULT_FILENAME = "hover-translate-eudic-wordbook.csv";
/** 当前表头（7 列，含 src）。 */
const CSV_HEADER = "word,phon,exp,add_time,status,tries,src";
/** 旧 4 列表头前缀（识别历史文件）。 */
const CSV_HEADER_LEGACY_PREFIX = "word,phon,exp,add_time";
/** 失败重试上限（与 Zotero 笔记一致）。 */
const MAX_TRIES = 3;

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
 *
 * 统一剥离 UTF-8 BOM（\uFEFF），保证后续解析（header 识别、CSV 拆分）
 * 不受 BOM 干扰；写入侧再统一补回 BOM。
 */
async function readContent(file: any): Promise<string> {
  const stripBom = (s: string) => String(s || "").replace(/^\uFEFF/, "");
  if (!file.exists()) return "";
  try {
    // Zotero 7+ async API
    return stripBom(String(await Zotero.File.getContentsAsync(file) || ""));
  } catch {
    // Fallback: synchronous stream read
    try {
      const istream = (Components as any).classes["@mozilla.org/network/file-input-stream;1"]
        .createInstance((Components as any).interfaces.nsIFileInputStream);
      istream.init(file, 0x01, 0o444, 0);
      const content = Zotero.File.getContents(istream) as string || "";
      istream.close();
      return stripBom(content);
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

/** 识别 CSV 表头行（兼容旧 4 列 "word,phon,exp,add_time" 与新 6 列）。 */
function isHeaderLine(line: string): boolean {
  const t = line.trim().replace(/^\uFEFF/, "");
  return t.startsWith(CSV_HEADER_LEGACY_PREFIX);
}

/** 简单 CSV 行拆分（处理引号包裹），返回列数组。 */
function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQ = false;
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') {
        if (i + 1 < s.length && s[i + 1] === '"') {
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
  return cols;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Append a word to the local CSV wordbook.
 * Deduplicates by case-insensitive word match.
 *
 * @param params.status 翻译失败时传 "failed"（空串/缺省 = 正常），重启后自动重试补全
 * @param params.tries   失败次数（首次失败传 1；重试成功后会重置）
 * @returns true if the word was saved or already exists; false on error.
 */
export async function addWord(params: {
  word: string;
  phon?: string;
  exp?: string;
  status?: string;
  tries?: number;
  src?: string;
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
        if (!headerSeen && isHeaderLine(line)) {
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
    const status = params.status === "failed" ? "failed" : "";
    const tries = params.status === "failed"
      ? Math.max(1, Number(params.tries) || 1)
      : 0;
    const row = [
      esc(params.word),
      esc(params.phon || ""),
      esc(params.exp || ""),
      esc(add_time),
      esc(status),
      tries ? String(tries) : "",
      esc(params.src || ""),
    ];
    const line = row.join(",");

    // 写入时始终以 UTF-8 BOM 开头：
    //  - 新文件：BOM + header；
    //  - 存量文件（readContent 已剥离 BOM）：补回 BOM。
    // 无 BOM 的 UTF-8 CSV 会被 Excel/WPS 按系统 ANSI(GBK) 解码导致中文乱码，
    // 因此即使是历史遗留的无 BOM 文件，下次写入也会自动修复。
    // 存量文件若还是旧 4 列表头，统一升级为新表头（数据行不变）。
    if (!content) {
      content = "\uFEFF" + CSV_HEADER + "\n";
    } else {
      const firstLine = (content.split("\n")[0] || "").replace(/^\uFEFF/, "").trim();
      if (firstLine && isHeaderLine(firstLine) && firstLine !== CSV_HEADER) {
        content = "\uFEFF" + CSV_HEADER + "\n" + content.split("\n").slice(1).join("\n");
      } else {
        content = "\uFEFF" + content;
      }
    }
    // Ensure trailing newline before appending
    if (!content.endsWith("\n")) content += "\n";
    content += line + "\n";

    await Zotero.File.putContentsAsync(file, content, "UTF-8");
    Zotero.debug(`[hover-translate-eudic/local] saved word: "${params.word}" (status=${status || "ok"})`);
    // 翻译失败（如离线）时弹窗提醒，联网重启后 Zotero 会自动重试补全
    if (status === "failed") {
      localNotify(`已添加，联网重启后自动重试补全：${params.word}`);
    }
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/local] addWord error: ${e?.message || e}`);
    return false;
  }
}

/**
 * Read all entries from the local CSV wordbook.
 * Returns an empty array if the file doesn't exist.
 * 兼容旧 4 列（无 status/tries）与新 6/7 列文件。
 */
export async function getWords(): Promise<
  { word: string; phon: string; exp: string; add_time: string; status: string; tries: number; src: string }[]
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
    if (!headerSeen && isHeaderLine(trimmed)) {
      headerSeen = true;
      continue;
    }
    if (!headerSeen) continue;

    const cols = splitCsvLine(trimmed);
    const status = String(cols[4] || "").trim();
    const tries = Number.parseInt(String(cols[5] || "0"), 10) || 0;
    results.push({
      word: cols[0] || "",
      phon: cols[1] || "",
      exp: cols[2] || "",
      add_time: cols[3] || "",
      status,
      tries,
      src: String(cols[6] || "").trim(),
    });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/*  重启后自动重试补全（翻译失败的行）                                  */
/* ------------------------------------------------------------------ */

/** 轻量 ProgressWindow 通知（本地生词表用，不依赖 zoteroNote）。 */
function localNotify(message: string): void {
  try {
    const pw = new (Zotero as any).ProgressWindow({ closeOnClick: true });
    pw.show();
    const line = new pw.ItemProgress("note", message);
    if (typeof line.setItemTypeAndIcon === "function") {
      line.setItemTypeAndIcon("note", "note");
    }
    (pw as any).progress = line;
    line.setProgress(100);
    pw.startCloseTimer(4000);
  } catch { /* 通知失败不影响主流程 */ }
}

/**
 * 更新 CSV 中某单词所在行（重试成功后回填 phon/exp，或失败后累加 tries）。
 * 按大小写不敏感匹配 word；未找到返回 false。
 */
async function updateWord(
  word: string,
  patch: { phon?: string; exp?: string; status?: string; tries?: number; src?: string },
): Promise<boolean> {
  try {
    const file = getWordbookFile();
    const content = await readContent(file);
    if (!content) return false;

    const lines = content.split("\n");
    const target = String(word || "").toLowerCase();
    let changed = false;

    const newLines = lines.map((line, idx) => {
      if (idx === 0 && isHeaderLine(line)) return line; // 表头保留
      const cols = splitCsvLine(line);
      const w = (cols[0] || "").trim().toLowerCase();
      if (!w || w !== target) return line;
      changed = true;
      const curStatus = String(cols[4] || "").trim();
      const curTries = Number.parseInt(String(cols[5] || "0"), 10) || 0;
      const status = patch.status !== undefined ? patch.status : curStatus;
      const tries = patch.tries !== undefined ? patch.tries : curTries;
      const newCols = [
        cols[0], // word（保持原样）
        patch.phon !== undefined ? patch.phon : (cols[1] || ""),
        patch.exp !== undefined ? patch.exp : (cols[2] || ""),
        cols[3] || "", // add_time 保持
        esc(status),
        tries ? String(tries) : "",
        patch.src !== undefined ? esc(patch.src) : (cols[6] !== undefined ? (cols[6] || "").trim() : ""),
      ];
      return newCols.join(",");
    });

    if (!changed) return false;
    // 保持 BOM 前缀
    const out = "\uFEFF" + newLines.join("\n");
    await Zotero.File.putContentsAsync(file, out, "UTF-8");
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/local] updateWord error: ${e?.message || e}`);
    return false;
  }
}

/**
 * 按数据行索引更新 CSV 词条（生词本面板编辑用）。
 * index 为 getWords() 返回数组的下标（0-based，不含表头行）。
 * 仅当 patch 字段与现值不同时才重写文件。
 */
export async function updateWordByIndex(
  index: number,
  patch: { word?: string; phon?: string; exp?: string; src?: string },
): Promise<boolean> {
  try {
    const file = getWordbookFile();
    const content = await readContent(file);
    if (!content) return false;

    const lines = content.split("\n");
    const dataLines: { raw: string; idx: number }[] = [];
    let headerSeen = false;
    lines.forEach((line, li) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!headerSeen && isHeaderLine(trimmed)) {
        headerSeen = true;
        return;
      }
      if (headerSeen) dataLines.push({ raw: line, idx: li });
    });

    if (index < 0 || index >= dataLines.length) return false;
    const target = dataLines[index];
    const cols = splitCsvLine(target.raw);
    const newCols = [
      esc(patch.word !== undefined ? patch.word : (cols[0] || "")),
      esc(patch.phon !== undefined ? patch.phon : (cols[1] || "")),
      esc(patch.exp !== undefined ? patch.exp : (cols[2] || "")),
      cols[3] || "", // add_time 保持
      cols[4] !== undefined ? (cols[4] || "").trim() : "", // status 保持
      cols[5] !== undefined ? (cols[5] || "").trim() : "", // tries 保持
      esc(patch.src !== undefined ? patch.src : (cols[6] !== undefined ? (cols[6] || "").trim() : "")),
    ];
    lines[target.idx] = newCols.join(",");

    const out = "\uFEFF" + lines.join("\n");
    await Zotero.File.putContentsAsync(file, out, "UTF-8");
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/local] updateWordByIndex error: ${e?.message || e}`);
    return false;
  }
}

/**
 * 按数据行索引删除 CSV 词条（生词本面板删除用）。
 * index 为 getWords() 返回数组的下标（0-based，不含表头行）。
 */
export async function deleteWordByIndex(index: number): Promise<boolean> {
  try {
    const file = getWordbookFile();
    const content = await readContent(file);
    if (!content) return false;

    const lines = content.split("\n");
    let headerSeen = false;
    let dataCount = 0;
    let targetLineIdx = -1;
    lines.forEach((line, li) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!headerSeen && isHeaderLine(trimmed)) {
        headerSeen = true;
        return;
      }
      if (headerSeen) {
        if (dataCount === index) targetLineIdx = li;
        dataCount++;
      }
    });

    if (targetLineIdx < 0) return false;
    lines.splice(targetLineIdx, 1);

    const out = "\uFEFF" + lines.join("\n");
    await Zotero.File.putContentsAsync(file, out, "UTF-8");
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/local] deleteWordByIndex error: ${e?.message || e}`);
    return false;
  }
}

/**
 * 重启后自动重试补全本地生词表中翻译失败的行。
 *
 * 判定：exp 为空（无释义）且 tries < 3 → 待补全（兼容旧 4 列无状态文件）。
 * 成功：回填 phon/exp，清空 status/tries；失败：tries + 1。
 * 幂等：补全成功后 exp 非空，下次重启不再处理。
 */
export async function retryFailedLocalWords(): Promise<number> {
  const dbg = (m: string) => {
    try {
      Zotero.debug(`[hover-translate-eudic/local] retryFailedLocalWords: ${m}`);
    } catch { /* ignore */ }
  };
  try {
    const entries = await getWords();
    const pending = entries.filter((e: any) =>
      !(e.exp || "").trim() && Number(e.tries || 0) < MAX_TRIES,
    );
    if (pending.length === 0) {
      dbg("no pending word (empty exp & tries<3), done");
      return 0;
    }
    dbg(`found ${pending.length} pending: ${pending.map((p: any) => p.word).join(",")}`);
    localNotify(`正在重试 ${pending.length} 个待处理生词`);

    let done = 0;
    const resultCache = new Map<string, { ok: boolean; result: string; phon: string }>();
    for (const entry of pending) {
      try {
        const word = String(entry.word || "").trim();
        if (!word) continue;
        const key = word.toLowerCase();
        let r = resultCache.get(key);
        if (!r) {
          const res = await translateWordStandalone(word);
          r = {
            ok: res.ok && !!res.result,
            result: res.result || "",
            phon: res.phon || "",
          };
          resultCache.set(key, r);
          dbg(`translate "${word}" → ok=${r.ok} resultLen=${r.result.length}`);
        }
        if (r.ok) {
          const ok = await updateWord(word, {
            phon: r.phon,
            exp: r.result,
            status: "",
            tries: 0,
          });
          if (ok) {
            done++;
            dbg(`completed "${word}"`);
          }
        } else {
          await updateWord(word, { tries: Number(entry.tries || 0) + 1 });
          dbg(`word="${word}" FAILED tries→${Number(entry.tries || 0) + 1}`);
        }
      } catch (e: any) {
        dbg(`word="${entry.word}" error: ${e?.message || e}`);
      }
    }
    dbg(`done, completed=${done}/${pending.length}`);
    return done;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/local] retryFailedLocalWords error: ${e?.message || e}`);
    return 0;
  }
}
