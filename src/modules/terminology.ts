/**
 * 术语库数据层 — 本地术语表 CSV + Zotero 术语库笔记。
 *
 * 本地 CSV 列：term, abbr, exp, add_time, status, tries, src
 *   - abbr: 缩写（选填，1-2 个单词的短术语通常没有，留空不影响提交）
 *   - src:  原文跳转链接（zotero://open-pdf/...）
 * Zotero 笔记：标题「术语库」+ 独立 tag hover-translate-eudic-terminology；
 *   词条无音标行，缩写行替代（缩写为空则不显示）。
 *
 * 与生词本（localWordbook / zoteroNote）完全解耦，互不影响。
 */

import { getPref } from "../utils/prefs";
import {
  buildSourceLink,
  readNoteAttr,
  noteVisibleLines,
  noteMarkedWord,
  noteFirstVisibleWord,
  noteDecodeHtmlDeep,
} from "./zoteroNote";

const DEFAULT_FILENAME = "hover-translate-eudic-terminology.csv";
const CSV_HEADER = "term,abbr,exp,add_time,status,tries,src";
/** 旧版/导出文件 header 前缀：导出功能曾生成 word,abbr,exp 表头，需容忍并升级。 */
const CSV_HEADER_LEGACY_PREFIX = "term,abbr,exp";
/** Zotero 术语库笔记 tag（身份标识，重命名标题不新建笔记）。 */
const TERM_NOTE_TAG = "hover-translate-eudic-terminology";
const TERM_MARKER = "hte-terminology";
const DEFAULT_TITLE = "术语库";
const MAX_TRIES = 3;

/* ------------------------------------------------------------------ */
/*  缩写建议                                                           */
/* ------------------------------------------------------------------ */

/** 常见虚词（缩写提取时跳过）。 */
const SKIP_WORDS = new Set([
  "the", "of", "and", "or", "a", "an", "to", "in", "on", "at",
  "for", "with", "by", "from", "as", "is", "are", "was", "were",
]);

/**
 * 从术语全称自动提取缩写建议（各实词首字母大写拼接）。
 * - 例：`object-oriented programming` → `OOP`
 * - 例：`central processing unit` → `CPU`
 * - 例：`theory of computation` → `TC`（跳过虚词 of）
 * - 实词不足 2 个（如 1 个单词的短术语）→ 返回空串（不自动建议）。
 */
export function suggestAbbr(term: string): string {
  const words = String(term || "")
    .trim()
    .split(/[\s\-/]+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, ""))
    .filter((w) => w.length > 0);
  const content = words.filter((w) => !SKIP_WORDS.has(w.toLowerCase()));
  if (content.length < 2) return "";
  return content.map((w) => w[0].toUpperCase()).join("");
}

/* ------------------------------------------------------------------ */
/*  本地术语表 CSV                                                     */
/* ------------------------------------------------------------------ */

/** Resolve the nsIFile for the local terminology CSV. */
function getTermFile(): any {
  const savePath = (getPref("terminologyLocalSavePath") as string || "").trim();
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
  const dirSvc = (Components as any).classes["@mozilla.org/file/directory_service;1"]
    .getService((Components as any).interfaces.nsIProperties);
  const profileDir = dirSvc.get("ProfD", (Components as any).interfaces.nsIFile);
  profileDir.append(DEFAULT_FILENAME);
  return profileDir;
}

/** Read file as UTF-8 string, stripping BOM. */
async function readContent(file: any): Promise<string> {
  const stripBom = (s: string) => String(s || "").replace(/^\uFEFF/, "");
  if (!file.exists()) return "";
  try {
    return stripBom(String(await Zotero.File.getContentsAsync(file) || ""));
  } catch {
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

/** Parse a CSV line into columns (handles quoted fields). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** First field (term) of a CSV line. */
function extractTermFromLine(line: string): string {
  const t = line.trim();
  if (!t) return "";
  return splitCsvLine(t)[0]?.trim() || "";
}

/**
 * 识别术语表 CSV 表头行（容忍旧版 / 导出文件遗留的 `word,abbr,exp` 表头）。
 * 注意：不直接用 t.startsWith("term") —— "term,abbr,exp" 才是真正的表头，
 * 普通术语行（如 "term of use,..."）不会误判。
 */
function isHeaderLine(line: string): boolean {
  const t = line.trim().replace(/^\uFEFF/, "");
  return t.startsWith(CSV_HEADER_LEGACY_PREFIX) || t.startsWith("word,abbr,exp");
}

/**
 * 规范化存量术语表内容：确保以 UTF-8 BOM + 标准表头开头。
 * - 空内容 → BOM + 标准表头；
 * - 已有旧表头（term,abbr,exp 旧版或 word,abbr,exp 导出残留）→ 替换为标准表头；
 * - 无表头（纯数据行）→ 在开头补标准表头；
 * - 已是标准表头 → 仅补回 BOM。
 */
function normalizeTermContent(content: string): string {
  if (!content) return "\uFEFF" + CSV_HEADER + "\n";
  const lines = content.split("\n");
  const firstLine = (lines[0] || "").replace(/^\uFEFF/, "").trim();
  if (firstLine && isHeaderLine(firstLine) && firstLine !== CSV_HEADER) {
    // 旧表头/导出表头 → 替换为标准表头（数据行原样保留）
    return "\uFEFF" + CSV_HEADER + "\n" + lines.slice(1).join("\n");
  }
  if (firstLine && !isHeaderLine(firstLine)) {
    // 无表头存量数据 → 补标准表头
    return "\uFEFF" + CSV_HEADER + "\n" + content;
  }
  return "\uFEFF" + content;
}

/** Add a term to the local CSV (case-insensitive dedup by term). */
export async function addTerm(params: {
  term: string;
  abbr?: string;
  exp?: string;
  status?: string;
  tries?: number;
  src?: string;
}): Promise<boolean> {
  try {
    const file = getTermFile();
    let content = await readContent(file);
    if (content) {
      for (const line of content.split("\n")) {
        if (isHeaderLine(line)) continue; // 跳过表头行，避免 "term" 等被误判已存在
        const t = extractTermFromLine(line).toLowerCase();
        if (t && t === params.term.toLowerCase()) return true; // already exists
      }
    }
    const add_time = new Date().toISOString().replace("T", " ").slice(0, 19);
    const status = params.status === "failed" ? "failed" : "";
    const tries = params.status === "failed"
      ? Math.max(1, Number(params.tries) || 1)
      : 0;
    const row = [
      esc(params.term),
      esc(params.abbr || ""),
      esc(params.exp || ""),
      esc(add_time),
      esc(status),
      tries ? String(tries) : "",
      esc(params.src || ""),
    ].join(",");
    // 写入前规范化：新文件补 BOM+表头；存量文件若表头缺失/为旧版/导出格式，
    // 一律升级为标准表头（否则 getTerms 会因识别不到表头而跳过全部数据行，
    // 导致面板不显示术语、后续追加的 7 列行与 3 列导出残留混存）。
    content = normalizeTermContent(content);
    if (!content.endsWith("\n")) content += "\n";
    content += row + "\n";
    await Zotero.File.putContentsAsync(file, content, "UTF-8");
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] addTerm error: ${e?.message || e}`);
    return false;
  }
}

/** Read all terms from the local terminology CSV. */
export async function getTerms(): Promise<
  { term: string; abbr: string; exp: string; add_time: string; status: string; tries: number; src: string }[]
> {
  const file = getTermFile();
  const content = await readContent(file);
  if (!content) return [];
  const out: any[] = [];
  let headerSeen = false;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (!headerSeen && isHeaderLine(t)) { headerSeen = true; continue; }
    // 若文件完全无表头（历史遗留 / 手动创建），不整表跳过——把首行当数据解析，
    // 保证面板仍能显示存量术语（修复“添加术语后术语卡片不显示”）。
    const cols = splitCsvLine(t);
    out.push({
      term: cols[0] || "",
      abbr: cols[1] || "",
      exp: cols[2] || "",
      add_time: cols[3] || "",
      status: String(cols[4] || "").trim(),
      tries: Number.parseInt(String(cols[5] || "0"), 10) || 0,
      src: String(cols[6] || "").trim(),
    });
  }
  return out;
}

/** Update a term by its full-list index. */
export async function updateTermByIndex(
  index: number,
  patch: { term?: string; abbr?: string; exp?: string; src?: string },
): Promise<boolean> {
  try {
    const rows = await getTerms();
    if (index < 0 || index >= rows.length) return false;
    const merged = { ...rows[index], ...patch };
    // 重建整表
    const lines = rows.map((r, i) =>
      i === index
        ? [
            esc(merged.term), esc(merged.abbr), esc(merged.exp),
            esc(r.add_time), esc(r.status),
            r.tries ? String(r.tries) : "",
            esc(merged.src || ""),
          ].join(",")
        : [
            esc(r.term), esc(r.abbr), esc(r.exp),
            esc(r.add_time), esc(r.status),
            r.tries ? String(r.tries) : "",
            esc(r.src || ""),
          ].join(","),
    );
    const content = "\uFEFF" + CSV_HEADER + "\n" + lines.join("\n") + "\n";
    await Zotero.File.putContentsAsync(getTermFile(), content, "UTF-8");
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] updateTermByIndex error: ${e?.message || e}`);
    return false;
  }
}

/** Delete a term by its full-list index. */
export async function deleteTermByIndex(index: number): Promise<boolean> {
  try {
    const rows = await getTerms();
    if (index < 0 || index >= rows.length) return false;
    rows.splice(index, 1);
    const lines = rows.map((r) =>
      [
        esc(r.term), esc(r.abbr), esc(r.exp),
        esc(r.add_time), esc(r.status),
        r.tries ? String(r.tries) : "",
        esc(r.src || ""),
      ].join(","),
    );
    const content = "\uFEFF" + CSV_HEADER + "\n" + lines.join("\n") + "\n";
    await Zotero.File.putContentsAsync(getTermFile(), content, "UTF-8");
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] deleteTermByIndex error: ${e?.message || e}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Zotero 术语库笔记                                                  */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Find the first note with the terminology tag. */
async function findTermNote(): Promise<any | null> {
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(userLibID()));
    search.addCondition("itemType", "is", "note");
    search.addCondition("tag", "is", TERM_NOTE_TAG);
    const ids = await search.search();
    for (const id of ids || []) {
      try {
        const note = Zotero.Items.get(id);
        if (note && note.isNote()) return note;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

function userLibID(): number {
  const lib = (Zotero as any).Libraries?.userLibraryID;
  return typeof lib === "number" ? lib : 1;
}

/** Find the terminology note; create with `title` if missing. */
export async function ensureTermNote(title?: string): Promise<any | null> {
  const t = (title || "").trim() || DEFAULT_TITLE;
  const existing = await findTermNote();
  if (existing) return existing;
  try {
    const note = new Zotero.Item("note");
    note.libraryID = userLibID();
    note.setNote(renderTermNoteHTML(t, []));
    note.addTag(TERM_NOTE_TAG);
    await note.saveTx({ notifierData: {} });
    return note;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] create note error: ${e?.message || e}`);
    return null;
  }
}

function formatDateLabel(date: Date): string {
  try {
    return date.toLocaleDateString();
  } catch {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }
}

/** Render one term entry (无音标，缩写行替代；缩写为空不显示该行). */
export function renderTermEntryHTML(w: {
  term: string;
  abbr?: string;
  exp?: string;
  src?: string;
  status?: string;
  tries?: number;
}): string {
  const term = escapeHtml(w.term || "");
  const abbr = (w.abbr || "").trim();
  const exp = (w.exp || "").trim();
  const src = (w.src || "").trim();
  const status = w.status === "completed" || w.status === "failed" ? w.status : "";
  const tries = Number.isInteger(w.tries) ? String(w.tries) : "";

  const attrs = [
    `data-hte-term="${escapeHtml(w.term || "")}"`,
    abbr ? `data-hte-abbr="${escapeHtml(abbr)}"` : "",
    src ? `data-hte-src="${escapeHtml(src)}"` : "",
    status ? `data-hte-status="${status}"` : "",
    tries ? `data-hte-tries="${tries}"` : "",
  ].filter(Boolean).join(" ");

  const icon = status === "failed" ? "❌ " : "";
  const link = src
    ? ` <a href="${escapeHtml(src)}" class="hte-source-link" data-hte-src="${escapeHtml(src)}" title="跳转到原文">↗</a>`
    : "";

  const lines: string[] = [];
  if (abbr) lines.push(`缩写：${escapeHtml(abbr)}`);
  if (exp) lines.push(`释义：${escapeHtml(exp)}`);
  const detail = lines.length ? `<br>${lines.join("<br>")}` : "";

  return `<li ${attrs}>${icon}<strong>${term}</strong>${link}${detail}</li>`;
}

function renderTermNoteHTML(
  title: string,
  entries: {
    term: string;
    abbr?: string;
    exp?: string;
    src?: string;
    status?: string;
    tries?: number;
  }[],
  updatedAt = new Date(),
): string {
  const body = entries.length
    ? entries.map(renderTermEntryHTML).join("")
    : `<li><i>（空）</i></li>`;
  const dateLabel = formatDateLabel(updatedAt);
  const summary = `总计：${entries.length} 个术语 | 更新：${dateLabel}`;
  return [
    `<div class="zotero-note znv1 ${TERM_MARKER}" data-${TERM_MARKER}="1">`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p><i>${escapeHtml(summary)}</i></p>`,
    `<hr><ul>`,
    body,
    `</ul></div>`,
  ].join("");
}

/**
 * 从术语库笔记 HTML 解析词条（容错解析）。
 *
 * 背景：Zotero 9 笔记编辑器保存时会剥离自定义 `data-hte-*` 属性（实测
 * `<li data-hte-term="...">` 保存后只剩 `<strong>term</strong> <a>↗</a>
 * <br>缩写：xxx<br>释义：yyy`），若只依赖属性解析会得到空列表 → 面板
 * 术语卡片不显示、去重失效。因此与生词本 parseNoteHTML 同一策略：
 *   - term: data-hte-term → <strong> 标记文本 → 首个可见英文词
 *   - abbr: data-hte-abbr → 可见「缩写：xxx」行
 *   - exp:  可见「释义：xxx」行（渲染时无对应 data 属性）
 *   - src:  data-hte-src → <a href="zotero://open-pdf...">（深度解码 &）
 *   - status/tries: data 属性
 */
export function parseTermNoteHTML(html: string): {
  term: string; abbr: string; exp: string; src: string; status: string; tries: number;
}[] {
  const out: any[] = [];
  if (!html) return out;
  const seen = new Set<string>();
  // 注意：不能用 DOMParser + li[data-hte-term] —— Zotero 9 已剥离属性；
  // 直接正则匹配所有 <li>，再用可见文本/标记回退解析。
  const matches = String(html).match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
  for (const raw of matches) {
    let term = readNoteAttr(raw, "data-hte-term");
    if (!term) term = noteMarkedWord(raw);
    if (!term) term = noteFirstVisibleWord(noteVisibleLines(raw));
    term = (term || "").trim();
    if (!term) continue;

    let abbr = readNoteAttr(raw, "data-hte-abbr");
    let exp = "";
    for (const line of noteVisibleLines(raw)) {
      const am = line.match(/^缩写[：:]\s*(.*)$/);
      if (am) { if (!abbr) abbr = am[1].trim(); continue; }
      const em = line.match(/^释义[：:]\s*(.*)$/);
      if (em) { exp = em[1].trim(); continue; }
    }
    const src = readNoteAttr(raw, "data-hte-src") ||
      noteDecodeHtmlDeep(raw.match(/href="(zotero:\/\/open-pdf[^"]+)"/i)?.[1] || "");
    let status = readNoteAttr(raw, "data-hte-status");
    if (!status) {
      // 可见符号回退：Zotero 剥离属性后 ❌/✅ 前缀仍保留
      const firstLine = (noteVisibleLines(raw)[0] || "").trim();
      if (firstLine.startsWith("\u274c")) status = "failed";
      else if (firstLine.startsWith("\u2705")) status = "completed";
    }
    const tries = Number.parseInt(readNoteAttr(raw, "data-hte-tries") || "0", 10) || 0;

    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, abbr, exp, src, status, tries });
  }
  return out;
}

/** Add a term to the terminology note. */
export async function addTermToNote(params: {
  title?: string;
  term: string;
  abbr?: string;
  exp?: string;
  src?: string;
  status?: string;
  tries?: number;
}): Promise<boolean> {
  try {
    const note = await ensureTermNote(params.title);
    if (!note) return false;
    await note.reload();
    const entries = parseTermNoteHTML(note.getNote() || "");
    if (entries.some((e) => e.term.toLowerCase() === params.term.toLowerCase())) {
      return true;
    }
    entries.push({
      term: params.term,
      abbr: params.abbr || "",
      exp: params.exp || "",
      src: params.src || "",
      status: params.status === "failed" ? "failed" : "completed",
      tries: params.status === "failed" ? Math.max(1, Number(params.tries) || 1) : 0,
    });
    note.setNote(renderTermNoteHTML(getPref("terminologyNoteTitle") as string || "术语库", entries));
    await note.saveTx({ notifierData: {} });
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] addTermToNote error: ${e?.message || e}`);
    return false;
  }
}

/** Read all terms from the terminology note. */
export async function getTermsFromNote(title?: string): Promise<
  { term: string; abbr: string; exp: string; src: string; status: string; tries: number }[]
> {
  const note = await ensureTermNote(title);
  if (!note) return [];
  try {
    await note.reload();
    return parseTermNoteHTML(note.getNote() || "");
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] getTermsFromNote error: ${e?.message || e}`);
    return [];
  }
}

/** Delete a term from the terminology note. */
export async function deleteTermFromNote(title: string, term: string): Promise<boolean> {
  try {
    const note = await ensureTermNote(title);
    if (!note) return false;
    await note.reload();
    const entries = parseTermNoteHTML(note.getNote() || "").filter(
      (e) => e.term.toLowerCase() !== term.toLowerCase(),
    );
    note.setNote(renderTermNoteHTML(getPref("terminologyNoteTitle") as string || "术语库", entries));
    await note.saveTx({ notifierData: {} });
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] deleteTermFromNote error: ${e?.message || e}`);
    return false;
  }
}

/** Update a term in the terminology note. */
export async function updateTermInNote(
  title: string,
  term: string,
  patch: { term?: string; abbr?: string; exp?: string },
): Promise<boolean> {
  try {
    const note = await ensureTermNote(title);
    if (!note) return false;
    await note.reload();
    const entries = parseTermNoteHTML(note.getNote() || "").map((e) =>
      e.term.toLowerCase() === term.toLowerCase()
        ? {
            ...e,
            term: patch.term || e.term,
            abbr: patch.abbr !== undefined ? patch.abbr : e.abbr,
            exp: patch.exp !== undefined ? patch.exp : e.exp,
          }
        : e,
    );
    note.setNote(renderTermNoteHTML(getPref("terminologyNoteTitle") as string || "术语库", entries));
    await note.saveTx({ notifierData: {} });
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] updateTermInNote error: ${e?.message || e}`);
    return false;
  }
}

/** Open the terminology note for editing. */
export async function openTerminologyNote(): Promise<boolean> {
  try {
    const note = await ensureTermNote();
    if (!note) return false;
    const noteID = Number(note?.id || note?.itemID || 0);
    if (!noteID) return false;
    for (const win of Zotero.getMainWindows()) {
      try {
        if (typeof (win as any).ZoteroPane?.openNoteWindow === "function") {
          (win as any).ZoteroPane.openNoteWindow(noteID);
          return true;
        }
      } catch { /* ignore */ }
    }
    try {
      (Zotero.Notes as any).open(noteID, null, { openInWindow: true });
      return true;
    } catch { /* ignore */ }
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/term] openTerminologyNote error: ${e?.message || e}`);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  统一入口                                                           */
/* ------------------------------------------------------------------ */

/** 术语库平台："local" | "zotero"。 */
export function terminologyPlatform(): "local" | "zotero" {
  return getPref("terminologyPlatform") === "zotero" ? "zotero" : "local";
}

/** 统一添加术语（按平台分发）。返回是否成功（本地去重 / 笔记去重）。 */
export async function addTermToTerminology(params: {
  term: string;
  abbr?: string;
  exp?: string;
  src?: string;
  status?: string;
  tries?: number;
}): Promise<boolean> {
  const platform = terminologyPlatform();
  if (platform === "local") {
    return addTerm(params);
  }
  return addTermToNote({
    title: getPref("terminologyNoteTitle") as string,
    ...params,
  });
}

/** 统一读取术语（按平台分发）。 */
export async function getTerminologyTerms(): Promise<{
  platform: "local" | "zotero";
  terms: { term: string; abbr: string; exp: string; src: string; status: string; tries: number }[];
}> {
  const platform = terminologyPlatform();
  if (platform === "local") {
    const rows = await getTerms();
    return {
      platform,
      terms: rows.map((r) => ({
        term: r.term, abbr: r.abbr, exp: r.exp, src: r.src, status: r.status, tries: r.tries,
      })),
    };
  }
  const rows = await getTermsFromNote(getPref("terminologyNoteTitle") as string);
  return { platform, terms: rows };
}

/** 统一删除术语（按平台分发；index 仅 local 使用，zotero 按 term 匹配）。 */
export async function deleteTerminologyEntry(
  platform: "local" | "zotero",
  idx: number,
  term: string,
): Promise<boolean> {
  if (platform === "local") return deleteTermByIndex(idx);
  return deleteTermFromNote(getPref("terminologyNoteTitle") as string, term);
}

/** 统一更新术语（按平台分发；index 仅 local 使用，zotero 按 term 匹配）。 */
export async function updateTerminologyEntry(
  platform: "local" | "zotero",
  idx: number,
  term: string,
  patch: { term?: string; abbr?: string; exp?: string },
): Promise<boolean> {
  if (platform === "local") return updateTermByIndex(idx, patch);
  return updateTermInNote(getPref("terminologyNoteTitle") as string, term, patch);
}

/** 构建术语的原文跳转链接（复用 zoteroNote.buildSourceLink）。 */
export function buildTermSourceLink(opts: {
  attachmentKey?: string;
  libraryID?: number;
  pageIndex?: number;
  rects?: [number, number, number, number][];
}): string {
  return buildSourceLink(opts);
}
