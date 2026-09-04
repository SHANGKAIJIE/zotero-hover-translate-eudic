/**
 * 背诵记忆存储 — 独立 JSON 文件（hover-translate-eudic-memory.json）。
 *
 * 设计要点：
 *  - 与词表（local CSV / Zotero 笔记）解耦：记忆状态按「词条小写」为键，
 *    不污染 CSV 7 列结构（保住欧路批量导入兼容性），local / zotero 两平台共享。
 *  - 预留 FSRS 三字段 s（stability）/ d（difficulty）/ r（retrievability），
 *    未来调度算法升级零迁移。
 *  - 路径跟随 localSavePath：与生词表 CSV 同级，便于用户备份/迁移；
 *    未设置时回退 Zotero profile 目录（ProfD）。
 */

import { getPref } from "../utils/prefs";

const MEMORY_FILENAME = "hover-translate-eudic-memory.json";
const BACKUP_FILENAME = "hover-translate-eudic-memory.bak.json";

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

/** 用户自评三档（映射 FSRS again/hard/good）。 */
export type ReciteRating = "again" | "hard" | "good";

/** 单词记忆阶段。 */
export type WordState = "new" | "learning" | "review";

/** 单个单词的记忆状态（FSRS 核心字段 + 审计字段）。 */
export interface WordMemory {
  /** FSRS 稳定性（越大记忆越牢，单位：天）。 */
  s: number;
  /** FSRS 难度（1-10）。 */
  d: number;
  /** FSRS 可提取性（0-1，冗余缓存，刚复习完 ≈1）。 */
  r: number;
  /** 上次复习时间（ISO 字符串，从未复习为 null）。 */
  lastReview: string | null;
  /** 到期日（YYYY-MM-DD）。 */
  due: string;
  /** 累计复习次数。 */
  reps: number;
  /** 累计遗忘次数。 */
  lapses: number;
  /** 当前阶段。 */
  state: WordState;
  /** 上次评分。 */
  lastRating: ReciteRating | null;
  /** 例句原文（PDF 上下文句子，M2 加词时写入；空则词典例句兜底）。 */
  ctx?: string;
  /** 例句中实际命中的词形（加词时取词高亮命中的词，可能是变形词；用于精确高亮）。 */
  ctxHit?: string;
}

/** 完整记忆文件结构。 */
export interface ReciteMemory {
  version: number;
  /** key = 词条小写。 */
  words: Record<string, WordMemory>;
  stats: {
    /** 连续背诵天数。 */
    streak: number;
    /** 最后学习日（YYYY-MM-DD，用于判断连续）。 */
    lastStudyDay: string;
    /** 今日已背词数（跨会话累计，跨天重置）。 */
    todayCount: number;
    /** 今日最终评分统计（认识/模糊/忘记，跨会话累计，跨天重置）。 */
    todayScores: { good: number; hard: number; again: number };
    /** 最后提醒日（YYYY-MM-DD，背单词提醒「每日一次」去重用）。 */
    lastRemindDay?: string;
  };
}

/* ------------------------------------------------------------------ */
/*  日期工具                                                           */
/* ------------------------------------------------------------------ */

/** 本地日期 → YYYY-MM-DD（避免 toISOString 的 UTC 偏移）。 */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD 加 N 天，返回 YYYY-MM-DD。 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return localDate(dt);
}

/** 距今（从 ISO 时间）经过的天数；无效返回 0。 */
export function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/* ------------------------------------------------------------------ */
/*  路径解析                                                           */
/* ------------------------------------------------------------------ */

/**
 * 解析记忆文件所在目录（与生词表 CSV 同级）：
 *  - localSavePath 非空：目录 → 直接用；文件路径 → 取其父目录。
 *  - 空：Zotero profile 目录（ProfD）。
 */
function getMemoryDir(): any {
  const savePath = (getPref("localSavePath") as string || "").trim();
  if (savePath) {
    const nsIFile = (Components as any).interfaces.nsIFile;
    const file = (Components as any).classes["@mozilla.org/file/local;1"]
      .createInstance(nsIFile);
    try {
      file.initWithPath(savePath);
      if (file.isDirectory()) {
        return file;
      }
      // 文件路径 → 父目录
      if (file.parent) return file.parent;
    } catch {
      // 非法路径 → 回退默认
    }
  }
  const dirSvc = (Components as any).classes["@mozilla.org/file/directory_service;1"]
    .getService((Components as any).interfaces.nsIProperties);
  return dirSvc.get("ProfD", (Components as any).interfaces.nsIFile);
}

/** 记忆 JSON 文件。 */
function getMemoryFile(): any {
  const dir = getMemoryDir();
  dir.append(MEMORY_FILENAME);
  return dir;
}

/** 备份文件（.bak）。 */
function getBackupFile(): any {
  const dir = getMemoryDir();
  dir.append(BACKUP_FILENAME);
  return dir;
}

/* ------------------------------------------------------------------ */
/*  读写                                                               */
/* ------------------------------------------------------------------ */

function emptyMemory(): ReciteMemory {
  return { version: 1, words: {}, stats: { streak: 0, lastStudyDay: "", todayCount: 0, todayScores: { good: 0, hard: 0, again: 0 } } };
}

/** 读取记忆；文件不存在或损坏时返回空记忆（不抛错）。 */
export async function loadMemory(): Promise<ReciteMemory> {
  const file = getMemoryFile();
  if (!file.exists()) return emptyMemory();
  try {
    const raw = String(await Zotero.File.getContentsAsync(file) || "");
    const parsed = JSON.parse(raw) as ReciteMemory;
    if (!parsed || typeof parsed !== "object" || !parsed.words) {
      return emptyMemory();
    }
    parsed.stats = parsed.stats || { streak: 0, lastStudyDay: "" };
    if (typeof parsed.stats.todayCount !== "number") parsed.stats.todayCount = 0;
    parsed.stats.todayScores = parsed.stats.todayScores || { good: 0, hard: 0, again: 0 };
    return parsed;
  } catch (e: any) {
    try {
      Zotero.debug(`[hover-translate-eudic/recite] loadMemory error: ${e?.message || e}`);
    } catch { /* ignore */ }
    return emptyMemory();
  }
}

/** 写入记忆（UTF-8 无 BOM，JSON 美化 2 空格）。 */
export async function saveMemory(m: ReciteMemory): Promise<void> {
  const file = getMemoryFile();
  await Zotero.File.putContentsAsync(file, JSON.stringify(m, null, 2), "UTF-8");
}

/** 删除某个词条的背诵记忆（生词本删除词条时同步调用，避免重新添加时恢复旧状态）。 */
export async function forgetWord(word: string): Promise<void> {
  const key = word.trim().toLowerCase();
  if (!key) return;
  const m = await loadMemory();
  if (!(key in m.words)) return; // 无该词记忆，无需写盘
  delete m.words[key];
  await saveMemory(m);
}

/** 备份当前记忆为 .bak（覆盖式）。 */
export async function backupMemory(): Promise<void> {
  const src = getMemoryFile();
  if (!src.exists()) return;
  const raw = String(await Zotero.File.getContentsAsync(src) || "");
  await Zotero.File.putContentsAsync(getBackupFile(), raw, "UTF-8");
}

/** 新建单词记忆的初始状态（FSRS 新词）。 */
export function initWordMemory(): WordMemory {
  return {
    s: 0,
    d: 5,          // 难度初值取中位
    r: 0,
    lastReview: null,
    due: localDate(),
    reps: 0,
    lapses: 0,
    state: "new",
    lastRating: null,
  };
}

/**
 * 记录某词例句原文（PDF 上下文句子）到记忆 JSON 的 ctx 字段（M2）。
 *  - 无记忆记录时预建一条新词记录（state="new"，后续背诵队列将其视为新词）；
 *  - 有记录时仅覆盖 ctx（词已学过则保留进度）；
 *  - ctx 为空时不写入。
 */
export async function setWordCtx(word: string, ctx: string, hitWord?: string): Promise<void> {
  const text = (ctx || "").trim().replace(/\s+/g, " ");
  const hit = (hitWord || "").trim().replace(/\s+/g, " ");
  if (!text) return;
  const key = word.toLowerCase();
  try {
    const memory = await loadMemory();
    const m = memory.words[key] ?? initWordMemory();
    if (m.ctx !== text || (hit && m.ctxHit !== hit)) {
      m.ctx = text;
      if (hit) m.ctxHit = hit;
      memory.words[key] = m;
      await saveMemory(memory);
    }
  } catch (e: any) {
    try {
      Zotero.debug(`[hover-translate-eudic/recite] setWordCtx error: ${e?.message || e}`);
    } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/*  统计                                                               */
/* ------------------------------------------------------------------ */

/**
 * 更新连续背诵天数。调用时机：每次完成一次自评（grade）后。
 *  - 今天已记过 → 不重复累加。
 *  - 昨天学过 → streak+1；否则重置为 1。
 */
export function updateStreak(m: ReciteMemory): void {
  const today = localDate();
  if (m.stats.lastStudyDay === today) return;
  const yesterday = addDays(today, -1);
  m.stats.streak = (m.stats.lastStudyDay === yesterday) ? m.stats.streak + 1 : 1;
  m.stats.lastStudyDay = today;
  // 跨天：重置今日已背计数与今日评分统计
  m.stats.todayCount = 0;
  m.stats.todayScores = { good: 0, hard: 0, again: 0 };
}

/** 今日待复习数量（state≠new 且 due≤today），供「背·N」角标。 */
export function todayDueCount(m: ReciteMemory): number {
  const today = localDate();
  let n = 0;
  for (const key in m.words) {
    const w = m.words[key];
    if (w && w.state !== "new" && w.due <= today) n++;
  }
  return n;
}
