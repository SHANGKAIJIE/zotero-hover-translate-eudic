/**
 * Zotero Note wordbook platform.
 *
 * Stores words inside a Zotero standalone note whose TITLE is the
 * user-selected wordbook title (default "生词本"). The title is picked
 * from the "选择生词本" dropdown in the preferences panel, and can be
 * managed (add/rename/delete) via the shared edit-wordbook dialog.
 *
 * Note HTML structure (entry format per requirements):
 *
 *   <div class="zotero-note znv1 hte-wordbook" data-hte-wordbook="1">
 *     <h1>{title}</h1>
 *     <p><i>总计：N 个生词 | 更新：2026/8/7</i></p>
 *     <hr><ul>
 *       <li data-hte-word="material" data-hte-phon="/məˈtɪriəl/"
 *           data-hte-src="zotero://open-pdf/...">
 *         <strong>material</strong> <a href="zotero://open-pdf/..." class="hte-source-link">↗</a>
 *         <br>音标：/məˈtɪriəl/
 *         <br>释义：n. 材料；原料；素材；布料； adj. 物质的；客观存在的；重要的；必要的；
 *       </li>
 *     </ul></div>
 *
 * IMPORTANT (Zotero note HTML normalization):
 * Zotero's note editor sanitizes/normalizes HTML when saving. Custom
 * `data-*` attributes are usually preserved, but to be robust the parser
 * falls back to visible text (<strong> word, first visible English word)
 * exactly like the reference project zotero-vocab-builder. Entries are
 * rendered with <strong> around the word so they can always be recovered.
 *
 * Source links (↗) do NOT auto-navigate in Zotero notes: a click listener
 * must be attached to the note editor iframe (see attachNoteEditorLinks),
 * which intercepts zotero://open-pdf links and opens the PDF reader.
 */

import { toLemma } from "./lemmatize";

const NOTE_TAG = "hover-translate-eudic-wordbook";
const MARKER_CLASS = "hte-wordbook";
const DEFAULT_TITLE = "生词本";

/** 注释中翻译失败的离线提示文案（与 annotationSync.ts 写入的一致，可整体替换）。 */
const OFFLINE_HINTS = ["\u274c 联网重启后自动重试补全，也可手动更改"];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function userLibID(): number {
  try {
    return (Zotero.Libraries as any).userLibraryID;
  } catch {
    return 1;
  }
}

function noteTitle(note: any): string {
  try {
    return String(note?.getField?.("title") || note?.getNoteTitle?.() || "");
  } catch {
    return "";
  }
}

function isNote(item: any): boolean {
  return !!item && typeof item.isNote === "function" && item.isNote();
}

function escapeHtml(value: string): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeHtml(value: string): string {
  if (!value) return "";
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
/**
 * 深度解码 HTML 实体：反复解码直到不再变化。
 *
 * 背景：Zotero 9 每次保存笔记时会对属性值中的 `&` 重新转义（实测多次
 * saveTx 后 href 中的 `&` 累积为 `&amp;` → `&amp;amp;` → `&amp;amp;amp;`），
 * 若解析时只解码一层，再配合渲染时的 escapeHtml 会继续累积，最终损坏
 * `position` 查询参数（URLSearchParams 无法再提取）。深解码可把任意层数
 * 的累积转义一次性还原为真实 URL。
 */
function decodeHtmlDeep(value: string): string {
  if (!value) return "";
  let prev = value;
  for (let i = 0; i < 10; i++) {
    const next = decodeHtml(prev);
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

/** 导出给术语库(terminology.ts)等模块复用：属性读取/可见行/标记词/首词回退。 */
export function readNoteAttr(rawHTML: string, attrName: string): string {
  const pattern = new RegExp(`${attrName}="([^"]*)"`, "i");
  return decodeHtmlDeep(rawHTML.match(pattern)?.[1] || "");
}

/** 可见文本，<br> 作为换行（按行返回，去标签/解码/去空白）。 */
export function noteVisibleLines(rawHTML: string): string[] {
  return rawHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((s) => decodeHtml(s).trim())
    .filter(Boolean);
}

/** 从 <strong>/<b> 标记中读取词（可在属性被剥离后存活）。 */
export function noteMarkedWord(rawHTML: string): string {
  const match = rawHTML.match(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/i);
  return decodeHtml(match?.[1] || "").trim();
}

/** 条目可见文本中的首个英文词（最终回退）。 */
export function noteFirstVisibleWord(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/[a-zA-Z][a-zA-Z'\-]*(?: [a-zA-Z][a-zA-Z'\-]*)?/);
    if (m) return m[0].trim();
  }
  return "";
}

/** 深度解码 HTML 实体（Zotero 9 多次保存会累积 &amp; 转义）。 */
export function noteDecodeHtmlDeep(value: string): string {
  if (!value) return "";
  let prev = value;
  for (let i = 0; i < 10; i++) {
    const next = decodeHtml(prev);
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

/** 简单的延时（毫秒）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateLabel(date: Date): string {
  try {
    return date.toLocaleDateString();
  } catch {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }
}

/* ------------------------------------------------------------------ */
/*  Note lookup / creation                                             */
/* ------------------------------------------------------------------ */

/**
 * Find the FIRST note with our tag, regardless of its current title.
 * (Requirement: renaming the note must NOT create a new note — the tag
 * is the identity, the title is cosmetic and gets restored on write.)
 */
async function findNoteByTag(): Promise<any | null> {
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(userLibID()));
    search.addCondition("itemType", "is", "note");
    search.addCondition("tag", "is", NOTE_TAG);
    const ids = await search.search();
    for (const id of ids || []) {
      try {
        const note = Zotero.Items.get(id);
        if (isNote(note)) return note;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Find the wordbook note (by tag); create it with `title` if missing.
 * Returns the note item, or null on failure.
 */
export async function ensureNoteByTitle(title: string): Promise<any | null> {
  const trimmed = (title || "").trim() || DEFAULT_TITLE;
  const existing = await findNoteByTag();
  if (existing) return existing;

  try {
    const note = new Zotero.Item("note");
    note.libraryID = userLibID();
    note.setNote(renderNoteHTML(trimmed, []));
    note.addTag(NOTE_TAG);
    // notifierData 抑制事件循环：Zotero 9 中 saveTx 若不抑制，
    // 笔记编辑器/其他监听器会响应 item 变更导致卡死（参考项目同款写法）。
    await note.saveTx({ notifierData: {} });
    return note;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] create note error: ${e?.message || e}`);
    return null;
  }
}

/** List existing notes (with our tag) as {id, name} for the edit dialog. */
export async function listNotes(): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(userLibID()));
    search.addCondition("itemType", "is", "note");
    search.addCondition("tag", "is", NOTE_TAG);
    const ids = await search.search();
    for (const id of ids || []) {
      try {
        const note = Zotero.Items.get(id);
        if (!isNote(note)) continue;
        const t = noteTitle(note).trim() || `笔记 ${id}`;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({ id: String(id), name: t });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}

/** Create a new note wordbook (edit dialog "添加"). */
export async function createNoteWordbook(name: string): Promise<boolean> {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  const note = await ensureNoteByTitle(trimmed);
  return !!note;
}

/** Rename a note wordbook (edit dialog "重命名"). */
export async function renameNoteWordbook(
  id: string,
  _currentName: string,
  newName: string,
): Promise<boolean> {
  const trimmed = (newName || "").trim();
  if (!trimmed) return false;
  try {
    const note = Zotero.Items.get(Number(id));
    if (!isNote(note)) return false;
    try {
      note.setField("title", trimmed);
    } catch { /* ignore */ }
    // Also update the <h1> inside the note body so noteTitle() stays in sync.
    const html = note.getNote() || "";
    const newHtml = html.replace(/<h1>[\s\S]*?<\/h1>/i, `<h1>${escapeHtml(trimmed)}</h1>`);
    note.setNote(newHtml || html);
    await note.saveTx({ notifierData: {} });
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] rename error: ${e?.message || e}`);
    return false;
  }
}

/** Delete a note wordbook (edit dialog "删除"). */
export async function deleteNoteWordbook(
  id: string,
  _name: string,
): Promise<boolean> {
  try {
    const note = Zotero.Items.get(Number(id));
    if (!isNote(note)) return false;
    await note.eraseTx();
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] delete error: ${e?.message || e}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  HTML rendering                                                     */
/* ------------------------------------------------------------------ */

/** 状态图标：仅 failed 渲染 ❌（completed 不显示图标，用户要求）。 */
const STATUS_SYMBOLS: Record<string, string> = {
  failed: "\u274c",
};

/**
 * Render a single entry.
 *
 * Requirement format (word + jump link, then phonetics line, then meaning):
 *   material ↗
 *   音标：/məˈtɪriəl/
 *   释义：n. 材料；...
 *
 * No ellipsis prefix. `src` is a `zotero://open-pdf/...` link rendered as an
 * ↗ anchor next to the word. The word is wrapped in <strong> so it can be
 * recovered even if data attributes are stripped by Zotero's sanitizer.
 * `status` ("pending" | "completed" | "failed") renders an error/success icon
 * before the word (failed ❌ / completed ✅ / pending none).
 */
export function renderEntryHTML(w: {
  word: string;
  phon?: string;
  exp?: string;
  src?: string;
  status?: string;
  tries?: number;
}): string {
  const word = escapeHtml(w.word || "");
  const phon = (w.phon || "").trim();
  const exp = (w.exp || "").trim();
  const src = (w.src || "").trim();
  const status = w.status === "completed" || w.status === "failed" ? w.status : "";
  const tries = Number.isInteger(w.tries) ? String(w.tries) : "";

  const attrs = [
    `data-hte-word="${escapeHtml(w.word || "")}"`,
    phon ? `data-hte-phon="${escapeHtml(phon)}"` : "",
    src ? `data-hte-src="${escapeHtml(src)}"` : "",
    status ? `data-hte-status="${status}"` : "",
    tries ? `data-hte-tries="${tries}"` : "",
  ].filter(Boolean).join(" ");

  const icon = STATUS_SYMBOLS[status] ? `${STATUS_SYMBOLS[status]} ` : "";
  const link = src
    ? ` <a href="${escapeHtml(src)}" class="hte-source-link" data-hte-src="${escapeHtml(src)}" title="跳转到原文">↗</a>`
    : "";

  const lines: string[] = [];
  if (phon) lines.push(`音标：${escapeHtml(phon)}`);
  if (exp) lines.push(`释义：${escapeHtml(exp)}`);
  const detail = lines.length ? `<br>${lines.join("<br>")}` : "";

  return `<li ${attrs}>${icon}<strong>${word}</strong>${link}${detail}</li>`;
}

function renderNoteHTML(
  title: string,
  entries: {
    word: string;
    phon?: string;
    exp?: string;
    src?: string;
    status?: string;
    tries?: number;
  }[],
  updatedAt = new Date(),
): string {
  const body = entries.length
    ? entries.map(renderEntryHTML).join("")
    : `<li><i>（空）</i></li>`;
  const dateLabel = formatDateLabel(updatedAt);
  const summary = `总计：${entries.length} 个生词 | 更新：${dateLabel}`;
  return [
    `<div class="zotero-note znv1 ${MARKER_CLASS}" data-${MARKER_CLASS}="1">`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p><i>${escapeHtml(summary)}</i></p>`,
    `<hr><ul>`,
    body,
    `</ul></div>`,
  ].join("");
}

/* ------------------------------------------------------------------ */
/*  Parsing (multi-level fallback like the reference project)          */
/* ------------------------------------------------------------------ */

function readAttr(rawHTML: string, attrName: string): string {
  const pattern = new RegExp(`${attrName}="([^"]*)"`, "i");
  return decodeHtmlDeep(rawHTML.match(pattern)?.[1] || "");
}

/** Visible text with <br> as newlines (per line). */
function visibleLines(rawHTML: string): string[] {
  return rawHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((s) => decodeHtml(s).trim())
    .filter(Boolean);
}

/** Read word from <strong>/<b> markup (survives attribute stripping). */
function readMarkedWord(rawHTML: string): string {
  const match = rawHTML.match(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/i);
  return decodeHtml(match?.[1] || "").trim();
}

/** First visible English word in the entry text. */
function readFirstVisibleWord(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/[a-zA-Z][a-zA-Z'\-]*(?: [a-zA-Z][a-zA-Z'\-]*)?/);
    if (m) return m[0].trim();
  }
  return "";
}

/**
 * Parse a note HTML into entries.
 * Word resolution order: data-hte-word → data-vb-word → <strong> → first word.
 * phon/exp resolved from data attrs first, then visible "音标：/释义：" lines.
 * src resolved from data-hte-src, data-vb-src, or <a href="zotero://...">.
 */
export function parseNoteHTML(html: string): {
  word: string;
  phon: string;
  exp: string;
  src: string;
  status: string;
  tries: number;
}[] {
  if (!html) return [];
  const entries: {
    word: string;
    phon: string;
    exp: string;
    src: string;
    status: string;
    tries: number;
  }[] = [];
  const seen = new Set<string>();
  const matches = html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];

  for (const raw of matches) {
    let word = readAttr(raw, "data-hte-word") || readAttr(raw, "data-vb-word");
    if (!word) {
      // Visible-text fallback (Zotero may strip data attributes)
      word = readMarkedWord(raw);
    }
    if (!word) {
      word = readFirstVisibleWord(visibleLines(raw));
    }
    word = word.trim();

    let phon = readAttr(raw, "data-hte-phon")
      || readAttr(raw, "data-vb-phone")
      || readAttr(raw, "data-vb-phon");
    let exp = readAttr(raw, "data-vb-def") || readAttr(raw, "data-vb-trans") || "";
    const src = readAttr(raw, "data-hte-src")
      || readAttr(raw, "data-vb-src")
      // href 回退必须深解码：Zotero 9 多次保存后 href 中的 `&` 会累积转义
      // （&amp; → &amp;amp; → …），只解码一层会继续累积并损坏 position 参数。
      || decodeHtmlDeep(raw.match(/href="(zotero:\/\/open-pdf[^"]+)"/i)?.[1] || "");
    let status = readAttr(raw, "data-hte-status")
      || readAttr(raw, "data-vb-status") || "";
    if (!status) {
      // 可见文本 fallback：Zotero 保存笔记时会剥离 data-* 属性，但可见符号
      // 前缀（❌/✅）会保留 —— 与参考项目 zotero-vocab-builder 的状态符号
      // 策略一致，保证重启后仍能识别失败词并重试。
      const firstLine = (visibleLines(raw)[0] || "").trim();
      if (firstLine.startsWith("\u274c")) status = "failed";
      else if (firstLine.startsWith("\u2705")) status = "completed";
    }
    const tries = Number.parseInt(
      readAttr(raw, "data-hte-tries") || readAttr(raw, "data-vb-tries") || "0",
      10,
    ) || 0;

    // Parse visible "音标：" / "释义：" lines (our format)
    for (const line of visibleLines(raw)) {
      const pm = line.match(/^音标[：:]\s*([\s\S]+)$/);
      if (pm) { phon = pm[1].trim(); continue; }
      const em = line.match(/^释义[：:]\s*([\s\S]+)$/);
      if (em) { exp = em[1].trim(); continue; }
    }

    const key = word.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({ word, phon, exp, src, status, tries });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build a `zotero://open-pdf/...` jump link to the source location.
 * Mirrors the reference project's reader source link format, including the
 * `position` param (JSON: {pageIndex, rects}) for precise navigation.
 */
export function buildSourceLink(opts: {
  attachmentKey?: string;
  libraryID?: number;
  pageIndex?: number;
  rects?: [number, number, number, number][];
}): string {
  try {
    const key = (opts.attachmentKey || "").trim();
    if (!key) return "";
    const libID = opts.libraryID ?? userLibID();
    let libraryPath = "library";
    try {
      const path = Zotero.URI.getLibraryPath(libID);
      if (path && !/^users\//i.test(path)) libraryPath = path;
    } catch { /* ignore */ }
    const params: string[] = [];
    if (Number.isInteger(opts.pageIndex) && (opts.pageIndex as number) >= 0) {
      params.push(`page=${(opts.pageIndex as number) + 1}`);
      // position: {pageIndex, rects} — 供 Zotero.Reader.open 精确定位并高亮。
      // rects 为 PDF 用户坐标两点式 [x1,y1,x2,y2]（与注释 position.rects 同源：
      // wordLocator 的 LocatedWord.rects / 注释 annotation.position.rects）。
      // 注意：不能按 [x,y,w,h] 再做转换 —— 传入的 rects 已是两点式，
      // 再转换会把 x2/y2 变成 x1+x2 / y1+y2，导致跳转位置错误。
      const rects = (opts.rects || []).map(
        (r) => [r[0], r[1], r[2], r[3]] as [number, number, number, number],
      );
      const position = { pageIndex: opts.pageIndex as number, rects };
      params.push(`position=${encodeURIComponent(JSON.stringify(position))}`);
    }
    const qs = params.length ? `?${params.join("&")}` : "";
    return `zotero://open-pdf/${libraryPath}/items/${encodeURIComponent(key)}${qs}`;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] buildSourceLink error: ${e?.message || e}`);
    return "";
  }
}

/**
 * Append a word to the note (dedup by case-insensitive word).
 * @returns true if saved or already present; false on error.
 */
export async function addWordToNote(params: {
  title: string;
  word: string;
  phon?: string;
  exp?: string;
  src?: string;
  status?: string;
  tries?: number;
}): Promise<boolean> {
  try {
    const note = await ensureNoteByTitle(params.title);
    if (!note) return false;
    await note.reload();

    const html = note.getNote() || "";
    const entries = parseNoteHTML(html);

    const cleaned = (params.word || "").trim();
    if (!cleaned) return false;
    if (entries.some((e) => e.word.toLowerCase() === cleaned.toLowerCase())) {
      return true; // already present, not an error
    }

    // 新词插入到列表最前面（需求：新加入的生词放在前面，参考参考项目）
    entries.unshift({
      word: cleaned,
      phon: params.phon || "",
      exp: params.exp || "",
      src: params.src || "",
      status: params.status || "",
      tries: params.tries || 0,
    });

    // 标题固定用传入的 title（生词本名），即使笔记被手动改名也还原为生词本名
    note.setNote(renderNoteHTML(params.title || DEFAULT_TITLE, entries));
    // notifierData 抑制事件循环，避免 Zotero 9 卡死（参考项目同款写法）
    await note.saveTx({ notifierData: {} });
    Zotero.debug(`[hover-translate-eudic/note] saved word: "${cleaned}" (total ${entries.length})`);
    // 翻译失败（如离线）时弹窗提醒，联网重启后 Zotero 会自动重试补全
    if (params.status === "failed") {
      pwNotify(`已添加，联网重启后自动重试补全：${cleaned}`, "info");
    }
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] addWordToNote error: ${e?.message || e}`);
    return false;
  }
}

/**
 * 按 word（大小写不敏感）删除笔记中的词条（生词本面板删除用）。
 * 删除后重写整篇笔记；找不到返回 false。
 */
export async function deleteWordFromNote(title: string, word: string): Promise<boolean> {
  try {
    const note = await ensureNoteByTitle(title);
    if (!note) return false;
    await note.reload();

    const entries = parseNoteHTML(note.getNote() || "");
    const target = String(word || "").trim().toLowerCase();
    const before = entries.length;
    const kept = entries.filter((e) => e.word.toLowerCase() !== target);
    if (kept.length === before) return false; // not found

    note.setNote(renderNoteHTML(title, kept));
    await note.saveTx({ notifierData: {} });
    Zotero.debug(`[hover-translate-eudic/note] deleted word: "${word}" (total ${kept.length})`);
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] deleteWordFromNote error: ${e?.message || e}`);
    return false;
  }
}

/**
 * 按 word（大小写不敏感）更新笔记中的词条（生词本面板编辑用）。
 * patch 中未提供的字段保持原值；找不到返回 false。
 */
export async function updateWordInNote(
  title: string,
  word: string,
  patch: { word?: string; phon?: string; exp?: string; src?: string },
): Promise<boolean> {
  try {
    const note = await ensureNoteByTitle(title);
    if (!note) return false;
    await note.reload();

    const entries = parseNoteHTML(note.getNote() || "");
    const target = String(word || "").trim().toLowerCase();
    let changed = false;
    const updated = entries.map((e) => {
      if (e.word.toLowerCase() !== target) return e;
      changed = true;
      return {
        word: patch.word !== undefined ? patch.word : e.word,
        phon: patch.phon !== undefined ? patch.phon : e.phon,
        exp: patch.exp !== undefined ? patch.exp : e.exp,
        src: patch.src !== undefined ? patch.src : e.src,
        status: e.status,
        tries: e.tries,
      };
    });
    if (!changed) return false;

    note.setNote(renderNoteHTML(title, updated));
    await note.saveTx({ notifierData: {} });
    Zotero.debug(`[hover-translate-eudic/note] updated word: "${word}" (total ${updated.length})`);
    return true;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] updateWordInNote error: ${e?.message || e}`);
    return false;
  }
}

/** Read all entries from the note. */
export async function getWordsFromNote(title: string): Promise<
  { word: string; phon: string; exp: string; add_time: string; src: string }[]
> {
  const note = await ensureNoteByTitle(title);
  if (!note) return [];
  try {
    await note.reload();
    const entries = parseNoteHTML(note.getNote() || "");
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    return entries.map((e) => ({ word: e.word, phon: e.phon, exp: e.exp, add_time: now, src: e.src }));
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] getWordsFromNote error: ${e?.message || e}`);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Annotation sync (编辑/删除时同步注释)                               */
/* ------------------------------------------------------------------ */

/**
 * 枚举当前库中所有注释，返回文本匹配该单词（词形还原感知）的注释数组。
 * 供编辑 / 删除生词时同步注释使用。
 * @param tagFilter 可选：仅返回带指定 tag 的注释（术语注释用 terminologyTagName
 *   过滤，避免误伤同名词条的生词注释；不传则匹配全部）。
 */
async function findAnnotationsByWord(word: string, tagFilter?: string): Promise<any[]> {
  const out: any[] = [];
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(userLibID()));
    search.addCondition("itemType", "is", "annotation");
    const ids = await search.search();
    for (const id of ids || []) {
      let ann: any;
      try {
        ann = Zotero.Items.get(id);
      } catch { continue; }
      if (!ann || ann.itemType !== "annotation") continue;
      if (tagFilter) {
        const tags = ((ann.getTags && ann.getTags()) as Array<{ tag: string }>) || [];
        if (!tags.some((t) => t.tag === tagFilter)) continue;
      }
      const text = String(ann.annotationText || "");
      if (!annotationTextMatchesWord(text, word)) continue;
      out.push(ann);
    }
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] findAnnotationsByWord error: ${e?.message || e}`);
  }
  return out;
}

/**
 * 编辑生词时同步更新注释（幂等，容错）。
 *
 * 匹配策略：注释 text 与旧单词精确 / 词形还原匹配（annotationTextMatchesWord，
 * 同一生词多个注释全部更新，不提前 return）。
 *
 * 更新内容：
 *  - text 中的单词部分 → 新单词（body 模式下 text 为 "翻译\n单词" 或
 *    "单词\n翻译"，仅替换单词 token；comment 模式下 text 即为单词）
 *  - comment（翻译）→ 新释义（仅当旧释义非空时替换，避免误伤）
 *
 * @param oldWord 旧单词（面板中的词条名）
 * @param patch   新内容（word / exp 可选；只更新提供的字段）
 * @param oldExp  旧释义（编辑前的 exp，供释义替换）
 * @param tagFilter 可选：仅更新带指定 tag 的注释（术语场景传术语 tag）
 * @returns 成功更新的注释数
 */
export async function updateAnnotationsForWord(
  oldWord: string,
  patch: { word?: string; exp?: string },
  oldExp?: string,
  tagFilter?: string,
): Promise<number> {
  const dbg = (m: string) => {
    try {
      Zotero.debug(`[hover-translate-eudic/note] updateAnnotationsForWord: ${m}`);
    } catch { /* ignore */ }
  };
  let updated = 0;
  try {
    const anns = await findAnnotationsByWord(oldWord, tagFilter);
    dbg(`word="${oldWord}" matched ${anns.length} annotation(s)`);
    const newWord = (patch.word || "").trim();
    const newExp = (patch.exp || "").trim();
    for (const ann of anns) {
      try {
        let changed = false;
        let text = String(ann.annotationText || "");
        let comment = String(ann.annotationComment || "");
        // 1) 单词更新：仅当新单词与旧单词不同且非空（词形还原感知匹配）
        if (newWord && newWord.toLowerCase() !== oldWord.trim().toLowerCase()) {
          const newText = replaceWordTokenInText(text, oldWord, newWord);
          if (newText !== text) {
            text = newText;
            changed = true;
          }
          // comment 若含单词（wordPosition=comment 时 comment="单词\n翻译"）也替换
          const newComment = replaceWordTokenInText(comment, oldWord, newWord);
          if (newComment !== comment) {
            comment = newComment;
            changed = true;
          }
        }
        // 2) 释义更新：用旧释义（调用方传入，即面板编辑前的 exp）替换为新释义。
        //    comment 模式翻译在 comment；body 模式翻译嵌入 text（"翻译\n单词"）。
        if (newExp && oldExp !== undefined) {
          const oe = String(oldExp || "").trim();
          if (oe) {
            // 优先在 comment 中替换（comment 模式；或 wordPosition=comment 的 "单词\n翻译"）
            const replacedC = replaceTranslationInComment(comment, oe, newExp);
            if (replacedC !== comment) {
              comment = replacedC;
              changed = true;
            } else {
              // comment 无匹配 → body 模式：替换 text 中的旧释义子串
              if (text.includes(oe)) {
                const newText = text.split(oe).join(newExp);
                if (newText !== text) {
                  text = newText;
                  changed = true;
                }
              } else {
                // 旧释义完全找不到 → 尝试整体替换 text 中的翻译行
                const oldBodyExp = extractTranslationFromBodyText(text);
                if (oldBodyExp) {
                  const newText = replaceTranslationInComment(text, oldBodyExp, newExp);
                  if (newText !== text) {
                    text = newText;
                    changed = true;
                  }
                }
              }
            }
          } else if (comment) {
            // 旧释义为空（离线提示等）：把 comment 整段替换为新释义
            const newComment = replaceTranslationInComment(comment, "", newExp);
            if (newComment !== comment) {
              comment = newComment;
              changed = true;
            }
          }
        }
        if (!changed) continue;
        ann.annotationText = text;
        ann.annotationComment = comment;
        await ann.saveTx({ notifierData: {} });
        updated++;
        dbg(`updated ann id=${ann.id} for "${oldWord}"`);
      } catch (e: any) {
        dbg(`update failed for ann id=${ann.id}: ${e?.message || e}`);
      }
    }
    dbg(`word="${oldWord}" done, updated=${updated}`);
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] updateAnnotationsForWord error: ${e?.message || e}`);
  }
  return updated;
}

/**
 * 删除生词时同步删除匹配的注释（幂等，容错）。
 * 同一生词多个注释（不同页码/位置）全部删除。
 * @param tagFilter 可选：仅删除带指定 tag 的注释（术语场景传术语 tag）
 * @returns 成功删除的注释数
 */
export async function deleteAnnotationsForWord(word: string, tagFilter?: string): Promise<number> {
  const dbg = (m: string) => {
    try {
      Zotero.debug(`[hover-translate-eudic/note] deleteAnnotationsForWord: ${m}`);
    } catch { /* ignore */ }
  };
  let deleted = 0;
  try {
    const anns = await findAnnotationsByWord(word, tagFilter);
    dbg(`word="${word}" matched ${anns.length} annotation(s)`);
    for (const ann of anns) {
      try {
        await ann.eraseTx({ notifierData: {} });
        deleted++;
        dbg(`deleted ann id=${ann.id} for "${word}"`);
      } catch (e: any) {
        dbg(`delete failed for ann id=${ann.id}: ${e?.message || e}`);
      }
    }
    dbg(`word="${word}" done, deleted=${deleted}`);
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] deleteAnnotationsForWord error: ${e?.message || e}`);
  }
  return deleted;
}

/** 在注释文本中替换单词 token（body 模式 "翻译\n单词" 只替换单词行）。 */
/**
 * 在注释文本中替换单词 token。
 * 匹配：整行精确等于旧单词，或词形还原后等于旧单词（注释保存的是原文
 * 屈折形式如 "gaps"，面板词条是词形还原后的原形 "gap"——必须 toLemma
 * 匹配才能替换成功，这是编辑同步生效的关键）。
 * body 模式 "翻译\n单词" 中翻译行不会误伤（仅当行内单词独立成词时）。
 */
function replaceWordTokenInText(text: string, oldWord: string, newWord: string): string {
  const lines = String(text || "").split("\n");
  const ow = String(oldWord || "").trim().toLowerCase();
  const changed = lines.map((line) => {
    const l = String(line || "");
    const lt = l.trim().toLowerCase();
    // 整行就是单词（精确或词形还原匹配）
    if (lt === ow || toLemma(lt).toLowerCase() === ow) {
      return l.trim() ? l.replace(l.trim(), newWord) : l;
    }
    return l;
  });
  const out = changed.join("\n");
  return out;
}

/** 从 body 模式注释 text（"翻译\n单词" 或 "单词\n翻译"）提取翻译部分（非单词的行）。 */
function extractTranslationFromBodyText(text: string): string {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return "";
  // 单词行：最后一个英文单词 token（body 模式单词在首或尾行）
  const isWordLike = (s: string): boolean => /^[a-zA-Z][a-zA-Z'\-]*$/.test(s);
  // 找单词行：最后一个看起来是纯单词的行
  let wordLineIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isWordLike(lines[i])) {
      wordLineIdx = i;
      break;
    }
  }
  if (wordLineIdx < 0) return "";
  const transLines = lines.filter((_, i) => i !== wordLineIdx);
  return transLines.join("\n");
}

/**
 * 替换注释中的旧释义为新释义。
 *
 * 匹配策略（宽松但安全）：在 comment（或 body 模式的 text）中查找旧释义
 * 子串；若旧释义找不到（用户可能把释义改得面目全非），则把整段翻译行
 * 替换为新释义（wordPosition=comment 时 comment="单词\n翻译" 保留单词行）。
 */
function replaceTranslationInComment(comment: string, oldExp: string, newExp: string): string {
  const lines = String(comment || "").split("\n");
  const isWordLike = (s: string): boolean => /^[a-zA-Z][a-zA-Z'\-]*$/.test(s);
  const oe = String(oldExp || "").trim();
  const ne = String(newExp || "").trim();

  // 1) 先尝试精确替换：整段 comment 就是旧释义 → 直接换成新释义
  if (comment.trim() === oe) return ne;
  // 2) 整段 comment 含旧释义子串 → 整体替换该子串
  if (oe && comment.includes(oe)) return comment.split(oe).join(ne);
  // 3) 逐行处理（"单词\n翻译" 等）：跳过单词行，翻译行整体替换为新释义
  const changed = lines.map((line) => {
    const l = String(line || "");
    if (isWordLike(l.trim())) return l; // 单词行不动
    // 翻译行：若含旧释义子串替换；否则整行替换为新释义
    if (oe && l.includes(oe)) return l.split(oe).join(ne);
    return ne;
  });
  return changed.join("\n");
}

/**
 * Open the note for editing ("打开笔记" button).
 */
export async function openNoteForEditing(title: string): Promise<boolean> {
  const note = await ensureNoteByTitle(title);
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
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] openNoteForEditing error: ${e?.message || e}`);
    return false;
  }
}

/**
 * Resolve the effective note title.
 * Requirement: the note name is FIXED to the default（生词本）— renaming the
 * note in Zotero does not create a new note (identity = tag), and the title
 * is restored on every write.
 */
export function getNoteTitle(): string {
  return DEFAULT_TITLE;
}

/* ------------------------------------------------------------------ */
/*  Source-link navigation (↗ click in the note editor)                */
/* ------------------------------------------------------------------ */

/** Parse `zotero://open-pdf/{lib}/items/{key}?page=N&position={json}`.
 *  兼容无参数链接（`zotero://open-pdf/library/items/KEY`，旧版/定位失败时
 *  生成的 src 无 `?page=` 参数）：v0.3.5 修复——正则 `\?(.+)$` 强制要求参数，
 *  无参数链接解析失败返回 null，导致 `resolveSrcItemID`=0、「当前条目」视图
 *  下 srcBelongsToItem(0, itemID) 恒 false → 面板全部词条被过滤（空面板）。 */
export function parseSourceLink(src: string): {
  itemID: number;
  pageIndex: number;
  position: any;
} | null {
  try {
    // 深解码：DOM 属性值只还原一层实体，存储多次转义后（&amp;amp;…）必须
    // 全部还原，否则 URLSearchParams 会把 "amp;position" 当成独立参数，
    // 导致 position 丢失、跳转退化为仅翻页（无精确位置、无高亮）。
    const cleaned = decodeHtmlDeep(String(src || "").trim());
    const match = cleaned.match(
      /^zotero:\/\/open-pdf\/(.+?)\/items\/([A-Z0-9]{8})(?:\?(.+))?$/i,
    );
    if (!match) return null;
    const libraryPath = decodeURIComponent(match[1]);
    const itemKey = decodeURIComponent(match[2]);
    const params = new URLSearchParams(match[3] || "");
    const page = Number(params.get("page") || "0");
    const pageIndex = Number.isFinite(page) && page > 0 ? page - 1 : 0;
    let position: any = null;
    try {
      const raw = params.get("position");
      if (raw) position = JSON.parse(raw);
    } catch { /* ignore */ }

    const libraryID =
      libraryPath === "library"
        ? userLibID()
        : Number((Zotero.URI.getPathLibrary(libraryPath) as any)?.libraryID || 0);
    if (!libraryID) return null;

    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey) as any;
    const itemID = Number(item?.id || item?.itemID || 0);
    if (!itemID) return null;
    return { itemID, pageIndex, position };
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] parseSourceLink error: ${e?.message || e}`);
    return null;
  }
}

/**
 * 按 itemID 查找已打开的 reader 实例。
 * 兼容 Zotero.Reader._readers 的多种形态（数组 / 键值对象 / Map）。
 */
function getReaderByItemID(itemID: number): any | null {
  try {
    const readers = (Zotero.Reader as any)?._readers;
    if (!readers) return null;
    let list: any[];
    if (Array.isArray(readers)) {
      list = readers;
    } else if (typeof Map !== "undefined" && readers instanceof Map) {
      list = Array.from(readers.values());
    } else {
      list = Object.values(readers);
    }
    return (
      list.find((entry) => {
        const reader = entry?.tabID ? Zotero.Reader.getByTabID(entry.tabID) : entry;
        return Number(reader?.itemID || reader?._item?.id || 0) === itemID;
      }) || null
    );
  } catch { /* ignore */ }
  return null;
}

/** 轮询等待某个 PDF 的 reader 实例出现（最多 ~3.6s）。 */
async function waitForReaderByItemID(itemID: number): Promise<any | null> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const reader = getReaderByItemID(itemID);
    if (reader) return reader;
    await sleep(120);
  }
  return null;
}

/**
 * 通过 reader 的原生 find 状态触发高亮（Zotero 内部 primaryViewFindState /
 * secondaryViewFindState 机制，参考 zotero-vocab-builder 的
 * triggerNativeReaderFind）。返回是否成功触发。
 */
async function triggerNativeReaderFind(reader: any, query: string): Promise<boolean> {
  const internalReader = reader?._internalReader || reader;
  if (!internalReader) return false;

  const primary = internalReader._lastViewPrimary ?? true;
  const stateKey = primary ? "primaryViewFindState" : "secondaryViewFindState";
  const view = primary ? internalReader._primaryView : internalReader._secondaryView;
  if (!view) return false;

  try {
    await view.initializedPromise;
  } catch { /* ignore */ }

  const baseState = {
    popupOpen: internalReader?._state?.[stateKey]?.popupOpen ?? false,
    active: true,
    query,
    // entireWord=false：笔记中保存的是词形还原后的原形（fill），
    // 但 PDF 原文是屈折形式（filling），子串匹配才能高亮到同一位置。
    entireWord: false,
    highlightAll: true,
    caseSensitive: false,
    index: null,
    result: null,
  };

  if (typeof internalReader._updateState === "function") {
    internalReader._updateState({ [stateKey]: { ...baseState, active: false } });
    internalReader._updateState({ [stateKey]: baseState });
    return true;
  }

  if (typeof view.setFindState === "function") {
    await view.setFindState({ ...baseState, active: false });
    await view.setFindState(baseState);
    return true;
  }

  return false;
}

/** 等待 reader iframe 中的 PDFViewerApplication 就绪（最多 ~3.6s）。 */
async function getReaderSearchContext(reader: any): Promise<{
  iframeWindow: any;
  app: any;
} | null> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const iframeWindow =
      reader?._iframeWindow ||
      reader?._internalReader?._primaryView?._iframeWindow;
    const app = iframeWindow?.PDFViewerApplication;
    if (app) {
      try {
        await app.initializedPromise;
      } catch { /* ignore */ }
      if (
        typeof app.findController?.executeCommand === "function" ||
        typeof app.eventBus?.dispatch === "function" ||
        typeof iframeWindow?.find === "function"
      ) {
        return { iframeWindow, app };
      }
    }
    await sleep(120);
  }
  return null;
}

/**
 * 在 reader 中对单词执行 pdf.js find 高亮（highlightAll）。
 * 三级策略（参考 zotero-vocab-builder 的 highlightReaderQuery）：
 *   1. 原生 reader find 状态（_updateState / setFindState）
 *   2. PDFViewerApplication.findController.executeCommand / eventBus.dispatch
 *   3. iframeWindow.find 兜底
 */
async function highlightWordInReader(reader: any, query: string): Promise<void> {
  const q = String(query || "").trim();
  if (!q) return;

  if (await triggerNativeReaderFind(reader, q)) {
    return;
  }

  const ctx = await getReaderSearchContext(reader);
  if (!ctx) return;
  const { iframeWindow, app } = ctx;

  try {
    const searchState = {
      query: q,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false, // 词形还原词需子串匹配（fill → filling）
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: false,
    };
    if (typeof app?.findController?.executeCommand === "function") {
      app.findController.executeCommand("find", searchState);
      app.findController.executeCommand("find", { ...searchState, type: "again" });
      return;
    }
    if (typeof app?.eventBus?.dispatch === "function") {
      app.eventBus.dispatch("find", { source: app || reader, type: "", ...searchState });
      await sleep(120);
      app.eventBus.dispatch("find", {
        source: app || reader,
        type: "again",
        ...searchState,
      });
      return;
    }
  } catch { /* ignore */ }

  try {
    iframeWindow?.focus?.();
    if (typeof iframeWindow?.find === "function") {
      iframeWindow.find(q, false, false, true, false, false, false);
    }
  } catch { /* ignore */ }
}

/** Open the PDF reader at the parsed source location (position-aware). */
export async function openSourceLink(src: string, query = ""): Promise<void> {
  const parsed = parseSourceLink(src);
  if (!parsed) return;
  try {
    const location: any = parsed.position
      ? { position: parsed.position }
      : { pageIndex: parsed.pageIndex };
    await (Zotero.Reader as any).open(parsed.itemID, location, {
      openInBackground: false,
      allowDuplicate: false,
    });
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] openSourceLink error: ${e?.message || e}`);
  }

  // 打开后等待 reader 实例出现，对单词执行 find 高亮（跳转到原文位置并高亮）。
  const reader = await waitForReaderByItemID(parsed.itemID);
  if (!reader) return;
  await highlightWordInReader(reader, query);
}

function findSourceAnchor(target: any): any | null {
  try {
    const element =
      target?.nodeType === 1 ? target : target?.parentElement || null;
    const anchor = element?.closest?.("a") || null;
    if (!anchor) return null;
    const href = String(anchor.getAttribute?.("href") || "").trim();
    const source = String(anchor.getAttribute?.("data-hte-src") || "").trim();
    if (source.startsWith("zotero://open-pdf/")) return anchor;
    if (href.startsWith("zotero://open-pdf/")) return anchor;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 从 ↗ 链接解析用于高亮的单词 query。
 * 优先 <li data-hte-word>（插件写入，Zotero 9 会剥离 data-* 时回退），
 * 其次 <strong> 单词（生词本条目始终用 <strong> 包裹单词，可稳定恢复）。
 */
function readSourceQuery(anchor: any): string {
  try {
    const li = anchor?.closest?.("li");
    const attrWord = li?.getAttribute?.("data-hte-word") || "";
    if (attrWord.trim()) return String(attrWord).trim();
    const strong = li?.querySelector?.("strong");
    const strongWord = strong?.textContent?.trim?.() || "";
    if (strongWord) return String(strongWord).trim();
    const iconless = String(li?.textContent || "")
      .replace(/^\u274c\s*/, "") // 去掉 ❌ 前缀
      .replace(/^\u2705\s*/, "") // 去掉 ✅ 前缀
      .trim();
    return iconless.split(/\s|↗/)[0] || "";
  } catch (e) {
    return "";
  }
}

/** Attach click listeners to our note editors so ↗ links navigate. */
export function attachNoteEditorLinks(): void {
  try {
    const editors = ((Zotero.Notes as any)?._editorInstances || []) as any[];
    for (const editor of editors) {
      const win = editor?._iframeWindow;
      const doc = win?.document;
      if (!win || !doc) continue;
      if (doc._hteSourceLinksAttached) continue;

      doc.addEventListener(
        "click",
        (event: any) => {
          const anchor = findSourceAnchor(event.target);
          if (!anchor) return;
          const src = String(
            anchor.getAttribute("data-hte-src") ||
              anchor.getAttribute("href") ||
              "",
          ).trim();
          if (!src) return;
          event.preventDefault();
          event.stopPropagation();
          // 传单词作为高亮 query（跳转到原文位置后高亮显示）
          void openSourceLink(src, readSourceQuery(anchor));
        },
        true,
      );

      doc._hteSourceLinksAttached = true;
    }
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] attachNoteEditorLinks error: ${e?.message || e}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Failed-word retry (重启后自动重试失败的单词)                        */
/* ------------------------------------------------------------------ */

/**
 * Translate a single word WITHOUT a reader context (used by the restart
 * retry path and the local wordbook retry path). Reuses the Translate for
 * Zotero engine (same as the hover path), which is the plugin's configured
 * translation source.
 *
 * NOTE: we bypass `api.translate` and call `runTranslationTask` directly
 * with `noCheckZoteroItemLanguage: true` — `api.translate` maps a missing
 * itemID to -1, and -1 is truthy, so its internal `Zotero.Items.get(-1)`
 * item-language check throws (no try/catch there), failing every retry
 * after restart when no reader provides a valid itemID.
 */
export async function translateWordStandalone(
  word: string,
): Promise<{ ok: boolean; result: string; phon: string }> {
  const empty = { ok: false, result: "", phon: "" };
  try {
    const pdf = (Zotero as any).PDFTranslate;
    const services = pdf?.data?.translate?.services;
    if (!services?.runTranslationTask) return empty;

    const langfrom = "en";
    let langto = "zh-CN";
    try {
      langto =
        (Zotero.Prefs.get(
          "extensions.zotero.ZoteroPDFTranslate.targetLanguage",
          true,
        ) as string) || "zh-CN";
    } catch { /* ignore */ }

    let translateSource = "";
    try {
      translateSource =
        (Zotero.Prefs.get(
          "extensions.zotero.ZoteroPDFTranslate.translateSource",
          true,
        ) as string) || "";
    } catch { /* ignore */ }

    let dictSource = "";
    let enableDict = false;
    try {
      enableDict = !!Zotero.Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.enableDict",
        true,
      );
      dictSource =
        (Zotero.Prefs.get(
          "extensions.zotero.ZoteroPDFTranslate.dictSource",
          true,
        ) as string) || "";
    } catch { /* ignore */ }

    // 单服务执行（无 reader 上下文，noCheck 跳过 item 语言检查）
    const runOne = async (svc: string): Promise<any | null> => {
      if (!svc) return null;
      const task: any = {
        id: `${Zotero.Utilities.randomString()}-${new Date().getTime()}`,
        type: "custom",
        raw: word,
        result: "",
        audio: [],
        service: svc,
        candidateServices: [],
        itemId: undefined, // 不参与 item 语言检查（noCheckZoteroItemLanguage）
        status: "waiting",
        extraTasks: [],
        silent: true,
        langfrom,
        langto,
        callerID: "hover-translate-eudic@zotero-plugins.dev",
      };
      Zotero.debug(
        `[hover-translate-eudic/note] retry translate START word="${word}" service="${svc}"`,
      );
      await services.runTranslationTask(task, {
        noDisplay: true,
        noCheckZoteroItemLanguage: true,
      });
      Zotero.debug(
        `[hover-translate-eudic/note] retry translate DONE word="${word}" service="${svc}" status=${task?.status} resultLen=${(task?.result || "").length}`,
      );
      if (task?.status !== "success" || !task?.result) return null;
      return task;
    };

    // 与 hover 路径一致：先词典源（完整词条 + audio 音标），失败再回退翻译源
    let task: any = null;
    let usedDict = false;
    if (enableDict && dictSource && dictSource !== translateSource) {
      task = await runOne(String(dictSource));
      usedDict = !!task;
    }
    if (!task) {
      task = await runOne(translateSource);
      usedDict = false;
    }
    if (!task) return empty;

    // 音标：词典源优先 audio（如 bingdict 只把 IPA 放 audio），再文本提取
    let phon = "";
    if (usedDict && task.audio?.length > 0) {
      const raw = (task.audio[0].text || "").trim();
      if (raw) phon = stripAudioTextLocal(raw);
    }
    if (!phon) phon = extractPhonetic(task.result || "");
    // 统一为 /音标/ 形式（与笔记渲染格式一致，hover/划词路径同款）
    if (phon && !phon.startsWith("/")) phon = `/${phon}/`;

    return { ok: true, result: task.result || "", phon };
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] translateWordStandalone error: ${e?.message || e}`);
    return empty;
  }
}

/** Strip language/region prefix or brackets from an audio-text IPA ("英 [ˈx]" → "ˈx"). */
function stripAudioTextLocal(raw: string): string {
  const bracketM = raw.match(/\[([^\]]+?)\]/);
  if (bracketM) return bracketM[1];
  return raw.replace(/^[a-z]{2}\s+/i, "").trim();
}

/** Check if a string looks like IPA phonetic notation (contains Unicode IPA characters). */
function looksLikeIPA(s: string): boolean {
  return /[ˈˌa-zA-Zəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑɝɚɘɵɤɨ]{4,}/.test(s);
}

/**
 * Extract phonetic notation from a dictionary/translation result string.
 * Mirrors the hover path's strategy with broader format coverage:
 *  1. 英 [...] / 美 [...] / plain [...] (e.g. 英 [ˈkɒmpjʊtə])
 *  2. /.../ (e.g. /ˈkɒmpjʊtə/), incl. UK /.../ US /.../
 *  3. first word of the first line if it looks like IPA
 */
function extractPhonetic(text: string): string {
  if (!text) return "";
  // 1. [...]（支持 英 [...]、美 [...]、UK [...]、plain [...]）
  let m = text.match(/(?:英|美|uk|us|br|am|ən|æm)?\s*\[([^\]\[]+?)\]/i);
  if (m && looksLikeIPA(m[1])) return m[1].trim();
  m = text.match(/\[([^\]\[]+?)\]/);
  if (m && looksLikeIPA(m[1])) return m[1].trim();
  // 2. /.../（支持 UK /.../ US /.../）
  m = text.match(/(?:uk|us|br|am|英|美)?\s*\/([^\/]+?)\//i);
  if (m && looksLikeIPA(m[1])) return m[1].trim();
  // 3. 首行首词若形似 IPA
  const firstLine = text.split("\n")[0].trim();
  const firstWord = firstLine.split(/[\s,;]/)[0];
  if (firstWord && looksLikeIPA(firstWord)) return firstWord;
  return "";
}

/**
 * 状态弹窗通知（Zotero ProgressWindow）。
 *
 * 图标：ItemProgress 第一参数 itemType 只写入 dataset.itemType；CSS 图标类
 * 由 setItemTypeAndIcon 的 cssIcon 决定（默认 'item-type' 无背景图 → 系统
 * 文件夹 fallback），故强制 cssIcon="note"（生词本笔记语义，有 note.svg）。
 * error 走 setError()（cross 图标 + 红字）。
 *
 * 空白：Zotero 固有布局（min-width:300px + 常驻空标题行 + padding:10px）
 * 会在左/右/下产生大片留白，通过向该弹窗窗口注入紧凑 CSS 覆盖消除。
 */
function pwNotify(message: string, tone: "success" | "error" | "info" = "info"): void {
  try {
    const pw = new (Zotero as any).ProgressWindow({ closeOnClick: true });
    pw.show();
    const line = new pw.ItemProgress("note", message);
    // 强制 cssIcon="note"（默认 'item-type' 无背景图），避免文件夹 fallback
    if (typeof line.setItemTypeAndIcon === "function") {
      line.setItemTypeAndIcon("note", "note");
    }
    (pw as any).progress = line;
    if (tone === "error") {
      line.setError();
    } else {
      line.setProgress(100);
    }
    pw.startCloseTimer(4000);
    // 压缩弹窗三边空白：窗口异步加载，延迟轮询注入紧凑样式
    for (const delay of [60, 200, 500]) {
      setTimeout(() => void tightenProgressWindow(), delay);
    }
  } catch { /* 通知失败不影响主流程 */ }
}

/**
 * 向当前 ProgressWindow 窗口注入紧凑样式，消除 Zotero 固有的
 * 左/右（min-width:300px）与下方（常驻空标题行 + padding:10px）留白。
 * 注入后弹窗宽度贴合内容，形如「[图标] 文本」的紧凑提示。
 */
function tightenProgressWindow(): void {
  try {
    const wm = (Services as any).wm;
    if (!wm?.getMostRecentWindow) return;
    const win = wm.getMostRecentWindow("alert:alert") as any;
    if (!win?.document) return;
    const doc = win.document;
    if (!doc.getElementById("zotero-progress")) return;
    if (doc.getElementById("hte-progress-compact")) return; // 已注入
    const style = doc.createElement("style");
    style.id = "hte-progress-compact";
    style.textContent = [
      "#zotero-progress { min-width: 0 !important; }",
      "#zotero-progress-text-box { padding: 4px 10px !important; }",
      "#zotero-progress-text-headline { display: none !important; }",
      ".zotero-progress-item-hbox { min-width: 0 !important; }",
    ].join("\n");
    (doc.head || doc.documentElement).appendChild(style);
  } catch { /* 注入失败不影响通知 */ }
}

/** 找出所有带生词本标签的笔记（可能多个，需逐个重试）。 */
async function findAllNotesByTag(): Promise<any[]> {
  const out: any[] = [];
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(userLibID()));
    search.addCondition("itemType", "is", "note");
    search.addCondition("tag", "is", NOTE_TAG);
    const ids = await search.search();
    for (const id of ids || []) {
      try {
        const note = Zotero.Items.get(id);
        if (isNote(note)) out.push(note);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * 判断注释文本是否对应该生词（词形还原感知）。
 * 笔记中保存的是词形还原后的原形（fill / gap），而注释 text 保存的是
 * 原文屈折形式（filling / gaps）——精确匹配会漏掉。因此先精确匹配，
 * 再用 toLemma 将注释文本还原后与生词比较；body 模式（翻译进正文）下
 * 注释 text 为 "翻译\n单词" 或 "单词\n翻译"，做包含/首尾匹配兜底。
 */
function annotationTextMatchesWord(text: string, word: string): boolean {
  const t = String(text || "").trim();
  const w = String(word || "").trim().toLowerCase();
  if (!t || !w) return false;
  const tl = t.toLowerCase();
  if (tl === w) return true;
  if (toLemma(t).toLowerCase() === w) return true;
  // body 模式：text = "翻译\n单词"（before）或 "单词\n翻译"（after）
  if (tl.endsWith(`\n${w}`) || tl.startsWith(`${w}\n`)) return true;
  if (tl.split(/\n+/).includes(w)) return true;
  return false;
}

/** 把注释中所有离线提示标记替换为 translation（评论与正文都处理）。 */
function replaceHintsInAnnotation(ann: any, translation: string): boolean {
  const text = String(ann.annotationText || "");
  const comment = String(ann.annotationComment || "");
  const hasHintInComment = OFFLINE_HINTS.some((h) => comment.includes(h));
  const hasHintInText = OFFLINE_HINTS.some((h) => text.includes(h));
  if (!hasHintInComment && !hasHintInText) return false;
  if (hasHintInComment) {
    ann.annotationComment = OFFLINE_HINTS.reduce(
      (acc, h) => acc.split(h).join(translation),
      comment,
    );
  }
  if (hasHintInText) {
    ann.annotationText = OFFLINE_HINTS.reduce(
      (acc, h) => acc.split(h).join(translation),
      text,
    );
  }
  return true;
}

/**
 * 重试成功后补全注释：把注释中「❌ 联网重启后自动重试补全，也可手动更改」的离线提示替换为真实释义。
 * 匹配策略：注释正文(text) 与生词精确/词形还原匹配，且评论(comment) 或
 * 正文(text) 含离线提示标记 → 更新（body 模式下提示在 text 里）。
 * 修复：同一生词可能有多个注释（不同页码/位置），全部更新，不提前 return。
 */
async function updateOfflineAnnotation(
  word: string,
  translation: string,
): Promise<void> {
  const dbg = (m: string) => {
    try {
      Zotero.debug(`[hover-translate-eudic/note] updateOfflineAnnotation: ${m}`);
    } catch { /* ignore */ }
  };
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(userLibID()));
    search.addCondition("itemType", "is", "annotation");
    const ids = await search.search();
    let updated = 0;
    for (const id of ids || []) {
      let ann: any;
      try {
        ann = Zotero.Items.get(id);
      } catch { continue; }
      if (!ann || ann.itemType !== "annotation") continue;
      const text = String(ann.annotationText || "");
      if (!annotationTextMatchesWord(text, word)) continue;
      if (!replaceHintsInAnnotation(ann, translation)) continue;

      // 逐条更新并容错：单条失败不影响其余注释/生词
      try {
        await ann.saveTx({ notifierData: {} });
        updated++;
        Zotero.debug(
          `[hover-translate-eudic/note] updated offline annotation for "${word}" (ann id=${ann.id}, text=${JSON.stringify(text.slice(0, 40))})`,
        );
      } catch (e: any) {
        dbg(`update failed for ann id=${ann.id}: ${e?.message || e}`);
      }
    }
    dbg(`word="${word}" done, updated=${updated}`);
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] updateOfflineAnnotation error: ${e?.message || e}`);
  }
}

/**
 * 从注释正文提取单词（用于独立补全注释）。
 * comment 模式 text = 单词原文（如 "gaps"）；body 模式 text =
 * "提示\n单词" 或 "单词\n提示"。先剥离提示标记，再取第一个英文单词。
 */
function extractWordFromAnnotationText(text: string): string {
  let t = String(text || "");
  for (const h of OFFLINE_HINTS) {
    t = t.split(h).join(" ");
  }
  const m = t.match(/[a-zA-Z][a-zA-Z'\-]*/);
  return m ? m[0] : "";
}

/**
 * 独立补全注释（与笔记重试解耦）。
 *
 * 背景：注释补全原先依赖笔记中 failed 词条触发——笔记该词已完成、
 * 或生词本不在 Zotero 平台（欧路/扇贝/墨墨）时，注释的离线提示永远
 * 不会补全。此函数直接扫描所有含离线提示标记的注释，对注释自身的
 * 单词重新翻译并替换提示，与笔记状态无关。
 *
 * 幂等：补全成功后提示标记消失，下次重启不再重复处理。
 */
export async function retryOfflineAnnotations(): Promise<number> {
  const dbg = (m: string) => {
    try {
      Zotero.debug(`[hover-translate-eudic/note] retryOfflineAnnotations: ${m}`);
    } catch { /* ignore */ }
  };
  try {
    const search = new Zotero.Search();
    search.addCondition("libraryID", "is", String(userLibID()));
    search.addCondition("itemType", "is", "annotation");
    const ids = await search.search();

    // 收集所有含离线提示的注释
    const pending: any[] = [];
    for (const id of ids || []) {
      let ann: any;
      try {
        ann = Zotero.Items.get(id);
      } catch { continue; }
      if (!ann || ann.itemType !== "annotation") continue;
      const text = String(ann.annotationText || "");
      const comment = String(ann.annotationComment || "");
      if (OFFLINE_HINTS.some((h) => text.includes(h) || comment.includes(h))) {
        pending.push(ann);
      }
    }
    if (pending.length === 0) {
      dbg("no annotation with offline hint, done");
      return 0;
    }
    dbg(`found ${pending.length} annotation(s) with offline hint`);

    // 同一单词只翻译一次（原文 → lemma 双键，覆盖不同词形）
    const resultCache = new Map<string, { ok: boolean; result: string }>();
    let done = 0;
    for (const ann of pending) {
      try {
        const text = String(ann.annotationText || "");
        const word = extractWordFromAnnotationText(text);
        if (!word) {
          dbg(`ann id=${ann.id}: cannot extract word from text=${JSON.stringify(text.slice(0, 40))}, skip`);
          continue;
        }
        const key = `${word.toLowerCase()}|${toLemma(word).toLowerCase()}`;
        let r = resultCache.get(key);
        if (!r) {
          const res = await translateWordStandalone(word);
          // 原文词形翻译失败时回退词形还原形式
          const fallback = res.ok && res.result ? res : await translateWordStandalone(toLemma(word));
          r = {
            ok: !!fallback && fallback.ok && !!fallback.result,
            result: fallback && fallback.ok ? fallback.result || "" : "",
          };
          resultCache.set(key, r);
          dbg(`translate "${word}" → ok=${r.ok} resultLen=${r.result.length}`);
        }
        if (!r.ok || !r.result) continue;
        if (!replaceHintsInAnnotation(ann, r.result)) continue;
        await ann.saveTx({ notifierData: {} });
        done++;
        dbg(`completed annotation "${word}" (ann id=${ann.id})`);
      } catch (e: any) {
        dbg(`ann id=${ann.id} error: ${e?.message || e}`);
      }
    }
    dbg(`done, completed=${done}/${pending.length}`);
    return done;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] retryOfflineAnnotations error: ${e?.message || e}`);
    return 0;
  }
}

/** 扫描单个笔记中 failed/pending 词条并重新翻译（最多 3 次尝试）。 */
async function retryWordsInNote(note: any): Promise<number> {
  const dbg = (m: string) => {
    try {
      Zotero.debug(`[hover-translate-eudic/note] retryWordsInNote: ${m}`);
    } catch { /* ignore */ }
  };
  try {
    await note.reload();
    const html = note.getNote() || "";
    const entries = parseNoteHTML(html);
    dbg(`note id=${note.id}: parsed ${entries.length} entries`);
    const retriable = entries.filter(
      (e) =>
        (e.status === "failed" || e.status === "pending") && e.tries < 3,
    );
    dbg(
      `retriable=${retriable.length} (failed/pending with tries<3): ${retriable.map((e) => e.word).join(",") || "(none)"}`,
    );
    if (retriable.length === 0) return 0;

    let retried = 0;
    for (const entry of retriable) {
      dbg(`retrying word="${entry.word}" (tries=${entry.tries})...`);
      const result = await translateWordStandalone(entry.word);
      const live = entries.find(
        (e) => e.word.toLowerCase() === entry.word.toLowerCase(),
      );
      if (!live) {
        dbg(`  word="${entry.word}" no longer in entries, skip`);
        continue;
      }
      if (result.ok && result.result) {
        live.status = "completed";
        live.exp = result.result;
        if (result.phon) live.phon = result.phon;
        live.tries = 0; // 成功后重置
        dbg(`  word="${entry.word}" SUCCESS resultLen=${result.result.length}`);
        // 同步补全注释：把「重启zotero后会自动翻译」提示替换为真实释义
        await updateOfflineAnnotation(entry.word, result.result);
      } else {
        live.status = "failed";
        live.tries = (live.tries || 0) + 1;
        dbg(`  word="${entry.word}" FAILED tries→${live.tries}`);
      }
      retried++;
      // 每处理一个词就落盘一次，避免中途崩溃丢失进度
      try {
        const title = noteTitle(note) || DEFAULT_TITLE;
        note.setNote(renderNoteHTML(title, entries));
        await note.saveTx({ notifierData: {} });
        dbg(`  word="${entry.word}" saved to note (total ${entries.length})`);
      } catch (e: any) {
        dbg(`  word="${entry.word}" saveTx error: ${e?.message || e}`);
      }
    }
    dbg(`done, retried=${retried}`);
    return retried;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] retryWordsInNote error: ${e?.message || e}`);
    return 0;
  }
}

/** 扫描所有生词本笔记中的 failed/pending 词条并重新翻译（最多 3 次尝试）。 */
export async function retryFailedWords(): Promise<number> {
  const dbg = (m: string) => {
    try {
      Zotero.debug(`[hover-translate-eudic/note] retryFailedWords: ${m}`);
    } catch { /* ignore */ }
  };
  try {
    const notes = await findAllNotesByTag();
    if (notes.length === 0) {
      dbg("no wordbook note found (tag=hover-translate-eudic-wordbook), abort");
      return 0;
    }
    dbg(`found ${notes.length} wordbook note(s): ${notes.map((n) => n.id).join(",")}`);

    // 先统计总重试数，供弹窗提示
    let totalRetriable = 0;
    for (const note of notes) {
      try {
        await note.reload();
        const entries = parseNoteHTML(note.getNote() || "");
        totalRetriable += entries.filter(
          (e) => (e.status === "failed" || e.status === "pending") && e.tries < 3,
        ).length;
      } catch { /* ignore */ }
    }
    if (totalRetriable > 0) {
      // 弹窗提醒：正在重试 N 个待处理生词（参考项目 notify.retrying）
      pwNotify(`正在重试 ${totalRetriable} 个待处理生词`, "info");
    }

    let total = 0;
    for (const note of notes) {
      total += await retryWordsInNote(note);
    }
    dbg(`all notes done, retried=${total}`);
    return total;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/note] retryFailedWords error: ${e?.message || e}`);
    return 0;
  }
}
