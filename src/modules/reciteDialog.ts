/**
 * 背诵弹窗 UI（reciteDialog.ts）。
 *
 * 遮罩挂主窗口 documentElement（mountOverlay），自注入 recite 样式（幂等，
 * 前缀 hte-recite-*）。亮暗色走 Zotero 主题变量 + prefers-color-scheme 回退。
 *
 * 发音接口（参考 zotero-pdf-translate）：有道 dictvoice 真人发音，
 *   - 英音 type=1 / 美音 type=2，按 reciteAccent 选择；
 *   - Google TTS 兜底。播放复用 pronunciation.playAudio（含 reciteSpeakRate 速率）。
 * 释义：直接展示生词本已有 exp（加词时已翻译），不重复请求。
 *
 * 布局（定稿预览）：
 *  - 标题栏三段：背诵(粗体左) | 待复习 N · 新词 M(居中) | ✕(右)
 *  - 进度条独占一行（绿色填充）；「已背 X/N」与 [上一个][下一个] 同行左右分布
 *  - 卡片（min-height 220px）：单词居中 → [美] 音标 🔊 → 分隔线 → 提示/背面
 *  - 自评：认识(1) → 模糊(2) → 忘记(3)（左到右）
 *  - 底部统计左右分布：左"连续背诵 X 天 · 今日已背 N"，右"认识 a · 模糊 b · 忘记 c"
 */

import { loadWords, refreshAllPanels } from "./wordbookPanel";
import { buildQueue, grade, readRecitePrefs, splitSyllables } from "./recite";
import {
  loadMemory,
  saveMemory,
  todayDueCount,
  localDate,
  type ReciteMemory,
  type ReciteRating,
} from "./reciteMemory";
import { playAudio } from "./pronunciation";
import { getPref, setPref } from "../utils/prefs";
import { getAllReaders } from "../utils/window";
import { config } from "../../package.json";

const RECITE_STYLE_ID = "hte-recite-dialog-style";

/* ------------------------------------------------------------------ */
/*  样式                                                               */
/* ------------------------------------------------------------------ */

const RECITE_CSS = `
.hte-recite-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;outline:none;}
.hte-recite-dlg{box-sizing:border-box;width:540px;max-width:94vw;background:var(--color-background,#fff);border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.28);padding:16px 18px;color:var(--fill-primary,#1a1a1a);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;display:flex;flex-direction:column;gap:10px;}
/* 标题栏：中间信息居中，✕ 绝对定位右侧 */
.hte-recite-title{display:flex;align-items:center;position:relative;}
.hte-recite-title-mid{flex:1;text-align:center;color:var(--fill-secondary,#666);font-size:13px;font-weight:400;}
.hte-recite-close{position:absolute;right:0;top:50%;transform:translateY(-50%);cursor:pointer;opacity:.6;font-size:16px;line-height:1;padding:2px 6px;}
.hte-recite-close:hover{opacity:1;}
/* 进度条独占一行；已背 + 导航 另一行 */
.hte-recite-bar{height:6px;background:#f0f0f0;border-radius:3px;overflow:hidden;}
.hte-recite-bar-in{height:100%;background:#3aa76d;border-radius:3px;transition:width .2s ease;}
.hte-recite-progressrow{display:flex;align-items:center;justify-content:space-between;}
.hte-recite-progress-txt{color:var(--fill-secondary,#666);font-size:12px;white-space:nowrap;}
.hte-recite-nav{display:flex;gap:6px;}
.hte-recite-nav-btn{border:1px solid var(--color-border,#d4d4d4);background:transparent;color:var(--fill-primary,#333);border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;}
.hte-recite-nav-btn:hover{background:rgba(127,127,127,.12);}
/* 卡片：大 min-height，居中内容，分隔线 */
.hte-recite-card{background:var(--color-background-secondary,#fafafa);border:1px solid var(--color-border,#e0e0e0);border-radius:10px;padding:30px 16px 16px;cursor:pointer;min-height:200px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;text-align:center;}
.hte-recite-word{font-size:26px;font-weight:700;line-height:1.25;word-break:break-word;}
.hte-recite-syl{font-weight:700;}
.hte-recite-syldot{font-weight:400;margin:0 1px;}
.hte-recite-meta{display:flex;align-items:center;gap:6px;margin-top:10px;color:var(--fill-secondary,#666);font-size:13px;}
.hte-recite-accent{font-size:11px;border:1px solid #5a5a5a;border-radius:4px;padding:0 4px;color:#888;line-height:16px;}
.hte-recite-phon{cursor:pointer;}
.hte-recite-phon:hover{opacity:.7;}
.hte-recite-speak{background:transparent;border:none;cursor:pointer;padding:2px;color:inherit;display:inline-flex;align-items:center;}
.hte-recite-speak svg{width:20px;height:20px;display:block;fill:currentColor;}
.hte-recite-divider{width:100%;height:1px;background:var(--color-border,#e5e5e5);margin:14px 0 10px;}
.hte-recite-hint{color:var(--fill-secondary,#999);font-size:13px;}
/* 拼写模式：输入框 + 逐字符对比 */
.hte-recite-spell-input{width:90%;box-sizing:border-box;height:56px;line-height:56px;font-size:26px;font-weight:700;padding:0 12px;border:1px solid var(--color-border,#e0e0e0);border-radius:8px;background:var(--color-background,#fff);color:var(--fill-primary,#1a1a1a);text-align:center;letter-spacing:1px;outline:none;appearance:none;-moz-appearance:none;}
.hte-recite-spell-input:focus{border-color:#2774d9;}
.hte-recite-diff-bad{color:#E24B4A;}
.hte-recite-diff-miss{color:#E24B4A;text-decoration:underline;}
.hte-recite-finish-stats{margin-top:14px;color:var(--fill-secondary,#888);font-size:14px;text-align:center;line-height:1.9;}
.hte-recite-back{width:100%;text-align:center;font-size:15px;line-height:1.6;}
.hte-recite-exp{color:var(--fill-primary,#1a1a1a);}
.hte-recite-sentence{margin-top:8px;font-size:15px;color:var(--fill-secondary,#555);font-style:italic;text-align:left;}
.hte-recite-sentence-cn{margin-top:2px;font-size:14px;color:var(--fill-secondary,#888);font-style:normal;line-height:1.5;}
.hte-recite-sentence-speak{background:transparent;border:none;cursor:pointer;padding:0 3px 0 4px;color:var(--fill-secondary,#888);display:inline-flex;align-items:center;vertical-align:middle;}
.hte-recite-sentence-speak:hover{opacity:.7;}
.hte-recite-sentence-speak svg{width:16px;height:16px;fill:currentColor;}
.hte-recite-sentence-hit{color:var(--fill-primary,#1a1a1a);}
.hte-recite-chip{font-style:normal;font-size:10px;border-radius:4px;padding:0 4px;margin-right:4px;vertical-align:1px;}
.hte-recite-chip-original{background:rgba(39,116,217,.14);color:#2774d9;}
.hte-recite-chip-dict{background:rgba(127,127,127,.16);color:var(--fill-secondary,#777);}
.hte-recite-senexp{margin-top:2px;color:var(--fill-secondary,#888);font-size:12px;}
/* 自评三按钮（左到右 认识/模糊/忘记） */
.hte-recite-actions{display:flex;gap:10px;}
.hte-recite-grade{flex:1;border-radius:8px;padding:15px 0;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s ease;display:flex;align-items:center;justify-content:center;line-height:1;}
.hte-recite-grade:hover{opacity:.82;}
/* 下一个(↵) 确认按钮：蓝色 #4FA1DA（亮色实底白字，暗色透明描边浅蓝字） */
.hte-recite-grade-next{background:#4FA1DA;border:1px solid #4FA1DA;color:#fff;}
/* 底部统计：左右分布 */
.hte-recite-footer{display:flex;align-items:center;justify-content:space-between;color:var(--fill-secondary,#888);font-size:12px;}
@media (prefers-color-scheme: dark){
  .hte-recite-card{background:#1e1e1e;border-color:#3a3a3a;}
  .hte-recite-dlg{background:#232323;border:1px solid var(--color-border,#333);}
  .hte-recite-word{color:#e6e6e6;}
  .hte-recite-meta{color:#9aa0aa;}
  .hte-recite-bar{background:#3a3a3a;}
  .hte-recite-grade-good{background:transparent;border:1px solid #97C459;color:#C0DD97;}
  .hte-recite-grade-hard{background:transparent;border:1px solid #EF9F27;color:#FAC775;}
  .hte-recite-grade-again{background:transparent;border:1px solid #F09595;color:#F7C1C1;}
  .hte-recite-grade-next{background:transparent;border:1px solid #4FA1DA;color:#8FC3E8;}
}
@media (prefers-color-scheme: light){
  .hte-recite-grade-good{background:#8EA88E;border:1px solid #8EA88E;color:#fff;}
  .hte-recite-grade-hard{background:#F4C17F;border:1px solid #F4C17F;color:#fff;}
  .hte-recite-grade-again{background:#ED843F;border:1px solid #ED843F;color:#fff;}
}
`;

function injectReciteStyle(doc: Document): void {
  try {
    doc.getElementById(RECITE_STYLE_ID)?.remove?.();
  } catch { /* ignore */ }
  try {
    const d = doc as any;
    const st: HTMLStyleElement = d.createElementNS
      ? d.createElementNS("http://www.w3.org/1999/xhtml", "style")
      : doc.createElement("style");
    st.id = RECITE_STYLE_ID;
    st.textContent = RECITE_CSS;
    ((doc.head || doc.documentElement) as any)?.append(st);
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  发音 URL（有道 dictvoice 英/美音，参考 zotero-pdf-translate）      */
/* ------------------------------------------------------------------ */

function buildReciteAudioUrls(word: string, accent: string): string[] {
  const w = encodeURIComponent(word || "");
  // 英音 type=1 / 美音 type=2；非 uk 一律按美音
  const type = accent === "uk" ? "1" : "2";
  return [
    `https://dict.youdao.com/dictvoice?audio=${w}&type=${type}`,
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${w}`,
  ];
}

/* ------------------------------------------------------------------ */
/*  词典例句实时查询（例句来源=词典时）                                  */
/*  双通道（pref reciteDictSentenceSource 切换）：                      */
/*    bing   （默认）= 直接解析 cn.bing.com/dict/search 双语例句区        */
/*                     （.se_li > .sen_en/.sen_cn → 英句+中文翻译）      */
/*    youdao         = dict.youdao.com/jsonapi 双语例句（sentence-pair）  */
/*  仅内存缓存，不落盘。不依赖 PDF reader / zotero-pdf-translate。       */
/* ------------------------------------------------------------------ */

/** 词（小写）→ 词典例句 {en 英文句, cn 中文翻译（可为空）}。 */
interface DictSentence {
  en: string;
  cn: string;
}
const dictSentenceCache = new Map<string, DictSentence | null>(); // null=负缓存（已查过但无例句）
/** 词 → 进行中的查询 Promise（防同一词并发重复请求）。 */
const dictSentencePending = new Map<string, Promise<DictSentence | null>>();

/** 常见不规则动词/形容词变形（原形 → 变形词表），用于例句高亮匹配变形词。 */
const IRREGULAR_FORMS: Record<string, string[]> = {
  be: ["am", "is", "are", "was", "were", "been", "being"],
  have: ["has", "had", "having"],
  do: ["does", "did", "done", "doing"],
  go: ["goes", "went", "gone", "going"],
  make: ["makes", "made", "making"],
  take: ["takes", "took", "taken", "taking"],
  get: ["gets", "got", "gotten", "getting"],
  say: ["says", "said", "saying"],
  see: ["sees", "saw", "seen", "seeing"],
  know: ["knows", "knew", "known", "knowing"],
  think: ["thinks", "thought", "thinking"],
  come: ["comes", "came", "coming"],
  give: ["gives", "gave", "given", "giving"],
  find: ["finds", "found", "finding"],
  tell: ["tells", "told", "telling"],
  become: ["becomes", "became", "becoming"],
  show: ["shows", "showed", "shown", "showing"],
  leave: ["leaves", "left", "leaving"],
  feel: ["feels", "felt", "feeling"],
  put: ["puts", "putting"],
  bring: ["brings", "brought", "bringing"],
  begin: ["begins", "began", "begun", "beginning"],
  keep: ["keeps", "kept", "keeping"],
  hold: ["holds", "held", "holding"],
  write: ["writes", "wrote", "written", "writing"],
  stand: ["stands", "stood", "standing"],
  hear: ["hears", "heard", "hearing"],
  mean: ["means", "meant", "meaning"],
  meet: ["meets", "met", "meeting"],
  run: ["runs", "ran", "running"],
  pay: ["pays", "paid", "paying"],
  sit: ["sits", "sat", "sitting"],
  speak: ["speaks", "spoke", "spoken", "speaking"],
  lead: ["leads", "led", "leading"],
  read: ["reads", "reading"],
  grow: ["grows", "grew", "grown", "growing"],
  lose: ["loses", "lost", "losing"],
  fall: ["falls", "fell", "fallen", "falling"],
  send: ["sends", "sent", "sending"],
  build: ["builds", "built", "building"],
  understand: ["understands", "understood", "understanding"],
  draw: ["draws", "drew", "drawn", "drawing"],
  break: ["breaks", "broke", "broken", "breaking"],
  spend: ["spends", "spent", "spending"],
  cut: ["cuts", "cutting"],
  rise: ["rises", "rose", "risen", "rising"],
  drive: ["drives", "drove", "driven", "driving"],
  buy: ["buys", "bought", "buying"],
  wear: ["wears", "wore", "worn", "wearing"],
  choose: ["chooses", "chose", "chosen", "choosing"],
  teach: ["teaches", "taught", "teaching"],
  catch: ["catches", "caught", "catching"],
  fight: ["fights", "fought", "fighting"],
  seek: ["seeks", "sought", "seeking"],
  sleep: ["sleeps", "slept", "sleeping"],
  win: ["wins", "won", "winning"],
  throw: ["throws", "threw", "thrown", "throwing"],
  fly: ["flies", "flew", "flown", "flying"],
  swim: ["swims", "swam", "swum", "swimming"],
  sing: ["sings", "sang", "sung", "singing"],
  drink: ["drinks", "drank", "drunk", "drinking"],
  forget: ["forgets", "forgot", "forgotten", "forgetting"],
  sell: ["sells", "sold", "selling"],
  shoot: ["shoots", "shot", "shooting"],
  steal: ["steals", "stole", "stolen", "stealing"],
  strike: ["strikes", "struck", "striking"],
  good: ["better", "best"],
  bad: ["worse", "worst"],
  little: ["less", "least"],
  much: ["more", "most"],
  many: ["more", "most"],
  far: ["farther", "further", "farthest", "furthest"],
};

/** 当前词典例句通道：bing=必应双语（默认） | youdao=有道词典双语。 */
function dictSentenceSource(): "bing" | "youdao" {
  return (getPref("reciteDictSentenceSource" as any) as string) === "youdao"
    ? "youdao"
    : "bing";
}

/**
 * 给 Promise 加超时兜底：到期返回 fallback，避免网络请求挂起导致查询
 * Promise 永不 settle（表现为例句区一直「查询中」）。底层请求最终自行结束。
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const DICT_FETCH_TIMEOUT_MS = 8000;

/** 方案 B：必应词典双语例句。遍历例句区，取第一条长度适中的 .se_li（英句+中译）。 */
async function fetchBingDictSentence(word: string): Promise<DictSentence | null> {
  const url = `https://cn.bing.com/dict/search?q=${encodeURIComponent(word)}`;
  const xhr = await withTimeout(
    Zotero.HTTP.request("GET", url, { responseType: "text" }),
    DICT_FETCH_TIMEOUT_MS,
    null as any,
  );
  if (!xhr || xhr?.status !== 200) return null;
  const doc = new DOMParser().parseFromString(xhr.response, "text/html");
  const items = Array.from(
    doc.querySelectorAll("#sentenceSeg .se_li") as unknown as Element[],
  );
  for (const li of items) {
    const en = (li.querySelector(".sen_en")?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const cn = (li.querySelector(".sen_cn")?.textContent || "").trim();
    // 跳过劣质超长例句（必应首条常为冗长网络例句）
    if (!en || !cn || en.length > 160) continue;
    return { en, cn };
  }
  return null;
}

/** 备选：有道词典 jsonapi 双语例句（sentence-pair 一次拿英文句 + 中文翻译）。 */
async function fetchYoudaoDictSentence(word: string): Promise<DictSentence | null> {
  const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}&doctype=json`;
  const xhr = await withTimeout(
    Zotero.HTTP.request("GET", url, {
      headers: { Accept: "application/json" },
      responseType: "text",
    }),
    DICT_FETCH_TIMEOUT_MS,
    null as any,
  );
  if (!xhr || xhr?.status !== 200) return null;
  let res: any;
  try {
    res = JSON.parse(xhr.response);
  } catch {
    return null;
  }
  const pairs = res?.blng_sents_part?.["sentence-pair"];
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  for (const p of pairs) {
    const en = (p?.["sentence"] || "").replace(/\s+/g, " ").trim();
    const cn = (p?.["sentence-translation"] || "").trim();
    if (en && en.length <= 160) return { en, cn };
  }
  return null;
}

/**
 * 用 zotero-pdf-translate 翻译源把英文例句翻成中文（例句源无译文时兜底）。
 * 失败静默返回 ""（例句仍以英英展示，不阻塞）。
 */
async function translateSentence(text: string): Promise<string> {
  try {
    const pdf = (Zotero as any).PDFTranslate;
    if (!pdf?.api?.translate) return "";
    const src =
      (Zotero.Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.translateSource",
        true,
      ) as string) || "";
    const langto =
      (Zotero.Prefs.get(
        "extensions.zotero.ZoteroPDFTranslate.targetLanguage",
        true,
      ) as string) || "zh-CN";
    const itemID = (getAllReaders()[0] as any)?.itemID ?? 0;
    const task = await withTimeout(
      pdf.api.translate(text, {
        pluginID: config.addonID,
        service: src || undefined,
        itemID,
        langfrom: "en",
        langto,
      }),
      DICT_FETCH_TIMEOUT_MS,
      null as any,
    );
    if (task?.status === "success" && task?.result) {
      return String(task.result).trim();
    }
    return "";
  } catch {
    return "";
  }
}

/** 原文例句（ctx）的中文译文缓存：文本 → 译文。 */
const originalCnCache = new Map<string, string>();

/** 翻译原文例句为中文（best-effort，失败返回 ""，缓存避免重复翻译）。 */
function fetchOriginalCn(text: string): Promise<string> {
  const hit = originalCnCache.get(text);
  if (hit !== undefined) return Promise.resolve(hit);
  return translateSentence(text).then((cn) => {
    originalCnCache.set(text, cn);
    return cn;
  });
}

/**
 * 实时查当前词的第一条词典例句（含负缓存 + 自动降级 + 译文补齐）：
 *  - 内存缓存命中（含「已查过但无例句」的 null）直接返回，不重复请求；
 *  - bing 优先（双语），失败自动降级 youdao（双语）；
 *  - 例句源无中文译文时 → 用 pdf-translate 翻译源补中文；
 *  - 最终无论成功与否都写缓存（null = 负缓存），同一词并发请求共享 Promise。
 */
export async function fetchDictSentence(word: string): Promise<DictSentence | null> {
  const src = dictSentenceSource();
  // 缓存 key 带 source 前缀：切换「词典例句」来源后 key 变化，立即重新查询（无需重启）
  const key = `${src}:${word.toLowerCase()}`;
  if (dictSentenceCache.has(key)) return dictSentenceCache.get(key) ?? null;
  const running = dictSentencePending.get(key);
  if (running) return running;
  const p = (async () => {
    let found: DictSentence | null = null;
    try {
      if (src === "youdao") {
        found = await fetchYoudaoDictSentence(word);
      } else {
        // bing 优先；失败（反爬/结构变化/无例句）自动降级有道词典
        found = await fetchBingDictSentence(word);
        if (!found) found = await fetchYoudaoDictSentence(word);
      }
      // 兜底：无中文译文时用翻译源补（必应/有道通常自带，此处仅兜底）
      if (found && !found.cn) {
        const cn = await translateSentence(found.en);
        if (cn) found.cn = cn;
      }
    } catch (e: any) {
      try {
        Zotero.debug(
          `[recite] fetchDictSentence: "${word}" 查询异常: ${e?.message || e}`,
        );
      } catch { /* ignore */ }
    }
    dictSentenceCache.set(key, found); // found 为 null 时即负缓存
    try {
      Zotero.debug(
        found
          ? `[recite] fetchDictSentence: "${word}" 例句 OK: ${found.en.slice(0, 50)}${found.cn ? " | " + found.cn.slice(0, 20) : ""}`
          : `[recite] fetchDictSentence: "${word}" 无例句（已负缓存）`,
      );
    } catch { /* ignore */ }
    dictSentencePending.delete(key);
    return found;
  })();
  dictSentencePending.set(key, p);
  return p;

}

/* ------------------------------------------------------------------ */
/*  图标（用户提供的喇叭 SVG）                                         */
/* ------------------------------------------------------------------ */

const SPEAKER_SVG =
  '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M477.099 176.853c50.133 0 90.752 40.661 90.752 90.795v471.168a90.752 90.752 0 0 1-141.099 75.52L314.027 739.2l-105.088-14.165a90.752 90.752 0 0 1-78.507-85.291l-.085-4.693V384.64c0-45.099 33.109-83.371 77.781-89.813l104.533-15.104 109.056-83.968c14.421-11.136 31.83-17.621 49.92-18.731l5.462-.171zm0 65.195a25.6 25.6 0 0 0-15.616 5.29l-115.797 89.174-6.742 5.248-8.49 1.237-113.024 16.299a25.6 25.6 0 0 0-21.93 25.344v250.453a25.6 25.6 0 0 0 22.186 25.344l112.47 15.19 7.466.981 6.272 4.181 118.997 79.36a25.6 25.6 0 0 0 39.808-21.333V267.648a25.6 25.6 0 0 0-25.6-25.6z" fill="currentColor"/>' +
  '<path d="M668.885 350.293a32.597 32.597 0 0 1 45.995 2.304c35.413 39.125 55.893 96.342 55.893 157.483 0 72.107-28.459 138.411-75.52 176.085a32.597 32.597 0 0 1-40.704-50.901c30.72-24.576 51.072-71.979 51.072-125.184 0-45.525-14.848-87.04-39.04-113.792a32.597 32.597 0 0 1 2.304-46.037z" fill="currentColor"/>' +
  '<path d="M758.869 245.888a32.597 32.597 0 0 1 45.696-5.973c71.51 54.827 105.813 156.928 105.813 270.165 0 96.555-49.835 226.731-105.642 270.08a32.597 32.597 0 1 1-39.979-51.413c37.973-29.525 80.47-140.544 80.47-218.667 0-95.019-28.032-178.347-80.342-218.496a32.597 32.597 0 0 1-5.973-45.653z" fill="currentColor"/>' +
  "</svg>";

/* 回车键图标（下一个/完成按钮）：横线 + 右端向上长竖线 + 左箭头，粗 stroke，fill=currentColor 跟随按钮文字色 */
const ENTER_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:17px;height:17px;flex:none;margin-left:2px;display:inline-block;">' +
  '<path d="M3.2 15H13a3.8 3.8 0 0 0 3.8-3.8V5.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M8.2 10.5 3.4 15l4.8 4.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>' +
  "</svg>";

/* ------------------------------------------------------------------ */
/*  DOM 辅助                                                           */
/* ------------------------------------------------------------------ */

function el(
  doc: Document,
  tag: string,
  attrs: Record<string, any> = {},
  children: (Node | string)[] = [],
): HTMLElement {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.setAttribute("class", v);
    else if (k === "style") node.setAttribute("style", v);
    else if (k.startsWith("on")) (node as any)[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(typeof c === "string" ? doc.createTextNode(c) : c);
  }
  return node;
}

/* ------------------------------------------------------------------ */
/*  主入口                                                             */
/* ------------------------------------------------------------------ */

export async function openReciteDialog(): Promise<void> {
  const { platform, words } = await loadWords();
  if (!platform || words.length === 0) {
    try {
      Zotero.getMainWindow()?.alert?.("生词本为空，先添加单词再来背诵吧。");
    } catch { /* ignore */ }
    return;
  }

  const memory = await loadMemory();
  const prefs = readRecitePrefs();
  const queue = buildQueue(words, memory, prefs);
  if (queue.length === 0) {
    try {
      Zotero.getMainWindow()?.alert?.("今日没有待背诵的单词。");
    } catch { /* ignore */ }
    return;
  }

  // 遮罩挂载窗口参考添加术语弹窗：优先当前聚焦窗口顶层，回退主窗口，
  // 保证在独立 PDF 窗口打开背诵时遮罩覆盖正确窗口（而非始终挂主窗口）。
  let doc: Document =
    Zotero.getMainWindow()?.document ?? (globalThis as any).document;
  try {
    const focused = (Services as any)?.focus?.focusedWindow;
    const topWin = focused?.top || (doc.defaultView as any)?.top;
    if (topWin?.document?.documentElement) doc = topWin.document;
  } catch { /* fall through */ }
  if (!doc?.documentElement) {
    doc = Zotero.getMainWindow()?.document ?? (globalThis as any).document;
  }

  injectReciteStyle(doc);

  // 预翻译前几个词的原文例句：翻面/切词时译文已就绪（best-effort，不阻塞弹窗打开）
  if (prefs.showSentence) {
    const preCount = Math.min(5, queue.length);
    for (let i = 0; i < preCount; i++) {
      const q = queue[i];
      if (q.ctx && q.sentenceSource === "original") {
        void fetchOriginalCn(q.ctx);
      }
    }
  }

  // 打开背诵弹窗时自动隐藏侧边栏生词本面板的释义（防止偷看答案）；
  // 关闭弹窗时恢复之前的释义显示状态。
  const prevHideExp = !!getPref("panelHideExp" as any);
  const restorePanelExp = () => {
    try {
      setPref("panelHideExp", prevHideExp);
      refreshAllPanels();
    } catch { /* ignore */ }
  };
  if (!prevHideExp) {
    try {
      setPref("panelHideExp", true);
      refreshAllPanels();
    } catch { /* ignore */ }
  }

  const overlay = buildOverlay(doc, queue, memory, prefs, restorePanelExp);
  // 挂到 doc 的 documentElement（与添加术语弹窗一致的全屏遮罩）
  try {
    (doc.documentElement || doc.body)?.append(overlay);
  } catch {
    try { doc.body?.append(overlay); } catch { /* ignore */ }
  }
  // 把焦点拉到弹窗，保证空格/数字/方向键的 keydown 能被所在窗口捕获
  try { (overlay as HTMLElement).focus?.(); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  弹窗构建                                                           */
/* ------------------------------------------------------------------ */

function buildOverlay(
  doc: Document,
  queue: ReturnType<typeof buildQueue>,
  memory: ReciteMemory,
  prefs: ReturnType<typeof readRecitePrefs>,
  restorePanelExp?: () => void,
): HTMLElement {
  let idx = 0;                 // 当前队列下标
  const initialTotal = queue.length; // 初始词数（进度条分母，插回重现不改变它）
  const counters = { good: 0, hard: 0, again: 0 };
  // 打开弹窗时「今日已背」累计（跨会话）；本次会话新增 = completed.size
  const initialTodayCount = memory.stats.todayCount || 0;
  // 打开弹窗时「今日评分」累计快照（跨会话）；本次会话新增 = counters
  const initialTodayScores = {
    good: memory.stats.todayScores?.good || 0,
    hard: memory.stats.todayScores?.hard || 0,
    again: memory.stats.todayScores?.again || 0,
  };
  // 每个词条的最终评分（按词小写为键，去重：重复评分/返回重评时先撤销旧计数）
  const graded = new Map<string, ReciteRating>();
  // 每个词本次会话已重现次数（限制重现上限，避免无限循环）
  const sessionReps = new Map<string, number>();
  // 已「背完」的词（本次不再重现、最终确定评分）——进度条/已背计数用
  const completed = new Set<string>();
  // 当前词第一段选择的评分（翻面待确认）；null = 未评分
  let pendingRating: ReciteRating | null = null;
  // 是否已完成（结束卡片已显示）
  let finished = false;
  // 是否已翻面（拼写模式下背面显示释义，不能靠 back.style 判断）
  let isFlipped = false;

  const mask = el(doc, "div", { class: "hte-recite-mask", tabindex: "-1" });

  /* ---- 标题栏：待复习 N · 新词 M（居中） | ✕（右） ---- */
  const titleMid = el(doc, "span", { class: "hte-recite-title-mid" }, [
    `待复习 ${todayDueCount(memory)} · 新词 ${newCount(queue)}`,
  ]);
  const closeBtn = el(doc, "span", { class: "hte-recite-close", title: "关闭 (Esc)" }, ["✕"]);
  const title = el(doc, "div", { class: "hte-recite-title" }, [titleMid, closeBtn]);

  /* ---- 进度条独占一行 ---- */
  const barIn = el(doc, "div", { class: "hte-recite-bar-in", style: "width:0%" });
  const bar = el(doc, "div", { class: "hte-recite-bar" }, [barIn]);

  /* ---- 已背 X/N（左） + 上一个/下一个（右） ---- */
  const progressTxt = el(doc, "span", { class: "hte-recite-progress-txt" }, ["已背 ", String(initialTodayCount), " / ", String(initialTodayCount + initialTotal)]);
  const prevBtn = el(doc, "button", { type: "button", class: "hte-recite-nav-btn", title: "上一个 (←/↑)" }, ["上一个"]);
  const nextBtn = el(doc, "button", { type: "button", class: "hte-recite-nav-btn", title: "下一个 (→/↓)" }, ["下一个"]);
  const nav = el(doc, "div", { class: "hte-recite-nav" }, [prevBtn, nextBtn]);
  const progressRow = el(doc, "div", { class: "hte-recite-progressrow" }, [progressTxt, nav]);

  /* ---- 卡片：单词 → 音标 → 分隔线 → 提示/背面 ---- */
  const wordEl = el(doc, "div", { class: "hte-recite-word" });
  // 拼写模式输入框（默认隐藏，拼写模式下替换单词位置）
  const spellInput = el(doc, "input", {
    type: "text",
    class: "hte-recite-spell-input",
    style: "display:none;",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const accentChip = el(doc, "span", { class: "hte-recite-accent" }, [prefs.accent === "uk" ? "英" : "美"]);
  const speakBtn = el(doc, "button", { type: "button", class: "hte-recite-speak", title: "发音", style: "color:inherit;" });
  speakBtn.innerHTML = SPEAKER_SVG;
  const phonEl = el(doc, "span", { class: "hte-recite-phon", title: "点击发音" });
  // 拼写模式提示（替代音标行，默认隐藏）
  const metaHint = el(doc, "span", { class: "hte-recite-hint", style: "display:none;" }, ["输入单词拼写，空格/回车翻面"]);
  const meta = el(doc, "div", { class: "hte-recite-meta" }, [accentChip, phonEl, metaHint, speakBtn]);
  const divider = el(doc, "div", { class: "hte-recite-divider" });
  const hintEl = el(doc, "div", { class: "hte-recite-hint" }, ["点击卡片/空格 翻面显示释义"]);

  // 背面区（释义 + 例句），翻面时替换提示区
  const expEl = el(doc, "div", { class: "hte-recite-exp" });
  const sentenceEl = el(doc, "div", { class: "hte-recite-sentence", style: "display:none;" });
  const back = el(doc, "div", { class: "hte-recite-back", style: "display:none;" }, [expEl, sentenceEl]);

  const card = el(doc, "div", { class: "hte-recite-card" }, [spellInput, wordEl, meta, divider, hintEl, back]);

  // 结束卡片（最后一个词确认后显示）
  const finishStatsEl = el(doc, "div", { class: "hte-recite-finish-stats" });
  const finishCard = el(doc, "div", {
    class: "hte-recite-card",
    style: "display:none;justify-content:center;",
  }, [
    el(doc, "div", { class: "hte-recite-word", style: "font-size:22px;" }, ["本次背诵完成"]),
    finishStatsEl,
  ]);

  /* ---- 自评区：正面三按钮（认识/模糊/忘记）+ 背面确认按钮 ---- */
  const goodBtn = el(doc, "button", { type: "button", class: "hte-recite-grade hte-recite-grade-good" }, ["认识(1)"]);
  const hardBtn = el(doc, "button", { type: "button", class: "hte-recite-grade hte-recite-grade-hard" }, ["模糊(2)"]);
  const againBtn = el(doc, "button", { type: "button", class: "hte-recite-grade hte-recite-grade-again" }, ["忘记(3)"]);
  const gradeActions = el(doc, "div", { class: "hte-recite-actions" }, [goodBtn, hardBtn, againBtn]);

  // 背面确认按钮：记错了(3) 等同「忘记(again)」；下一个(↵) 蓝色 #4FA1DA
  const wrongBtn = el(doc, "button", { type: "button", class: "hte-recite-grade hte-recite-grade-again" }, ["记错了(3)"]);
  const nextConfirmBtn = el(doc, "button", { type: "button", class: "hte-recite-grade hte-recite-grade-next" });
  nextConfirmBtn.innerHTML = "下一个(" + ENTER_SVG + ")";
  const confirmActions = el(doc, "div", { class: "hte-recite-actions", style: "display:none;" }, [wrongBtn, nextConfirmBtn]);

  /* ---- 底部统计：左右分布 ---- */
  const footerLeft = el(doc, "span", {}, [
    `连续背诵 ${memory.stats.streak} 天 · 今日已背 ${initialTodayCount}`,
  ]);
  const footerRight = el(doc, "span", {}, [
    `认识 ${initialTodayScores.good} · 模糊 ${initialTodayScores.hard} · 忘记 ${initialTodayScores.again}`,
  ]);
  const footer = el(doc, "div", { class: "hte-recite-footer" }, [footerLeft, footerRight]);

  const dlg = el(doc, "div", { class: "hte-recite-dlg" }, [title, bar, progressRow, card, finishCard, gradeActions, confirmActions, footer]);
  mask.append(dlg);

  /* ---------------- 渲染 ---------------- */

  function updateFooter(): void {
    // 今日已背 = 打开弹窗时的累计（跨会话） + 本次会话已背完数
    footerLeft.textContent = `连续背诵 ${memory.stats.streak} 天 · 今日已背 ${initialTodayCount + completed.size}`;
    footerRight.textContent = `认识 ${initialTodayScores.good + counters.good} · 模糊 ${initialTodayScores.hard + counters.hard} · 忘记 ${initialTodayScores.again + counters.again}`;
  }

  function renderProgress(): void {
    // 已背/总数 = 跨会话累计（今日已背 + 本次已背完）/（今日已背 + 本次队列）
    const done = initialTodayCount + completed.size;
    const total = initialTodayCount + initialTotal;
    progressTxt.textContent = `已背 ${done} / ${total}`;
    barIn.style.width = `${total > 0 ? (done / total) * 100 : 0}%`;
    updateFooter();
  }

  /** 渲染单词：syllables 为空/单音节时显示原词，否则拆分显示（圆点不加粗）。 */
  function renderWord(word: string, syllables: string[] | null): void {
    wordEl.textContent = "";
    if (!syllables || syllables.length <= 1) {
      wordEl.textContent = word;
      return;
    }
    syllables.forEach((syl, i) => {
      if (i > 0) {
        wordEl.append(el(doc, "span", { class: "hte-recite-syldot" }, ["·"]));
      }
      wordEl.append(el(doc, "span", { class: "hte-recite-syl" }, [syl]));
    });
  }

  /** 逐字符对比拼写：正确字符正常显示，错/漏/多的字符标红（Anki typed answer 风格）。 */
  function renderSpellDiff(correct: string, typed: string): void {
    wordEl.textContent = "";
    const c = correct.trim();
    const t = typed.trim();
    const max = Math.max(c.length, t.length);
    for (let i = 0; i < max; i++) {
      const cc = c[i] || "";
      const tt = t[i] || "";
      const span = el(doc, "span", {});
      if (cc && cc.toLowerCase() === tt.toLowerCase()) {
        span.textContent = cc;                    // 对
      } else if (cc && !tt) {
        span.textContent = cc;                    // 漏写
        span.className = "hte-recite-diff-miss";
      } else if (!cc && tt) {
        span.textContent = tt;                    // 多写
        span.className = "hte-recite-diff-bad";
      } else {
        span.textContent = cc;                    // 错（显示正确字符）
        span.className = "hte-recite-diff-bad";
      }
      wordEl.append(span);
    }
  }

  /**
   * 例句区渲染：
   *  - 原文：有 ctx（PDF 原句）→ 「原文」chip + 句子
   *  - 词典：有缓存句 → 「词典」chip + 句；无 → 占位「例句查询中…」并
   *    异步现查词典服务，完成后校验词未切换则回填（失败/无例句则清空）
   */
  /** 例句区填充词典双语例句：chip + 英文句（行内），中文翻译（下一行小字灰）。 */
  /** 停止正在播放的例句发音（系统 TTS；Google 兜底的 audio 由 playAudio 单例自动停）。 */
  function stopSpeech(): void {
    try {
      const win = (doc.defaultView ?? Zotero.getMainWindow()) as any;
      win?.speechSynthesis?.cancel();
    } catch { /* ignore */ }
  }
  /**
   * 例句发音（国内优先，Google 兜底）：
   *  1) 系统 TTS（Web Speech API，Windows SAPI，离线、国内可用，支持长句特殊字符）
   *  2) Google translate_tts（需梯子）——匿名 XHR 下载绕 chrome:// Referer 的 400
   */
  /** Google TTS 兜底：匿名 XHR 下载（绕 chrome:// Referer 的 400）→ blob 播放。 */
  async function speakGoogle(text: string, rate: number): Promise<void> {
    const lang = (getPref("eudicLanguage" as any) as string) || "en";
    const url =
      `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(text)}`;
    try {
      const xhr = await Zotero.HTTP.request("GET", url, {
        responseType: "arraybuffer",
        anon: true,
        timeout: 8000,
      } as any);
      if (xhr?.response) {
        const blob = new Blob([xhr.response], { type: "audio/mpeg" });
        playAudio([URL.createObjectURL(blob)], undefined, undefined, undefined, rate);
      }
    } catch (e: any) {
      try {
        Zotero.debug(`[recite] speakGoogle download failed: ${e?.message || e}`);
      } catch { /* ignore */ }
    }
  }

  /**
   * 例句发音（国内优先，逐级兜底）：
   *  1) 系统 TTS（Web Speech API，离线、国内可用、支持长句特殊字符）
   *  2) 有道 dictvoice 整句（type+le，简单短句）
   *  3) Google translate_tts（需梯子）
   * 语速用 reciteSentenceSpeakRate（独立于单词 reciteSpeakRate）。
   */
  async function speakText(text: string): Promise<void> {
    if (!text) return;
    const sr = prefs.sentenceSpeakRate;
    const ttsRate = sr === "slow" ? 0.8 : sr === "fast" ? 1.2 : 1;
    const audioRate = sr === "slow" ? 0.75 : sr === "fast" ? 1.25 : 1;
    // 1) 优先系统 TTS（离线，国内直接可用）
    try {
      const win = (doc.defaultView ?? Zotero.getMainWindow()) as any;
      if (win?.speechSynthesis && win.SpeechSynthesisUtterance) {
        const u = new win.SpeechSynthesisUtterance(text);
        u.lang = "en-US";
        u.rate = ttsRate;
        win.speechSynthesis.cancel();
        win.speechSynthesis.speak(u);
        return;
      }
    } catch { /* fall through */ }

    // 2) 有道 dictvoice 整句（失败自动切 Google）
    const type = prefs.accent === "uk" ? "1" : "2";
    const audio = encodeURIComponent(text.replace(/\s+/g, "+")).replace(/%2B/g, "+");
    const youdao = `https://dict.youdao.com/dictvoice?audio=${audio}&type=${type}&le=eng`;
    let googleTried = false;
    playAudio([youdao], undefined, undefined, (playing) => {
      if (!playing && !googleTried) {
        googleTried = true;
        void speakGoogle(text, audioRate);
      }
    }, audioRate);
  }

  /** 例句发音小喇叭按钮：点击朗读传入的例句文本。 */
  function sentenceSpeakBtn(text: string): HTMLElement {
    const spk = el(doc, "button", {
      type: "button",
      class: "hte-recite-sentence-speak",
      title: "播放例句",
    });
    spk.innerHTML = SPEAKER_SVG;
    spk.addEventListener("click", (ev) => {
      ev.stopPropagation();
      speakText(text);
    });
    return spk;
  }

  /**
   * 把例句文本中的当前单词高亮（字母边界 + 忽略大小写），返回可 append 的节点数组。
   * 匹配范围：原词 + 规则屈折后缀（es/est/ing/ed/er/ly/s/d）、辅音+y 变 i
   * （study→studies/studied）、单音节 CVC 双写尾辅音（stop→stopped）、
   * 常见不规则变形（IRREGULAR_FORMS）。字母边界断言避免 "candy" 误命中 "and"。
   */
  function highlightSentenceText(text: string, word: string, hitWord?: string): (string | Node)[] {
    if (!word) return [doc.createTextNode(text)];
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns: string[] = [];
    // 0) 命中的词精确匹配（加词时记录的实际词形，优先，避免靠变形规则猜）
    if (hitWord && hitWord.toLowerCase() !== word.toLowerCase()) {
      patterns.push(hitWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    // 1) 原词 + 规则屈折后缀（长优先）
    patterns.push(`${esc}(?:es|est|ing|ed|er|ly|s|d)?`);
    // 2) 辅音+y 结尾 → y 变 i（study→studies/studied）
    if (/[^aeiou]y$/i.test(word)) {
      const base = word.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      patterns.push(`${base}(?:ies|ied)`);
    }
    // 3) 单音节 CVC 结尾 → 双写尾辅音（stop→stopped/stopping, run→running）
    if (word.length >= 3 && /^[^aeiou]*[aeiou][^aeiou]$/i.test(word)) {
      const last = word[word.length - 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      patterns.push(`${esc}${last}(?:ed|ing)`);
    }
    // 4) 常见不规则变形
    const irr = IRREGULAR_FORMS[word.toLowerCase()];
    if (irr) {
      for (const f of irr) {
        patterns.push(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      }
    }
    const re = new RegExp(`(?<![A-Za-z])(${patterns.join("|")})(?![A-Za-z])`, "gi");
    const parts = text.split(re);
    const out: (string | Node)[] = [];
    parts.forEach((p, i) => {
      if (i % 2 === 1) {
        out.push(el(doc, "span", { class: "hte-recite-sentence-hit" }, [p]));
      } else if (p) {
        out.push(doc.createTextNode(p));
      }
    });
    return out;
  }

  function fillDictSentence(ds: DictSentence | null, word: string): void {
    sentenceEl.textContent = "";
    if (!ds || !ds.en) return;
    const chip = el(doc, "span", { class: "hte-recite-chip hte-recite-chip-dict" }, ["词典"]);
    sentenceEl.append(
      chip,
      sentenceSpeakBtn(ds.en),
      doc.createTextNode(" "),
      ...highlightSentenceText(ds.en, word),
    );
    if (ds.cn) {
      sentenceEl.append(
        el(doc, "div", { class: "hte-recite-sentence-cn" }, [ds.cn]),
      );
    }
    sentenceEl.style.display = "block";
  }

  /** 例句区填充原文例句（chip + 发音按钮 + 文本，命中词/当前单词高亮；cn 为中文译文，可空）。 */
  function fillOriginalSentence(text: string, word: string, cn?: string, hitWord?: string): void {
    sentenceEl.textContent = "";
    const chip = el(doc, "span", { class: "hte-recite-chip hte-recite-chip-original" }, ["原文"]);
    sentenceEl.append(
      chip,
      sentenceSpeakBtn(text),
      doc.createTextNode(" "),
      ...highlightSentenceText(text, word, hitWord),
    );
    if (cn) {
      sentenceEl.append(
        el(doc, "div", { class: "hte-recite-sentence-cn" }, [cn]),
      );
    }
    sentenceEl.style.display = "block";
  }

  /** 显示原文例句 + 异步补中文译文（best-effort，翻译完成后回填）。 */
  function fillOriginalWithCn(text: string, word: string, hitWord?: string): void {
    fillOriginalSentence(text, word, undefined, hitWord);
    void fetchOriginalCn(text).then((cn) => {
      if (!cn || finished) return;
      if (queue[idx]?.word.toLowerCase() === word.toLowerCase()) {
        fillOriginalSentence(text, word, cn, hitWord);
      }
    });
  }

  /**
   * 例句区渲染：
   *  - showSentence=false → 隐藏例句区
   *  - 原文：有 ctx（PDF 原句）→ 「原文」chip + 句子 + 异步译文
   *  - 词典：有缓存句 → 双语「词典」例句；无 → 占位「例句查询中…」并
   *    异步现查（bing 双语 / youdao 双语，按 reciteDictSentenceSource），
   *    完成后校验词未切换则回填；查询失败回退原文 ctx，再无则隐藏。
   */
  function renderSentence(item: ReturnType<typeof buildQueue>[number]): void {
    sentenceEl.textContent = "";
    sentenceEl.style.display = "none";
    if (!prefs.showSentence) return; // 「显示例句」关闭 → 不渲染例句区
    const wordKey = item.word.toLowerCase();

    // 词典例句查询/渲染（缓存优先含负缓存，无则现查；失败回退原文）
    const renderDict = () => {
      const cacheKey = `${dictSentenceSource()}:${wordKey}`;
      if (dictSentenceCache.has(cacheKey)) {
        const cached = dictSentenceCache.get(cacheKey);
        if (cached) {
          fillDictSentence(cached, item.word);
        } else if (item.ctx) {
          // 负缓存：已知无词典例句，直接回退原文，不再重复请求
          fillOriginalWithCn(item.ctx, item.word, item.ctxHit);
        }
        return;
      }
      sentenceEl.textContent = "例句查询中…";
      sentenceEl.style.display = "block";
      void fetchDictSentence(item.word).then((ds) => {
        const still = !finished && queue[idx]?.word.toLowerCase() === wordKey;
        if (!still) return;
        if (ds) {
          fillDictSentence(ds, item.word);
        } else if (item.ctx) {
          // 词典例句查询失败（网络/无例句）：回退显示原文例句，避免例句区空白
          fillOriginalWithCn(item.ctx, item.word, item.ctxHit);
        } else {
          sentenceEl.textContent = "";
          sentenceEl.style.display = "none";
        }
      });
    };

    // 原文模式：有 ctx 显示原文；无原文自动回退词典例句
    if (item.sentenceSource === "original") {
      if (item.ctx) {
        fillOriginalWithCn(item.ctx, item.word, item.ctxHit);
      } else {
        renderDict(); // 该词无原文上下文 → 自动回退词典例句
      }
      return;
    }
    renderDict();
  }

  /** 正面：原词 + 提示，背面隐藏。拼写模式下为「输入框 + 释义提示」。 */
  function showFront(): void {
    stopSpeech();
    const item = queue[idx];
    if (!item) return;
    isFlipped = false;

    const spelling = prefs.mode === "spelling";
    spellInput.style.display = spelling ? "block" : "none";
    wordEl.style.display = spelling ? "none" : "block";
    // 音标行：拼写模式隐藏音标 chip 与音标（避免泄露拼写），保留发音按钮，
    // 音标行位置改为显示提示文字
    accentChip.style.display = spelling ? "none" : "";
    phonEl.style.display = spelling ? "none" : "";
    metaHint.style.display = spelling ? "" : "none";
    if (spelling) {
      spellInput.value = "";
    } else {
      renderWord(item.word, null);                // 正面不拆分
      hintEl.textContent = "点击卡片/空格 翻面显示释义";
    }

    phonEl.textContent = formatPhon(item.phon);
    expEl.textContent = item.exp || "（暂无释义）";
    renderSentence(item);
    // 预翻译后续词的原文例句：翻面/切到下一个词时译文已就绪（best-effort）
    for (let i = 1; i <= 2; i++) {
      const nxt = queue[idx + i];
      if (nxt?.ctx && nxt.sentenceSource === "original") {
        void fetchOriginalCn(nxt.ctx);
      }
    }
    hintEl.style.display = spelling ? "none" : "block"; // 拼写模式提示已在音标行位置，隐藏底部 hint
    // 拼写模式正面即显示释义（作为输入提示）；再认模式背面隐藏
    back.style.display = spelling ? "block" : "none";
    renderProgress();
    if (spelling) {
      // 延迟聚焦：首次打开时元素尚未挂载到 DOM，同步 focus 无效；
      // 挂载后 mask.focus() 会抢走焦点，setTimeout 保证在其后执行
      setTimeout(() => {
        try { spellInput.focus(); } catch { /* ignore */ }
      }, 0);
    }
  }

  /** 背面：拆分词/对比 + 释义 + 例句。 */
  function showBack(): void {
    stopSpeech();
    const item = queue[idx];
    if (!item) return;
    isFlipped = true;

    if (prefs.mode === "spelling") {
      spellInput.style.display = "none";
      wordEl.style.display = "block";
      renderSpellDiff(item.word, spellInput.value);
      // 翻面后恢复音标显示，隐藏提示文字（发音按钮一直显示，无需恢复）
      accentChip.style.display = "";
      phonEl.style.display = "";
      metaHint.style.display = "none";
    } else {
      renderWord(
        item.word,
        prefs.syllableSplit ? splitSyllables(item.word) : null,
      );
    }
    hintEl.style.display = "none";
    back.style.display = "block";
  }

  /** 根据 pendingRating 切换正面三按钮 / 背面确认按钮。 */
  function updateActions(): void {
    const showConfirm = pendingRating !== null;
    gradeActions.style.display = showConfirm ? "none" : "flex";
    confirmActions.style.display = showConfirm ? "flex" : "none";
    // 「忘记」后只有「下一个」；「认识/模糊」后还有「记错了」
    wrongBtn.style.display = pendingRating === "again" ? "none" : "flex";
  }

  /** 纯翻面（卡片点击/空格）：不评分，仅切换正反面。 */
  function flip(): void {
    if (pendingRating) return; // 已评分待确认，不允许再翻回
    if (!isFlipped) {
      showBack();
      speakBackAuto();
    } else {
      showFront();
    }
  }

  /**
   * 翻面后的自动发音（背面）：单词先播（受 autoSpeakWord+autoSpeakAfter 控制），
   * 待单词发音结束（含失败/被取代）后再播例句（受 autoSpeakSentence 控制）。
   * 原因：playAudio 单例化，新播放会先停掉旧播放，若直接并发调用例句会打断单词音。
   */
  function speakBackAuto(): void {
    const playWord = prefs.autoSpeakWord && prefs.autoSpeakAfter;
    // 例句自动发音需「显示例句」开启（例句区隐藏时不念例句）
    const playSentence = prefs.autoSpeakSentence && prefs.showSentence;
    const item = queue[idx];
    if (!playSentence) {
      // 仅单词自动发音：保持原行为
      if (playWord && item) speak();
      return;
    }
    if (!playWord || !item) {
      // 仅例句自动发音 / 无词项：直接播例句
      speakSentence();
      return;
    }
    // 单词 + 例句都开：先播单词，播放结束回调里再播例句
    let done = false; // 防重入（onPlaying(false) 可能被多次触发）
    const rate = prefs.speakRate === "slow" ? 0.75 : prefs.speakRate === "fast" ? 1.25 : 1;
    playAudio(
      buildReciteAudioUrls(item.word, prefs.accent),
      undefined,
      undefined,
      (playing) => {
        if (!playing && !done) {
          done = true;
          speakSentence();
        }
      },
      rate,
    );
  }

  function speak(): void {
    stopSpeech(); // 播单词前停止例句发音
    const item = queue[idx];
    if (item) {
      try {
        Zotero.debug(
          `[recite] speak word=${item.word} autoWord=${prefs.autoSpeakWord} autoBefore=${prefs.autoSpeakBefore}`,
        );
      } catch { /* ignore */ }
      const rate = prefs.speakRate === "slow" ? 0.75 : prefs.speakRate === "fast" ? 1.25 : 1;
      playAudio(buildReciteAudioUrls(item.word, prefs.accent), undefined, undefined, undefined, rate);
    }
  }

  /** 例句发音：原文模式念 ctx；词典模式念词典例句的英文句（未缓存则等待查询，失败回退 ctx）。 */
  function speakSentence(): void {
    if (!prefs.showSentence) return; // 「显示例句」关闭时不念例句
    const item = queue[idx];
    if (!item) return;
    // 词典例句发音（缓存命中直接念，key 带 source；未命中等待现查）
    const speakDict = () => {
      const cached = dictSentenceCache.get(`${dictSentenceSource()}:${item.word.toLowerCase()}`);
      if (cached) {
        speakText(cached.en);
        return;
      }
      void fetchDictSentence(item.word).then((ds) => {
        if (ds?.en) speakText(ds.en);
        else if (item.ctx) speakText(item.ctx); // 词典例句彻底失败才回退原文
      });
    };
    // 词典模式，或原文模式但该词无 ctx → 走词典例句发音（自动回退）
    if (item.sentenceSource === "dict" || !item.ctx) {
      speakDict();
      return;
    }
    // original 且有 ctx：念原文句
    speakText(item.ctx);
  }

  /** 落盘一个最终评分：去重更新 counters（重评时先撤销旧计数），并写 FSRS 记忆。 */
  function commitRating(rating: ReciteRating): void {
    const item = queue[idx];
    if (!item) return;
    const key = item.word.toLowerCase();
    const prev = graded.get(key);
    if (prev) counters[prev] -= 1;
    counters[rating] += 1;
    graded.set(key, rating);
    void grade(item.word, rating, memory, prefs);
    updateFooter();
  }

  /** 正面三按钮：选择评分 → 翻面等待确认。 */
  function pickRating(rating: ReciteRating): void {
    if (pendingRating) return;
    pendingRating = rating;
    showBack();
    updateActions();
    speakBackAuto();
  }

  /** 背面确认：记错了(3)/下一个(↵) → 落盘最终评分，忘记/模糊插回队列稍后再现。 */
  function confirm(finalRating: ReciteRating): void {
    const item = queue[idx];
    if (!item) return;
    commitRating(finalRating);

    // 忘记/模糊的词插回队列，本次会话内稍后再现。
    // 忘记隔 2 个词后再现（快），模糊隔 5 个词后再现（中）；每个词本次最多重现 2 次。
    let willReappear = false;
    if (finalRating === "again" || finalRating === "hard") {
      const key = item.word.toLowerCase();
      const reps = sessionReps.get(key) ?? 0;
      if (reps < 2) {
        sessionReps.set(key, reps + 1);
        const gap = finalRating === "again" ? 2 : 5;
        const insertAt = Math.min(idx + 1 + gap, queue.length);
        queue.splice(insertAt, 0, item);
        willReappear = true;
      }
    }

    // 不再重现 = 本次已背完，才计入「已背」与进度条
    if (!willReappear) {
      completed.add(item.word.toLowerCase());
    }

    if (idx >= queue.length - 1) {
      finish();
    } else {
      idx += 1;
      pendingRating = null;
      showFront();
      updateActions();
      if (prefs.autoSpeakWord && prefs.autoSpeakBefore) speak();
    }
  }

  function finish(): void {
    finished = true;
    // 隐藏正常卡片与正面评分按钮，显示结束卡片
    card.style.display = "none";
    gradeActions.style.display = "none";
    finishCard.style.display = "flex";
    // 按钮区：隐藏「记错了」，把「下一个」改为「完成」（点击关闭弹窗）
    wrongBtn.style.display = "none";
    nextConfirmBtn.innerHTML = "完成(" + ENTER_SVG + ")";
    nextConfirmBtn.title = "完成 (回车)";
    confirmActions.style.display = "flex";
    finishStatsEl.textContent = "";
    finishStatsEl.append(
      el(doc, "div", {}, [`认识 ${initialTodayScores.good + counters.good} · 模糊 ${initialTodayScores.hard + counters.hard} · 忘记 ${initialTodayScores.again + counters.again}`]),
      el(doc, "div", {}, [`连续背诵 ${memory.stats.streak} 天`]),
    );
    renderProgress(); // 进度拉满 100% + 更新进度文案与底部统计（footer 保持与其他卡片一致）
    (goodBtn as HTMLButtonElement).disabled = true;
    (hardBtn as HTMLButtonElement).disabled = true;
    (againBtn as HTMLButtonElement).disabled = true;
  }

  function move(delta: number): void {
    // 结束界面：仅允许「上一个」返回（回到最后一个词的正面），"下一个"无效
    if (finished) {
      if (delta >= 0) return;
      finished = false;
      finishCard.style.display = "none";
      card.style.display = "flex";
      nextConfirmBtn.innerHTML = "下一个(" + ENTER_SVG + ")";
      nextConfirmBtn.title = "下一个 (回车)";
      (goodBtn as HTMLButtonElement).disabled = false;
      (hardBtn as HTMLButtonElement).disabled = false;
      (againBtn as HTMLButtonElement).disabled = false;
      // idx 保持最后一个词，清空评分态回到其正面，可重新评分
      pendingRating = null;
      showFront();
      updateActions();
      if (prefs.autoSpeakWord && prefs.autoSpeakBefore) speak();
      return;
    }

    // 正常 move
    const next = idx + delta;
    if (next < 0 || next >= queue.length) return;
    // 当前词若有未确认评分，先落盘（视为确认），避免切换时丢失；
    // 导航离开视为「背完」，一并计入已背/进度（不重现）
    if (pendingRating) {
      commitRating(pendingRating);
      completed.add(queue[idx].word.toLowerCase());
    }
    idx = next;
    pendingRating = null;
    showFront();
    updateActions();
    // 切换上一个/下一个后，正面自动发音（与评分流程一致，受「显示释义前」控制）
    if (prefs.autoSpeakWord && prefs.autoSpeakBefore) speak();
  }

  /* ---------------- 事件绑定 ---------------- */
  card.addEventListener("click", () => flip());
  // 拼写输入框：点击不冒泡（避免误触发卡片翻面）；回车翻面对比
  spellInput.addEventListener("click", (ev) => {
    ev.stopPropagation();
  });
  spellInput.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      flip();
    }
  });
  speakBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    speak();
  });
  phonEl.addEventListener("click", (ev) => {
    ev.stopPropagation();
    speak();
  });
  // 点击后 blur：防止焦点留在按钮上时按空格再次触发该按钮
  const blurThen = (fn: () => void) => (ev: Event) => {
    (ev.currentTarget as HTMLElement)?.blur?.();
    fn();
  };
  goodBtn.addEventListener("click", blurThen(() => pickRating("good")));
  hardBtn.addEventListener("click", blurThen(() => pickRating("hard")));
  againBtn.addEventListener("click", blurThen(() => pickRating("again")));
  wrongBtn.addEventListener("click", blurThen(() => confirm("again")));
  nextConfirmBtn.addEventListener("click", blurThen(() => {
    if (finished) { close(); return; }
    if (pendingRating) confirm(pendingRating);
  }));
  prevBtn.addEventListener("click", blurThen(() => move(-1)));
  nextBtn.addEventListener("click", blurThen(() => move(1)));

  // 键盘监听绑定到遮罩实际挂载的窗口（doc.defaultView），而非固定主窗口，
  // 保证在独立 PDF 窗口打开背诵时键盘（空格/1/2/3/方向键/Esc）仍可捕获。
  const win = (doc.defaultView as Window | null) ?? Zotero.getMainWindow();
  const close = () => {
    stopSpeech();
    win?.removeEventListener?.("keydown", onKey, true);
    mask.remove();
    try { restorePanelExp?.(); } catch { /* ignore */ }
  };
  closeBtn.addEventListener("click", close);
  mask.addEventListener("click", (ev) => {
    if (ev.target === mask) close();
  });

  // 键盘：空格翻面、1/2/3 评分（正面）、3/4 确认（背面）、方向键导航、Esc 关闭
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") { close(); return; }
    if (finished) {
      // 结束卡片：回车（完成按钮快捷键）也可关闭
      if (ev.key === "Enter") { ev.preventDefault(); close(); return; }
      return;
    }
    if (ev.key === " ") { ev.preventDefault(); flip(); return; }
    if (pendingRating === null) {
      // 正面：1/2/3 评分
      if (ev.key === "1") { pickRating("good"); return; }
      if (ev.key === "2") { pickRating("hard"); return; }
      if (ev.key === "3") { pickRating("again"); return; }
    } else {
      // 背面：3=记错了（仅 good/hard 时），回车=下一个
      if (ev.key === "3" && pendingRating !== "again") { confirm("again"); return; }
      if (ev.key === "Enter") { ev.preventDefault(); confirm(pendingRating); return; }
    }
    if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") { ev.preventDefault(); move(-1); return; }
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") { ev.preventDefault(); move(1); return; }
  };
  win?.addEventListener?.("keydown", onKey, true);

  showFront();
  updateActions();
  if (prefs.autoSpeakWord && prefs.autoSpeakBefore) speak();
  return mask;
}

/* ---------------- 统计辅助 ---------------- */

function newCount(queue: ReturnType<typeof buildQueue>): number {
  return queue.filter((q) => q.isNew).length;
}

/** 归一化音标：phon 存储时已带斜杠（如 /'prematfe(r)/），避免重复包裹成 //...//。 */
function formatPhon(phon: string): string {
  if (!phon) return "";
  const t = phon.trim();
  if (t.startsWith("/") && t.endsWith("/")) return t;
  return `/${t}/`;
}

/* ------------------------------------------------------------------ */
/*  背单词提醒（Zotero 启动钩子调用）                                   */
/* ------------------------------------------------------------------ */

/** 今日是否有待背诵的单词（生词本非空且 buildQueue 非空）。 */
async function hasDueWords(): Promise<boolean> {
  try {
    const { platform, words } = await loadWords();
    if (!platform || words.length === 0) return false;
    const memory = await loadMemory();
    const prefs = readRecitePrefs();
    const queue = buildQueue(words, memory, prefs);
    return queue.length > 0;
  } catch {
    return false;
  }
}

/**
 * 根据 reciteRemind 决定是否自动弹出背诵弹窗。
 *  - none：不弹
 *  - everyOpen：每次打开 Zotero 都弹
 *  - firstOpen：每日第一次打开弹一次（后续不再自动弹）
 */
export async function maybeAutoOpenRecite(): Promise<void> {
  const mode = getPref("reciteRemind" as any) as string;
  if (mode === "everyOpen") {
    // 今日无待背单词则不弹（避免空弹窗）
    if (await hasDueWords()) void openReciteDialog();
    return;
  }

  if (mode === "firstOpen") {
    const memory = await loadMemory();
    const today = localDate();
    if (memory.stats.lastRemindDay === today) return;
    if (!(await hasDueWords())) return; // 今日无待背单词，不弹也不标记
    memory.stats.lastRemindDay = today;
    await saveMemory(memory);
    void openReciteDialog();
  }
}
