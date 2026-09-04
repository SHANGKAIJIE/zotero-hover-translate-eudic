/**
 * 背诵会话引擎 — FSRS 调度 + 音节拆分 + 队列。
 *
 * FSRS（Free Spaced Repetition Scheduler）移植自 fsrs4anki（MIT，社区标准，
 * Anki 23.10+ 默认调度器）。三变量模型：
 *   - D difficulty（难度 1-10）
 *   - S stability（稳定性，单位天，越大记得越牢）
 *   - R retrievability（可提取性 0-1，当前能回忆的概率）
 *
 * 评分映射（本插件 3 档 → FSRS 4 档）：
 *   认识(1) = good / 模糊(2) = hard / 忘记(3) = again
 *
 * 音节拆分：规则法（VC/CV、V/CV、-le、元音组不拆），仅切分不求计数，
 * 失败回退原词（不阻断背诵）。
 */

import {
  type ReciteMemory,
  type WordMemory,
  type ReciteRating,
  initWordMemory,
  loadMemory,
  saveMemory,
  updateStreak,
  localDate,
  addDays,
  daysSince,
} from "./reciteMemory";
import { getPref } from "../utils/prefs";

/* ------------------------------------------------------------------ */
/*  FSRS 常量（默认权重，来源 fsrs4anki v6.1.1 / FSRS-4.5）           */
/* ------------------------------------------------------------------ */

// FSRS-4.5 官方默认权重（21 项）。
// 来源：open-spaced-repetition/fsrs4anki v6.1.1 的 fsrs4anki_scheduler.js
// 参数含义见 https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
const W = [
  0.212,   // w0  初始稳定性 again
  1.2931,  // w1  初始稳定性 hard
  2.3065,  // w2  初始稳定性 good
  8.2956,  // w3  初始稳定性 easy
  6.4133,  // w4  初始难度基值
  0.8334,  // w5  初始难度指数
  3.0194,  // w6  难度增量系数
  0.001,   // w7  难度均值回归权重
  1.8722,  // w8  回忆后稳定性增长
  0.1666,  // w9
  0.796,   // w10
  1.4835,  // w11 遗忘后稳定性
  0.0614,  // w12
  0.2629,  // w13
  1.6483,  // w14
  0.6014,  // w15 hard 惩罚
  1.8729,  // w16 easy 奖励
  0.5425,  // w17 短期稳定性指数
  0.0912,  // w18
  0.0658,  // w19
  0.1542,  // w20 DECAY 参数（DECAY = -w20）
];

// 遗忘曲线参数（FSRS-4.5）：R(t,S) = (1 + FACTOR * t/S)^DECAY
const DECAY = -W[20];
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;
const MAX_INTERVAL = 36500;

type RatingKey = ReciteRating | "easy";
const RATING_MAP: Record<RatingKey, number> = { again: 1, hard: 2, good: 3, easy: 4 };

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/* ------------------------------------------------------------------ */
/*  FSRS 纯函数（FSRS-4.5，与 fsrs4anki 对齐）                        */
/* ------------------------------------------------------------------ */

/** 可提取性：距上次复习 t 天后，回忆起的概率。 */
export function retrievability(t: number, s: number): number {
  if (s <= 0) return 0;
  return Math.pow(1 + (FACTOR * t) / s, DECAY);
}

/** 初始难度（按评分）。 */
function initDifficulty(rating: RatingKey): number {
  return clamp(round2(W[4] - Math.exp(W[5] * (RATING_MAP[rating] - 1)) + 1), 1, 10);
}

/** 初始稳定性（按评分）。 */
function initStability(rating: RatingKey): number {
  return Math.max(W[RATING_MAP[rating] - 1], 0.1);
}

/** 难度均值回归。 */
function meanReversion(init: number, current: number): number {
  return W[7] * init + (1 - W[7]) * current;
}

/** 难度更新（含线性阻尼 + 均值回归）。 */
export function nextDifficulty(d: number, rating: ReciteRating): number {
  const deltaD = -W[6] * (RATING_MAP[rating] - 3);
  const damped = deltaD * ((10 - d) / 9);
  const nextD = d + damped;
  return clamp(round2(meanReversion(initDifficulty("easy"), nextD)), 1, 10);
}

/** 回忆成功后的稳定性。 */
export function nextRecallStability(
  d: number,
  s: number,
  r: number,
  rating: ReciteRating,
): number {
  const hardPenalty = rating === "hard" ? W[15] : 1;
  const easyBonus = rating === "good" ? 1 : 1; // 本插件无 easy 档
  return round2(
    s *
      (1 +
        Math.exp(W[8]) *
          (11 - d) *
          Math.pow(s, -W[9]) *
          (Math.exp((1 - r) * W[10]) - 1) *
          hardPenalty *
          easyBonus),
  );
}

/** 遗忘后的稳定性（答 again，含 sMin 上限）。 */
export function nextForgetStability(d: number, s: number, r: number): number {
  const sMin = s / Math.exp(W[17] * W[18]);
  const val =
    W[11] *
    Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) *
    Math.exp((1 - r) * W[14]);
  return round2(Math.min(val, sMin));
}

/** 由稳定性 S 和目标留存率反推下次间隔（天，向上取整 ≥1）。 */
export function nextInterval(s: number, desiredRetention: number): number {
  const dr = clamp(desiredRetention, 0.1, 0.99);
  const ivl = (s / FACTOR) * (Math.pow(dr, 1 / DECAY) - 1);
  return clamp(Math.round(ivl), 1, MAX_INTERVAL);
}

/** 新词初始记忆状态（good 评分对应的初始稳定性/难度）。 */
export function initWordState(): { s: number; d: number } {
  return { s: initStability("good"), d: initDifficulty("good") };
}

/* ------------------------------------------------------------------ */
/*  音节拆分（规则法）                                                 */
/* ------------------------------------------------------------------ */

const VOWELS = "aeiouy";

function isVowel(ch: string): boolean {
  return VOWELS.includes(ch);
}

/**
 * 将英文单词切分为音节数组（如 "unbelievable" → ["un","be","liev","a","ble"]）。
 * 规则：元音组为一个核心；VC/CV 中间切开；V/CV 开音节切开；-le 归前音节；
 * 连续元音/元音组合不拆。切分失败返回空数组（调用方回退原词）。
 */
export function splitSyllables(word: string): string[] {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return [];

  // 1. 标记元音/辅音序列，找出元音核心位置
  const cores: number[] = []; // 每个元音核心的起始下标
  let i = 0;
  while (i < w.length) {
    if (isVowel(w[i])) {
      cores.push(i);
      // 跳过连续元音（视为一个核心，双元音/元音组合不拆）
      while (i < w.length && isVowel(w[i])) i++;
    } else {
      i++;
    }
  }
  if (cores.length <= 1) return [w]; // 单音节

  // 2. 确定切分点：相邻两个元音核心之间
  const cuts: number[] = []; // 每个切分点 = 第二段起始下标
  for (let k = 0; k < cores.length - 1; k++) {
    const c1 = cores[k];
    const c2 = cores[k + 1];
    // 中间辅音串 [midStart, c2)
    const midStart = c1;
    // 找到第一个元音核心的结束位置
    let e1 = c1;
    while (e1 < w.length && isVowel(w[e1])) e1++;
    const consonants = w.slice(e1, c2); // 两元音核心之间的辅音串

    let cut = c2; // 默认切在第二核心前（V/V）
    if (consonants.length === 1) {
      // V/CV：单个辅音归后音节（开音节，pa-per）
      cut = c2 - 1;
    } else if (consonants.length >= 2) {
      // VC/CV：辅音串中间切开（nap-kin）
      cut = e1 + Math.floor(consonants.length / 2);
    }
    cuts.push(cut);
  }

  // 3. -le 处理：词尾 "consonant + le" 的 le 归前一音节（ta-ble）
  if (w.endsWith("le") && w.length > 2 && !isVowel(w[w.length - 3])) {
    // 已在切分中天然接近；简化：确保最后一个 cut 不落在 le 内部
    const lastCut = cuts[cuts.length - 1];
    if (lastCut > w.length - 2) cuts[cuts.length - 1] = w.length - 2;
  }

  // 4. 按切分点生成音节
  const result: string[] = [];
  let start = 0;
  for (const cut of cuts) {
    if (cut > start && cut <= w.length) {
      result.push(w.slice(start, cut));
      start = cut;
    }
  }
  if (start < w.length) result.push(w.slice(start));

  // 5. 合并过短音节（单字母前缀归并到后一音节）
  const merged: string[] = [];
  for (const syl of result) {
    if (merged.length && syl.length <= 1) {
      merged[merged.length - 1] += syl;
    } else {
      merged.push(syl);
    }
  }

  return merged.length > 0 ? merged : [w];
}

/* ------------------------------------------------------------------ */
/*  会话队列                                                           */
/* ------------------------------------------------------------------ */

/** 队列项：词表数据 + 记忆状态 + 展示用字段。 */
export interface QueueItem {
  word: string;
  phon: string;
  exp: string;
  src: string;
  /** 例句来源：original（原文）| dict（词典）。 */
  sentenceSource: "original" | "dict";
  memory: WordMemory;
  /** 本次是否为新词。 */
  isNew: boolean;
  /** 例句原文（PDF 上下文句子；sentenceSource=original 时优先展示）。 */
  ctx?: string;
  /** 例句中实际命中的词形（用于精确高亮，无需变形词匹配）。 */
  ctxHit?: string;
}

/** 读取所有 recite pref（供队列与弹窗使用）。 */
export function readRecitePrefs() {
  return {
    autoSpeakWord: getPref("reciteAutoSpeakWord" as any) as boolean,
    autoSpeakBefore: getPref("reciteAutoSpeakBefore" as any) as boolean,
    autoSpeakAfter: getPref("reciteAutoSpeakAfter" as any) as boolean,
    autoSpeakSentence: getPref("reciteAutoSpeakSentence" as any) as boolean,
    showSentence: getPref("reciteShowSentence" as any) as boolean,
    sentenceSpeakRate: getPref("reciteSentenceSpeakRate" as any) as string,
    syllableSplit: getPref("reciteSyllableSplit" as any) as boolean,
    order: getPref("reciteOrder" as any) as string,
    accent: getPref("reciteAccent" as any) as string,
    speakRate: getPref("reciteSpeakRate" as any) as string,
    mode: getPref("reciteMode" as any) as string,
    sentenceSource: getPref("reciteSentenceSource" as any) as string,
    dailyNew: getPref("reciteDailyNew" as any) as number,
    dailyLimit: getPref("reciteDailyLimit" as any) as number,
    desiredRetention: getPref("reciteDesiredRetention" as any) as number,
  };
}

/**
 * 构建今日背诵队列。
 *  - 复习项：state≠new 且 due≤today（含过期未复习）。
 *  - 新词项：无记忆记录 或 state==="new"，受 dailyNew 上限。
 *  - 学习顺序（reciteOrder）：reviewFirst=先复习后新词 | mixed=混合穿插
 *    | newFirst=先新词后复习。复习项受 dailyLimit 截断（超出顺延不丢）。
 */
export function buildQueue(
  words: { word: string; phon: string; exp: string; src: string }[],
  memory: ReciteMemory,
  prefs: ReturnType<typeof readRecitePrefs>,
): QueueItem[] {
  const today = localDate();
  const source: QueueItem["sentenceSource"] =
    prefs.sentenceSource === "original" ? "original" : "dict";

  const reviews: QueueItem[] = [];
  const news: QueueItem[] = [];

  for (const w of words) {
    const key = w.word.toLowerCase();
    const m = memory.words[key];
    if (m && m.state !== "new" && m.due <= today) {
      reviews.push({ ...w, sentenceSource: source, memory: m, isNew: false, ctx: m.ctx, ctxHit: m.ctxHit });
    } else if (!m || m.state === "new") {
      news.push({
        ...w,
        sentenceSource: source,
        memory: m ?? initWordMemory(),
        isNew: true,
        ctx: m?.ctx,
        ctxHit: m?.ctxHit,
      });
    }
  }

  // 新词数上限
  const newLimited = news.slice(0, Math.max(0, prefs.dailyNew));
  // 复习上限（Anki 式：仅截断复习队列，超出顺延）
  const reviewLimited = reviews.slice(0, Math.max(0, prefs.dailyLimit));

  const order = prefs.order || "reviewFirst";

  if (order === "reviewFirst") {
    return [...reviewLimited, ...newLimited];
  }
  if (order === "newFirst") {
    return [...newLimited, ...reviewLimited];
  }
  // 混合顺序：新词穿插在复习之间（每 1 新词后 3 复习）
  const mixed: QueueItem[] = [];
  let ri = 0;
  for (const n of newLimited) {
    mixed.push(n);
    const chunk = reviewLimited.slice(ri, ri + 3);
    mixed.push(...chunk);
    ri += 3;
  }
  if (ri < reviewLimited.length) mixed.push(...reviewLimited.slice(ri));
  return mixed;
}

/* ------------------------------------------------------------------ */
/*  自评更新                                                           */
/* ------------------------------------------------------------------ */

/**
 * 根据自评更新单词记忆状态并落盘。
 *  - again：遗忘 → 稳定性骤降、难度+1、回到 learning。
 *  - hard/good：成功 → 稳定性上升、难度微调、进入 review。
 * 返回更新后的 WordMemory（供弹窗内统计）。
 */
export async function grade(
  word: string,
  rating: ReciteRating,
  memory: ReciteMemory,
  prefs: ReturnType<typeof readRecitePrefs>,
): Promise<WordMemory> {
  const key = word.toLowerCase();
  const m = memory.words[key] ?? initWordMemory();
  memory.words[key] = m;

  // 该词今天是否第一次评分 / 上次评分（用于今日已背、今日评分统计的跨会话去重）
  const today = localDate();
  const prevDay = m.lastReview ? localDate(new Date(m.lastReview)) : "";
  const isFirstToday = prevDay !== today;
  const prevRating = m.lastRating;

  const elapsed = daysSince(m.lastReview);
  const r = m.state === "new" ? 0 : retrievability(elapsed, m.s);

  if (rating === "again") {
    const sBase = m.state === "new" ? initStability("again") : m.s || 1;
    m.s = nextForgetStability(m.d, sBase, r);
    m.d = nextDifficulty(m.d, "again");
    m.state = "learning";
    m.lapses += 1;
  } else {
    // 首次成功：用该评分的初始稳定性/难度；之后按 FSRS 增长
    const sBase = m.state === "new" ? initStability(rating) : m.s || 1;
    const dBase = m.state === "new" ? initDifficulty(rating) : m.d;
    m.s = nextRecallStability(dBase, sBase, r, rating);
    m.d = nextDifficulty(dBase, rating);
    m.state = "review";
  }

  m.r = retrievability(0, m.s);
  m.due = addDays(localDate(), nextInterval(m.s, prefs.desiredRetention));
  m.reps += 1;
  m.lastRating = rating;
  m.lastReview = new Date().toISOString();

  updateStreak(memory);
  // 今日已背计数：该词今天第一次评分才 +1（updateStreak 已处理跨天重置）
  if (isFirstToday) {
    memory.stats.todayCount = (memory.stats.todayCount || 0) + 1;
  }
  // 今日评分统计（跨会话去重：同词今天重评先撤销旧评分，再计入新评分）
  const ts = memory.stats.todayScores ?? { good: 0, hard: 0, again: 0 };
  memory.stats.todayScores = ts;
  if (!isFirstToday && prevRating && prevRating !== rating && ts[prevRating] > 0) {
    ts[prevRating] -= 1;
  }
  if (isFirstToday || prevRating !== rating) {
    ts[rating] = (ts[rating] || 0) + 1;
  }
  await saveMemory(memory);
  return m;
}

/** 便捷：加载记忆（供弹窗/按钮复用）。 */
export function getMemory(): Promise<ReciteMemory> {
  return loadMemory();
}
