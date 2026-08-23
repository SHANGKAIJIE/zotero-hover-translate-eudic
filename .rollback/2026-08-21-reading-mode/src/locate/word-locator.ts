/**
 * word-locator.ts —— 单词定位（Phase 2，对外主入口）。
 *
 * 定位管线（单流数据，无 textLayer↔chars 两流对齐）：
 *  1. A 通道 range 推导真实悬停页（findPageIndexFromRange）；
 *  2. 鼠标坐标 → PDF 坐标（viewBox 比例主 / convertToPdfPoint 兜底）；
 *  3. 句子定位（过渡锚点）：sentenceAtPoint 把候选空间缩窄到句内 words；
 *  4. 单词定位（句内三重消歧）：
 *     ① 官方 wordBreakAfter 词边界内 normalizeWord 文本匹配；
 *     ② 前后 2 词上下文指纹（A 侧 DOM vs C 侧 chars 流）——唯一 → 锁定；
 *     ③ 鼠标坐标距离（rect 中心）——多候选时取最近；
 *     （外加行归属校验兜底：候选中心与鼠标 Y 差 ≤ 1.8×行高）
 *  5. 零文本候选（A 词与 chars 流不一致：ignorable/连字/拼写）→ 官方
 *     getClosestWord 语义取最近词 + 词相似度宽松校验。
 */

import type {
  LocatedWord,
  PageBundle,
  PdfRect,
  WordSpan,
} from "./types";
import {
  contextAroundWord,
  fullAnchorRect,
  getClosestWord,
  getPageBundle,
  normalizeWord,
  rectsDist,
  rectsForAnchors,
} from "./page-bundle";
import { sentenceAtPoint } from "./sentence-locator";
import { expandLigatures } from "../modules/util";

export type { LocatedWord } from "./types";

export interface LocateWordInput {
  /** reader 实例（页缓存 key）。 */
  reader: object;
  /** 事件窗口（reader.html），用于 XPC 桥接与 DOM 查询。 */
  innerWin: Window;
  /** A 通道取词文本。 */
  word: string;
  /** A 通道 range（真实页推导 + A 侧上下文词）。 */
  range: Range;
  /** A 通道 range 的视口 rects（range.getClientRects，阶段一：行归属判定的浏览器权威几何）。 */
  rangeRects?: ViewportRect[];
  /** 鼠标坐标（iframe viewport 系）。 */
  mouseX?: number;
  mouseY?: number;
}

/** 定位结果：命中词 / 词间隙（词间空白处）/ 失败。 */
export type LocateResult = LocatedWord | null | { gap: true };

/** 上下文指纹（A 侧 DOM 提取）。 */
interface DomContext {
  prev2: string;
  prev1: string;
  curr: string;
  next1: string;
  next2: string;
}

/**
 * 单词定位主入口。返回：
 *  - LocatedWord：命中；
 *  - { gap: true }：鼠标在词间空白处（不高亮、不显示弹窗）；
 *  - null：定位失败（调用方走既有兜底）。
 */
export async function locateWord(
  input: LocateWordInput,
): Promise<LocateResult> {
  const { reader, innerWin, word, range, rangeRects, mouseX, mouseY } = input;
  try {
    // 1. 真实悬停页（range 推导，非焦点页）
    const pageIndex = findPageIndexFromRange(range);
    if (pageIndex < 0) {
      logLocate(`locateWord: no page from range`);
      return null;
    }

    // 2. 单流页面数据
    const bundle = await getPageBundle(reader, innerWin, pageIndex);
    if (!bundle) {
      logLocate(`locateWord: no bundle page ${pageIndex}`);
      return null;
    }

    // 3. 鼠标 → PDF 坐标
    let px: number | undefined;
    let py: number | undefined;
    if (typeof mouseX === "number" && typeof mouseY === "number") {
      const pt = clientPointToPdfPoint(innerWin, pageIndex, mouseX, mouseY, bundle);
      if (pt) {
        px = pt.x;
        py = pt.y;
      }
    }
    // 4. 词间隙判定【前置】(v0.4.x P2 核心修复)：鼠标不落在任何字符
    //    rect 内（行间距/词边缘/页边）→ 直接 gap（保持或清除），不再进入
    //    定位管线。
    if (px !== undefined && py !== undefined && isInGap(bundle, px, py)) {
      const kept = gapKeep(innerWin, bundle, px, py);
      if (kept) return kept;
      return { gap: true };
    }
    // 5. 句子过渡锚点 + 句内单词消歧
    const located = locateWordOnPage(bundle, word, range, innerWin, px, py, rangeRects, mouseY);
    if (located) {
      return located;
    }
    return null;
  } catch (e) {
    logLocate(`locateWord error: ${String((e as any)?.message || e)}`);
    return null;
  }
}

/**
 * 页面级单词定位：句子内三重消歧。
 */
export function locateWordOnPage(
  bundle: PageBundle,
  hitWord: string,
  range: Range,
  innerWin: Window,
  px?: number,
  py?: number,
  aRects?: ViewportRect[],
  mouseY?: number,
): LocatedWord | null {
  const normHit = normalizeWord(hitWord);
  if (!normHit) return null;

  // 阶段一（v0.3.6）：A 通道 DOM 行锚点——鼠标所指词的浏览器权威几何
  // （range.getClientRects），行归属判定优先用它而非换算后的 py，
  // 根治坐标换算（viewBox/convertToPdfPoint）误差对选行的影响。
  const aRow = aRowAnchor(aRects, mouseY);

  // 候选空间：句内 words（坐标可用时）；坐标不可用退化为全页。
  let sentence = null as { words: WordSpan[] } | null;
  if (px !== undefined && py !== undefined) {
    sentence = sentenceAtPoint(bundle, { x: px, y: py });
  }
  // P1-C v0.4.x：句子定位失败 → 行级候选空间优先（中间层）。
  let space = sentence?.words?.length ? sentence.words : [];
  if (!space.length && py !== undefined) {
    const row = snapToTextRow(bundle, py);
    if (row) {
      const rowThr = Math.max(1, row.height);
      space = bundle.words.filter((w) => {
        const wcy = (w.rect[1] + w.rect[3]) / 2;
        return Math.abs(wcy - row.cy) <= rowThr;
      });
    }
  }
  // 问题A修复（v0.4.x P3）：全页兜底前先按 viewport（页 viewBox）限定——
  // 词边缘/行间距处 sentence/row 均失败时，旧实现直接 space = 全页 words，
  // 候选集扩大让滞回机制在整页范围挑"同词实例"产生跨段/跨行错误粘附
  // （报告 §3.2 根因）。现在先限定到鼠标所在可视区域（参考
  // zotero-ai-sidebar closestAnchorIndex 单页几何最近邻思想）。
  if (!space.length) {
    const vb = bundle.viewBox;
    // 鼠标坐标可用时：限定到以鼠标为中心的视口窗口（页坐标）
    if (py !== undefined && vb && vb[2] > vb[0] && vb[3] > vb[1]) {
      const vbW = vb[2] - vb[0];
      const vbH = vb[3] - vb[1];
      // 可视窗口：以鼠标点为中心、约 0.6 页宽的矩形（PDF 页宽≈1-2 屏宽）
      const halfW = vbW * 0.3;
      const halfH = vbH * 0.3;
      const winL = px !== undefined ? px - halfW : vb[0];
      const winR = px !== undefined ? px + halfW : vb[2];
      const winT = py - halfH;
      const winB = py + halfH;
      const inView = bundle.words.filter((w) => {
        const r = w.rect;
        const cx = (r[0] + r[2]) / 2;
        const cy = (r[1] + r[3]) / 2;
        return cx >= winL && cx <= winR && cy >= winT && cy <= winB;
      });
      if (inView.length > 0) space = inView;
      else space = bundle.words; // 极罕见：窗口内无词 → 仍兜底
    } else {
      space = bundle.words;
    }
  }
  if (!space.length) return null;

  // ① 官方词边界内文本匹配。
  // A 通道取词只含连续字母段（"prior-based" → "prior"），而 C 通道
  // wordBreakAfter 把连字符词切为整词（"prior-based"）。因此候选匹配
  // 支持「hitWord 是候选词的连字符段之一」。
  const hitSegments = wordSegments(hitWord);
  const matchCandidates = (pool: WordSpan[]): WordSpan[] =>
    pool.filter((w) => {
      if (normalizeWord(w.text) === normHit) return true;
      return wordSegments(w.text).some((seg) => hitSegments.includes(seg));
    });
  let candidates = matchCandidates(space);

  if (candidates.length === 1) {
    // ① 单候选行归属校验（v0.3.6 修复）
    if (px !== undefined || aRow) {
      if (!rowCheckPass(innerWin, bundle, candidates[0], aRow, py)) {
        return null;
      }
    }
    return toLocated(bundle, candidates[0], px);
  }

  // ② 多候选 → 上下文指纹（A 侧 DOM 前2后2 vs C 侧 chars 流）
  if (candidates.length > 1) {
    const aCtx = wordsAroundRange(innerWin, range);
    if (aCtx && cleanCtx(aCtx.curr) === normHit) {
      // 快速路径：全等指纹（前2后2逐词一致）
      const matched = candidates.filter((w) => {
        const cCtx = contextAroundWord(bundle, w, 2);
        return (
          cleanCtx(cCtx.before) === cleanCtx(`${aCtx.prev2} ${aCtx.prev1}`) &&
          cleanCtx(cCtx.after) === cleanCtx(`${aCtx.next1} ${aCtx.next2}`)
        );
      });
      if (matched.length === 1) {
        // ② 唯一命中同样做行归属校验
        if (px !== undefined || aRow) {
          if (!rowCheckPass(innerWin, bundle, matched[0], aRow, py)) {
            return null;
          }
        }
        return toLocated(bundle, matched[0], px);
      }
      if (matched.length > 1) {
        candidates = matched; // 指纹缩窄后仍多 → 坐标裁决
      } else {
        // P1-D v0.4.x：全等指纹无一命中→降级滑动窗口 LCS 部分匹配
        const aSeq = ctxWords(`${aCtx.prev2} ${aCtx.prev1} ${aCtx.next1} ${aCtx.next2}`);
        if (aSeq.length >= 2) {
          let best: WordSpan | null = null;
          let bestScore = 0;
          let bestScoreCount = 0;
          let runnerUp = 0;
          for (const w of candidates) {
            const cCtx4 = contextAroundWord(bundle, w, 4);
            const cSeq = ctxWords(`${cCtx4.before} ${cCtx4.after}`);
            const score = lcsLen(aSeq, cSeq);
            if (score > bestScore) {
              runnerUp = bestScore;
              bestScore = score;
              best = w;
              bestScoreCount = 1;
            } else if (score === bestScore && score > 0) {
              bestScoreCount++;
            } else if (score > runnerUp) {
              runnerUp = score;
            }
          }
          const minScore = Math.min(2, aSeq.length);
          if (
            best &&
            bestScore >= minScore &&
            bestScoreCount === 1 &&
            bestScore > runnerUp
          ) {
            if (px !== undefined || aRow) {
              if (!rowCheckPass(innerWin, bundle, best, aRow, py)) {
                return null;
              }
            }
            return toLocated(bundle, best, px);
          }
          if (bestScore > 0) {
            logLocate(
              `[S2b] LCS best=${bestScore} runner=${runnerUp} count=${bestScoreCount} → 坐标裁决`,
            );
          }
        }
      }
    }
  }
  // ③ 多候选 → 行锁定 + 鼠标坐标距离（rect 中心 vs 鼠标）
  if (candidates.length > 1 && px !== undefined && py !== undefined) {
    // 行锁定 + 行吸附（v0.3.6 修复）：先用 py 确定鼠标所在文本行
    // （行间距处吸附到最近行），候选只保留该行内的词。
    const row = snapToTextRow(bundle, py);
    if (row) {
      const rowThr = Math.max(1, row.height * 1.0);
      const inRow = candidates.filter((w) => {
        const wcy = (w.rect[1] + w.rect[3]) / 2;
        return Math.abs(wcy - row.cy) <= rowThr;
      });
      if (inRow.length === 1) {
        // P2-F v0.4.x：行锁定后行内唯一 → 直接采用（过行校验）
        if (rowCheckPass(innerWin, bundle, inRow[0], aRow, py)) {
          return toLocated(bundle, inRow[0], px);
        }
        return null;
      }
      if (inRow.length > 1) candidates = inRow;
    }

    // 方案 B（滞回）：词边缘/同词多实例时，若鼠标与【距鼠标最近的同词
    // 实例】的距离 ≤ 其他候选最小距离 + 容差，则保持上次命中。
    // 问题A修复（v0.4.x P3）：sameBest 必须按【距鼠标】选取，而非距上次
    // rect——旧实现按距 prevRect 选，鼠标移到下行同词旁时 sameBest 仍是
    // 上行实例，导致高亮"粘"在旧行（报告 §3.1 根因）。滞回只允许在
    // "鼠标确实靠近某同词实例"时生效，不再允许跨行粘附。
    const prevLocated = (innerWin as any)?.__hteLastLocated as
      | { word?: string; rects?: PdfRect[] }
      | null
      | undefined;
    const prevWord = prevLocated?.word;
    const prevRect = prevLocated?.rects?.[0];
    if (prevWord && prevRect) {
      const prevNorm = normalizeWord(prevWord);
      const same = candidates.filter((w) => normalizeWord(w.text) === prevNorm);
      if (same.length > 0) {
        // P3 修复：sameBest 按距鼠标选取（同词候选中距离鼠标最近者）
        let sameBest: WordSpan = same[0];
        let sameBestD = Infinity;
        for (const w of same) {
          const d = rectsDist(w.rect, [px, py, px, py]);
          if (d < sameBestD) {
            sameBestD = d;
            sameBest = w;
          }
        }
        // 滞回前提：鼠标必须【足够接近 sameBest】（≤ 上次词外包矩形 × 0.8），
        // 否则不进入滞回——鼠标已移到远处（换词/换行）时直接走坐标裁决。
        const mouseD = rectsDist(sameBest.rect, [px, py, px, py]);
        const prevW = Math.max(1, prevRect[2] - prevRect[0]);
        const prevH = Math.max(1, prevRect[3] - prevRect[1]);
        const keepWindow = Math.max(prevW, prevH) * 0.8;
        if (mouseD <= keepWindow) {
          let minOther = Infinity;
          for (const w of candidates) {
            if (w === sameBest) continue;
            const d = rectsDist(w.rect, [px, py, px, py]);
            if (d < minOther) minOther = d;
          }
          // P3 修复：容差收紧——不再用 max(4, h*0.3, w*0.5)（宽词容差过大
          // 是跨行粘附的直接推手），改为固定小容差 max(4, 行高×0.25)。
          const tol = Math.max(
            4,
            (sameBest.rect[3] - sameBest.rect[1]) * 0.25,
          );
          if (mouseD <= minOther + tol) {
            if (rowCheckPass(innerWin, bundle, sameBest, aRow, py)) {
              return toLocated(bundle, sameBest, px);
            }
          }
        }
        // 未满足滞回 → 落入下方坐标裁决（P3 防跨行粘附）
      }
    }

    let best: WordSpan | null = null;
    let bestDist = Infinity;
    for (const w of candidates) {
      const d = rectsDist(w.rect, [px, py, px, py]);
      if (d < bestDist) {
        bestDist = d;
        best = w;
      }
    }
    if (best) {
      // 行归属校验兜底：候选与鼠标行严重不符（不同行）→ 拒绝
      if (!rowCheckPass(innerWin, bundle, best, aRow, py)) {
        return null;
      }
      return toLocated(bundle, best, px);
    }
  }

  // ④ 零文本候选（A 词与 chars 流不一致）→ 行窗口约束 + 更严相似度 + 行校验
  if (px !== undefined && py !== undefined) {
    const rowH = maxRowHeight(bundle, py);
    const rowPool = bundle.words.filter((w) => {
      const cy = (w.rect[1] + w.rect[3]) / 2;
      return Math.abs(cy - py) <= rowH * 1.5;
    });
    const pool = rowPool.length > 0 ? rowPool : bundle.words;
    const closest = getClosestWord(bundle, [px, py, px, py], pool);
    if (closest && wordSimilarEnough(normHit, normalizeWord(closest.text), pool !== bundle.words)) {
      if (px !== undefined || aRow) {
        if (!rowCheckPass(innerWin, bundle, closest, aRow, py)) {
          return null;
        }
      }
      return toLocated(bundle, closest, px);
    }
  }

  return null;
}

/** 构造对外 LocatedWord。
 *  px 可用且候选词为复合词（含分隔符）时，按鼠标 X 位置拆分到所属段
 *  （"geometry-limited" 指向 geometry 段 → 只高亮 geometry）——
 *  翻译仍用 A 通道原始词，不受影响。 */
function toLocated(
  bundle: PageBundle,
  word: WordSpan,
  px?: number,
): LocatedWord {
  const seg = pickSegment(bundle, word, px);
  const startAnchor = seg?.startAnchor ?? word.startAnchor;
  const endAnchor = seg?.endAnchor ?? word.endAnchor;
  const rects = rectsForAnchors(bundle, startAnchor, endAnchor);
  const chars = bundle.chars.filter(
    (ch) =>
      ch.offset >= bundle.anchors[startAnchor]?.charIndex &&
      ch.offset <= bundle.anchors[endAnchor]?.charIndex,
  );
  return {
    word: seg ? chars.map((c) => c.c).join("") : word.text,
    rects,
    chars,
    bundle,
  };
}

/** 复合词按鼠标 X 选段。非复合词（≤1 段）或 px 不可用返回 null（整词）。
 *  段边界 = 非字母字符（- + / 等分隔符）；鼠标落在分隔符上时取最近段。 */
function pickSegment(
  bundle: PageBundle,
  word: WordSpan,
  px?: number,
): { startAnchor: number; endAnchor: number } | null {
  if (px === undefined) return null;
  const anchors = bundle.anchors;
  // 词内 anchor 按字母段分组（分隔符字符为切分点）
  const segments: Array<Array<{ index: number; char: string }>> = [];
  let current: Array<{ index: number; char: string }> = [];
  const flush = () => {
    if (current.length) {
      segments.push(current);
      current = [];
    }
  };
  for (let i = word.startAnchor; i <= word.endAnchor; i++) {
    const anchor = anchors[i];
    if (!anchor) break;
    const ch = bundle.chars[anchor.charIndex];
    const c = ch?.c ?? "";
    if (/[A-Za-z0-9\u00C0-\u024F\uFB00-\uFB06]/.test(c)) {
      current.push({ index: i, char: c });
    } else {
      flush();
    }
  }
  flush();
  if (segments.length <= 1) return null; // 非复合词 → 整词

  // 选 px 所在段（X 覆盖；否则取最近段）
  let best: Array<{ index: number; char: string }> | null = null;
  let bestDist = Infinity;
  for (const seg of segments) {
    const xs = seg.map((s) => anchors[s.index]);
    const x0 = Math.min(...xs.map((a) => a.x));
    const x1 = Math.max(...xs.map((a) => a.x + a.width));
    if (px >= x0 && px <= x1) {
      return {
        startAnchor: seg[0].index,
        endAnchor: seg[seg.length - 1].index,
      };
    }
    const dist = px < x0 ? x0 - px : px - x1;
    if (dist < bestDist) {
      bestDist = dist;
      best = seg;
    }
  }
  if (!best) return null;
  return {
    startAnchor: best[0].index,
    endAnchor: best[best.length - 1].index,
  };
}

/**
 * 词相似度校验（对称化，Bug B 修复点3）。
 *
 * 旧的 startsWith 前缀匹配天然不对称：`"classi".startsWith("classification")`
 * 为 false 但 `"classification".startsWith("classi")` 为 true —— 导致"前半
 * 位置高亮整词、后半位置不高亮"的不对称现象。这里改为【对称】判断：
 *
 *  - 子串关系（shorter 是 longer 的子串）仅当覆盖度（长度比）达标才接受，
 *    前后半段行为一致（都接受或都拒绝）；
 *  - 编辑距离阈值对两个方向等价。
 *
 * strict 用于④行窗口兜底（候选池限定在鼠标行内）——更严：
 * 覆盖度 ≥ 0.75 / 编辑距离 ≤ 15%；宽松：覆盖度 ≥ 0.6 / 编辑距离 ≤ 25%。
 */
function wordSimilarEnough(a: string, b: string, strict?: boolean): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  const shorter = la <= lb ? a : b;
  const longer = la <= lb ? b : a;
  const minCover = strict ? 0.75 : 0.6;
  const maxDistRatio = strict ? 0.15 : 0.25;
  if (shorter.length >= 3 && longer.includes(shorter)) {
    if (shorter.length / longer.length >= minCover) return true;
  }
  const dist = levenshtein(a, b);
  return dist <= Math.max(1, Math.floor(Math.max(la, lb) * maxDistRatio));
}

function levenshtein(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + cost,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/** 从 A 通道 range 的 DOM 文本提取上下文（前2后2词，小写规范化）。 */
function wordsAroundRange(
  innerWin: Window,
  range: Range,
): DomContext | null {
  try {
    const node = range.startContainer;
    if (!node || node.nodeType !== 3) return null;
    const text = (node as Text).data || "";
    let cs = Math.min(Math.max(0, range.startOffset), text.length);
    let ce = cs;
    while (cs > 0 && isWordChar(text[cs - 1])) cs--;
    while (ce < text.length && isWordChar(text[ce])) ce++;
    const curr = text.slice(cs, ce).toLowerCase();
    if (!curr) return null;

    let beforeText = text.slice(0, cs);
    let el = (node as Text).parentElement;
    let prev = el?.previousElementSibling;
    while (prev && beforeText.length < 200) {
      beforeText =
        (prev.textContent || "").replace(/[ \t]+$/, "") + " " + beforeText;
      prev = prev.previousElementSibling;
    }
    let afterText = text.slice(ce);
    let next = el?.nextElementSibling;
    while (next && afterText.length < 200) {
      afterText += " " + (next.textContent || "").replace(/^[ \t]+/, "");
      next = next.nextElementSibling;
    }

    const prevs: string[] = [];
    {
      let p = beforeText.replace(/\s+$/, "");
      for (let k = 0; k < 2; k++) {
        const m = p.match(/[A-Za-z\u00C0-\u024F\uFB00-\uFB06]+$/);
        if (!m) break;
        prevs.push(m[0].toLowerCase());
        p = p.slice(0, p.length - m[0].length).replace(/\s+$/, "");
      }
    }
    const nexts: string[] = [];
    {
      let q = afterText.replace(/^\s+/, "");
      for (let k = 0; k < 2; k++) {
        const m = q.match(/^[A-Za-z\u00C0-\u024F\uFB00-\uFB06]+/);
        if (!m) break;
        nexts.push(m[0].toLowerCase());
        q = q.slice(m[0].length).replace(/^\s+/, "");
      }
    }
    return {
      prev2: prevs[1] ?? "",
      prev1: prevs[0] ?? "",
      curr,
      next1: nexts[0] ?? "",
      next2: nexts[1] ?? "",
    };
  } catch {
    return null;
  }
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9\u00C0-\u024F\uFB00-\uFB06]/.test(ch);
}

/** 上下文词规范化：去标点/大小写。连字先展开（ﬁ→fi）再剔除非字母——
 * 与 C 通道 normalizeWord 保持一致，否则 A 侧含连字的上下文词
 * （"classiﬁcation"）会被剔除成 "classication"，指纹比对失败。 */
function cleanCtx(s: string): string {
  return expandLigatures(s || "")
    .toLowerCase()
    .replace(/[^A-Za-z\u00C0-\u024F]/g, "");
}

/** 按非字母分隔符切段（"prior-based" → ["prior","based"]）。连字先展开。 */
function wordSegments(text: string): string[] {
  return expandLigatures(text || "")
    .toLowerCase()
    .split(/[^a-z\u00C0-\u024F]+/)
    .filter((seg) => seg.length > 0);
}

/** 上下文串 → 规范化词数组（供 LCS 滑动窗口匹配）。 */
function ctxWords(s: string): string[] {
  return (s || "")
    .split(/\s+/)
    .map((x) => cleanCtx(x))
    .filter((x) => x.length > 0);
}

/** 两词序列的 LCS 长度（经典 DP；用于 P1-D 指纹部分匹配）。 */
function lcsLen(a: string[], b: string[]): number {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * 从 A 通道 range 推导鼠标实际所在页（0-based）。
 * range.startContainer 位于鼠标命中的 textLayer 节点，向上找 .page。
 */
function findPageIndexFromRange(range: Range): number {
  try {
    let el: HTMLElement | null =
      (range.startContainer?.parentElement as HTMLElement | null) ?? null;
    while (el) {
      if (
        typeof el.matches === "function" &&
        el.matches(".page[data-page-number]")
      ) {
        const n = parseInt(el.getAttribute("data-page-number") || "", 10);
        return isNaN(n) ? -1 : n - 1;
      }
      el = el.parentElement as HTMLElement | null;
    }
  } catch {
    /* ignore */
  }
  return -1;
}

/**
 * 鼠标视口坐标 → PDF 用户坐标。
 * 主路径：viewBox 比例映射（pageEl 渲染尺寸 ↔ viewBox 线性映射，天然包含
 * 全部 CSS transform，与高亮渲染同基准，无 convertToPdfPoint 左偏问题）。
 * 兜底：viewport.convertToPdfPoint。
 */
export function clientPointToPdfPoint(
  innerWin: Window,
  pageIndex: number,
  clientX: number,
  clientY: number,
  bundle: PageBundle,
): { x: number; y: number } | null {
  try {
    const doc = innerWin.document;
    const pageEl = doc.querySelector(
      `.page[data-page-number="${pageIndex + 1}"]`,
    ) as HTMLElement | null;
    if (!pageEl) return null;
    const pr = pageEl.getBoundingClientRect();
    if (!pr || pr.width <= 0 || pr.height <= 0) return null;
    const relX = clientX - pr.left;
    const relY = clientY - pr.top;

    const vb = bundle.viewBox;
    if (vb && vb[2] > vb[0] && vb[3] > vb[1]) {
      const px = vb[0] + (relX / pr.width) * (vb[2] - vb[0]);
      const py = vb[3] - (relY / pr.height) * (vb[3] - vb[1]);
      return { x: px, y: py };
    }

    // 兜底：pdf.js viewport 换算
    const app = (innerWin as any).wrappedJSObject?.PDFViewerApplication
      ?? (innerWin as any).PDFViewerApplication;
    const viewport = app?.pdfViewer?._pages?.[pageIndex]?.viewport;
    if (viewport?.convertToPdfPoint) {
      const [px, py] = viewport.convertToPdfPoint(relX, relY);
      if (Number.isFinite(px) && Number.isFinite(py)) return { x: px, y: py };
    }
    return null;
  } catch {
    return null;
  }
}

function logLocate(msg: string): void {
  try {
    (globalThis as any).Zotero?.debug?.(`[hte-loc] ${msg}`);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * 渲染辅助（视口坐标换算 / 弹窗锚定）—— 供 hoverTranslate 渲染层使用。
 * ------------------------------------------------------------------ */

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * PDF rects → page 局部视口坐标（挂 pageEl position:absolute 直接使用）。
 * 主路径：pdf.js viewport.convertToViewportPoint（与 canvas 像素对齐）；
 * 兜底：viewBox 比例映射（pageEl 渲染尺寸）。
 */
export function pdfRectsToViewport(
  innerWin: Window,
  bundle: PageBundle,
  rects: PdfRect[],
): { rects: ViewportRect[]; pageEl: HTMLElement | null } {
  const out: ViewportRect[] = [];
  let pageEl: HTMLElement | null = null;

  try {
    const app = (innerWin as any).wrappedJSObject?.PDFViewerApplication
      ?? (innerWin as any).PDFViewerApplication;
    const page = app?.pdfViewer?._pages?.[bundle.pageIndex];
    const viewport = page?.viewport;
    pageEl = page?.div ?? null;
    if (viewport?.convertToViewportPoint) {
      for (const r of rects) {
        const [x1, y2] = viewport.convertToViewportPoint(r[0], r[1]);
        const [x2, y1] = viewport.convertToViewportPoint(r[2], r[3]);
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.max(1, Math.abs(x2 - x1));
        const height = Math.max(1, Math.abs(y2 - y1));
        if (
          isFinite(left) && isFinite(top) && isFinite(width) && isFinite(height)
        ) {
          out.push({ left, top, width, height });
        }
      }
      if (out.length) return { rects: out, pageEl };
    }
  } catch {
    /* fall through */
  }

  try {
    if (!pageEl) {
      const app = (innerWin as any).wrappedJSObject?.PDFViewerApplication
        ?? (innerWin as any).PDFViewerApplication;
      pageEl = app?.pdfViewer?._pages?.[bundle.pageIndex]?.div ?? null;
    }
    const pr = pageEl?.getBoundingClientRect?.();
    const vb = bundle.viewBox;
    if (pr && vb && vb[2] > vb[0] && vb[3] > vb[1]) {
      const w = vb[2] - vb[0];
      const h = vb[3] - vb[1];
      for (const r of rects) {
        out.push({
          left: ((r[0] - vb[0]) / w) * pr.width,
          top: ((vb[3] - r[3]) / h) * pr.height,
          width: Math.max(1, ((r[2] - r[0]) / w) * pr.width),
          height: Math.max(1, ((r[3] - r[1]) / h) * pr.height),
        });
      }
      return { rects: out, pageEl };
    }
  } catch {
    /* ignore */
  }
  return { rects: out, pageEl };
}

/**
 * 命中词包围盒（视口坐标，弹窗锚定用）。
 * 跨行词（行尾断词 obscurer → ob 一块 + scurer 一块）时,若提供 mouseY,
 * 选鼠标所在的那一块作为锚点——弹窗贴近鼠标指向的行,而非两行的并集
 * （并集会弹窗悬在两行中间/距词过远）。无 mouseY 或单块时退化为并集。
 * 返回 null 表示无可用几何。
 */
export function wordAnchorFromLocated(
  innerWin: Window,
  located: LocatedWord,
  mouseY?: number,
): { x: number; top: number; bottom: number } | null {
  const { rects: vp, pageEl } = pdfRectsToViewport(
    innerWin,
    located.bundle,
    located.rects,
  );
  if (!vp.length) return null;
  let offX = 0;
  let offY = 0;
  try {
    const pr = pageEl?.getBoundingClientRect?.();
    if (pr) {
      offX = pr.left;
      offY = pr.top;
    }
  } catch {
    /* ignore */
  }
  // 跨行多块：按鼠标 Y 选最近块（视口坐标比较）
  let chosen = vp;
  if (vp.length > 1 && typeof mouseY === "number") {
    let best = null as typeof vp[0] | null;
    let bestDist = Infinity;
    for (const r of vp) {
      const midY = r.top + r.height / 2 + offY;
      const d = Math.abs(mouseY - midY);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    if (best) chosen = [best];
  }
  const x = Math.min(...chosen.map((r) => r.left)) + offX;
  const top = Math.min(...chosen.map((r) => r.top)) + offY;
  const bottom = Math.max(...chosen.map((r) => r.top + r.height)) + offY;
  return { x, top, bottom };
}

/** 判断命中点是否落在字符间隙（词间空白）。
 *  行锁定：只在命中点所在行（±1.2 字高窗口）内查找字符——邻行字符
 *  不得参与覆盖判定；行内无字符（行间隙/页边）→ 非 gap（保高亮）。 */
export function isInGap(
  bundle: PageBundle,
  px: number,
  py: number,
): boolean {
  const chars = bundle.chars;
  const ch = chars[0];
  if (!ch) return true;
  const defaultFontSize = ch.fontSize || (ch.rect ? ch.rect[3] - ch.rect[1] : 12);
  const tol = Math.max(1, defaultFontSize) * 0.15;
  for (const ch of chars) {
    const r = ch.rect;
    if (!r) continue;
    const fontSize = Math.max(1, ch.fontSize || (r[3] - r[1]));
    const chTol = Math.max(1, fontSize) * 0.15;
    if (
      px >= r[0] - chTol &&
      px <= r[2] + chTol &&
      py >= r[1] - chTol &&
      py <= r[3] + chTol
    ) {
      return false;
    }
  }
  return true;
}

/** 多个 PDF rect 的外包矩形（union）。 */
function unionPdfRects(rects: PdfRect[]): PdfRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    if (r[0] < x0) x0 = r[0];
    if (r[1] < y0) y0 = r[1];
    if (r[2] > x1) x1 = r[2];
    if (r[3] > y1) y1 = r[3];
  }
  return [x0, y0, x1, y1];
}

/**
 * P0-B 保持窗口：gap 但鼠标距上次高亮词很近（≤ max(词宽,行高)×1.2 且
 * 同页）→ 返回上次 located 保持高亮（防闪烁 / 防词边缘误清除）。
 * 阈值同时覆盖水平（词边缘：词宽方向）与垂直（行间距：行高方向）。
 */
export function gapKeep(
  innerWin: Window,
  bundle: PageBundle,
  px: number,
  py: number,
): LocatedWord | null {
  try {
    const last = (innerWin as any).__hteLastLocated as
      | { rects?: PdfRect[]; bundle?: PageBundle; word?: string }
      | null
      | undefined;
    if (!last?.rects?.length) return null;
    if (last.bundle !== bundle) return null;
    const lastRect = unionPdfRects(last.rects);
    const dist = rectsDist([px, py, px, py], lastRect);
    const w = Math.max(1, lastRect[2] - lastRect[0]);
    const h = Math.max(1, lastRect[3] - lastRect[1]);
    // 问题A修复（v0.4.x P3）：gap 保持必须【不跨行】。
    // 旧实现 dist ≤ max(w,h)*1.2 —— 宽词（如 80px）阈值可达 96px，远超行高，
    // 鼠标移到相邻行同词旁的间隙时仍保持上一行高亮（报告 §3.3 根因）。
    // 收紧：
    //  1. 垂直方向：鼠标与上次词中心 Y 差 > 行高 → 判定不同行 → 不保持；
    //  2. 水平方向：只允许"词边缘间隙"级别（≤ 词高 × 1.0）。
    const lastCy = (lastRect[1] + lastRect[3]) / 2;
    const dy = Math.abs(py - lastCy);
    if (dy > h * 1.0) return null; // 垂直已到另一行 → 不保持（防跨行粘附）
    const lastCx = (lastRect[0] + lastRect[2]) / 2;
    const dx = Math.abs(px - lastCx);
    if (dx > w + h * 1.0) return null; // 水平超出词缘+一行间隙 → 不保持
    if (dist <= Math.max(h, 8)) return last as LocatedWord;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 阶段一（v0.3.6）：从 A 通道 range 视口 rects 中选行锚点——
 * 取与鼠标 Y 最近的 rect 作为「鼠标所指词」的浏览器权威几何。
 */
function aRowAnchor(
  aRects: ViewportRect[] | undefined,
  mouseY: number | undefined,
): { top: number; left: number; width: number; height: number } | null {
  if (!aRects || aRects.length === 0) return null;
  if (typeof mouseY !== "number") return null;
  let best = aRects[0];
  let bestD = Infinity;
  for (const r of aRects) {
    const d = Math.abs(mouseY - (r.top + r.height / 2));
    if (d < bestD) { bestD = d; best = r; }
  }
  return { top: best.top, left: best.left, width: Math.max(1, best.width), height: Math.max(1, best.height) };
}

/** 候选词 C 通道 rect → 全局视口坐标的 rect（渲染同源转换）。 */
function candidateViewportRect(
  innerWin: Window,
  bundle: PageBundle,
  w: WordSpan,
): { top: number; left: number; width: number; height: number } | null {
  const vp = pdfRectsToViewport(innerWin, bundle, [w.rect]);
  if (!vp.rects.length) return null;
  let offX = 0, offY = 0;
  try {
    const pr = vp.pageEl?.getBoundingClientRect?.();
    offX = pr?.left ?? 0;
    offY = pr?.top ?? 0;
  } catch { /* ignore */ }
  return { top: vp.rects[0].top + offY, left: vp.rects[0].left + offX, width: Math.max(1, vp.rects[0].width), height: Math.max(1, vp.rects[0].height) };
}

/**
 * 行归属校验：候选词是否与鼠标在同一行。
 * 双通道行判定：py 判定 + A 通道判定。
 */
function rowCheckPass(
  innerWin: Window,
  bundle: PageBundle,
  w: WordSpan,
  aRow: { top: number; left: number; width: number; height: number } | null,
  py: number | undefined,
): boolean {
  if (aRow) {
    const cv = candidateViewportRect(innerWin, bundle, w);
    if (cv) {
      const ax = aRow.left + aRow.width / 2;
      const cx = cv.left + cv.width / 2;
      // P2-E v0.4.x：X 重合容差收紧——max(词宽, 锚宽) × 0.6 + 6
      const span = Math.max(cv.width, aRow.width) * 0.6 + 6;
      if (Math.abs(cx - ax) <= span) return true;
      const thr = Math.max(10, Math.max(aRow.height, cv.height) * 1.0);
      const passA = Math.abs(cv.top - aRow.top) <= thr;
      const passP = typeof py === "number"
        ? Math.abs(py - (w.rect[1] + w.rect[3]) / 2) <= Math.max(16, (w.rect[3] - w.rect[1]) * 1.8)
        : null;
      if (passP !== null) return passA || passP;
      return passA;
    }
  }
  if (typeof py === "number") {
    const cy = (w.rect[1] + w.rect[3]) / 2;
    const thr = Math.max(16, (w.rect[3] - w.rect[1]) * 1.8);
    return Math.abs(py - cy) <= thr;
  }
  return true;
}

/** A 通道 range → 视口 rects（range.getClientRects，全局视口坐标）。 */
export function rangeViewportRects(range: Range): ViewportRect[] {
  try {
    const rects = range.getClientRects();
    if (!rects) return [];
    return Array.from(rects).map((r) => ({ top: r.top, left: r.left, width: r.width, height: r.height }));
  } catch {
    return [];
  }
}

/**
 * 行锁定 / 行吸附：以 py 确定鼠标所在文本行。
 */
function snapToTextRow(
  bundle: PageBundle,
  py: number,
): { cy: number; height: number } | null {
  let best: { cy: number; height: number } | null = null;
  let bestDist = Infinity;
  for (const w of bundle.words) {
    const cy = (w.rect[1] + w.rect[3]) / 2;
    const h = Math.max(1, w.rect[3] - w.rect[1]);
    const d = Math.abs(py - cy);
    if (d < bestDist) { bestDist = d; best = { cy, height: h }; }
  }
  return best;
}

/** py 附近文本行的行高估算。 */
function maxRowHeight(bundle: PageBundle, py: number): number {
  const hs: number[] = [];
  for (const w of bundle.words) {
    const cy = (w.rect[1] + w.rect[3]) / 2;
    if (Math.abs(cy - py) <= 80) hs.push(Math.max(1, w.rect[3] - w.rect[1]));
  }
  if (!hs.length) return 16;
  hs.sort((x, y) => x - y);
  return hs[Math.floor(hs.length / 2)];
}
