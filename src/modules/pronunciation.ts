/**
 * Pronunciation module.
 *
 * - buildTtsFallbackUrls(): 构建 TTS 兜底 URL 链（有道 → Google）。
 * - playAudio(): 播放音频 URL 链（多级回退：主窗口 <audio> → 加载失败自动
 *   切换下一个 URL），供发音按钮点击、自动发音、发音快捷键、生词本面板共用。
 * - setActivePron(): 记录当前悬停弹窗的发音数据（翻译完成后由
 *   hoverTranslate 调用；弹窗清除时置 null）。
 * - installPronunciationShortcut(): 在 reader 窗口安装 keydown
 *   capture 监听，命中「发音快捷键」时播放当前取词单词发音。
 *
 * 设计说明（与加词快捷键对称）：
 *   - 加词快捷键：setActiveAddBtn 记录 +按钮 → 命中后 activeBtn.click()
 *   - 发音快捷键：setActivePron 记录 {audioUrls, win} → 命中后直接播放。
 *     不依赖「发音按钮」是否显示——只要取词翻译完成拿到音频即可。
 *   - 快捷键互斥（发音 vs 加词）由偏好面板的输入层保证（两 pref 值
 *     不相同），本模块不重复校验。
 *
 * 发音优先级（用户需求，弹窗与面板统一）：
 *   1. 当前词典源的真人发音（tr.task.audio / dictResult.audio）
 *   2. 有道 TTS 合成（国内可达）
 *   3. Google TTS 合成（最终兜底）
 * playAudio 依次尝试，前一来源加载失败自动切换下一个。
 */
import { getPref } from "../utils/prefs";
import { parseKeybinding, matchesKeybinding } from "./addWordShortcut";

/**
 * 构建 TTS 兜底 URL 链：有道优先（国内可达，英文词 type=1 英音），
 * Google TTS 最终兜底（按 lang 合成，支持多语言）。语言取 eudicLanguage。
 */
export function buildTtsFallbackUrls(word: string, lang?: string): string[] {
  const w = encodeURIComponent(word || "");
  const l = encodeURIComponent(lang || (getPref("eudicLanguage") as string) || "en");
  return [
    `https://dict.youdao.com/dictvoice?audio=${w}&type=1`,
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${l}&q=${w}`,
  ];
}

/**
 * 播放音频 URL 链。依次尝试，当前 URL 加载失败（error/abort 事件）或
 * play() 被拒绝时自动切换下一个；全部失败输出 debug 日志。
 *
 * 创建位置优先级：
 *   1. 主窗口 document —— chrome 环境无 CSP / autoplay 限制（实测可靠；
 *      reader viewer.html 的 CSP 会拦截外部音频加载，不能作为首选）
 *   2. 传入的 win（reader inner window）document —— 点击事件发生地有用户
 *      激活，仅当主窗口不可用时使用
 *   3. 全局 Audio 构造器（参考项目 zotero-pdf-translate 的实现）
 * 同一元素串行换 src 重试，避免并发。
 */
/**
 * 模块级单例 <audio> 元素（主窗口 document 创建，chrome 无 CSP/autoplay
 * 限制）。v0.4.x P4 修复：playAudio 每次新建独立 <audio> 会导致同一 keydown
 * 事件触发 2 次 handler 时物理上并发双声（attachToReader 竞态装 2 份监听）。
 * 单例化后，新调用先 pause() 旧播放再换 src——无论上游触发几次，同一时刻
 * 只有一个 <audio> 在播。
 */
let sharedAudio: any = null;

/** 获取/重建单例 audio 元素（原 playAudio 内三级创建逻辑上移）。 */
function ensureSharedAudio(win?: Window): any {
  if (
    sharedAudio &&
    typeof sharedAudio.pause === "function" &&
    sharedAudio.isConnected !== false
  ) {
    return sharedAudio;
  }
  sharedAudio = null;
  try {
    const mainWin = (globalThis as any).Zotero?.getMainWindow?.();
    if (mainWin?.document) {
      sharedAudio = mainWin.document.createElement("audio");
      sharedAudio.style.display = "none";
    }
  } catch { /* ignore */ }
  if (!sharedAudio && win?.document) {
    try {
      sharedAudio = win.document.createElement("audio");
      sharedAudio.style.display = "none";
    } catch { /* ignore */ }
  }
  if (!sharedAudio) {
    try {
      sharedAudio = new ((globalThis as any).Audio)();
    } catch { /* ignore */ }
  }
  return sharedAudio;
}

/** 200ms 内同一首 URL 链的重复触发视为同一次播放意图（防御性去抖）。 */
let lastPlayAt = 0;
let lastPlayKey = "";

/** 当前播放中状态回调（单例：新播放取代旧播放时旧回调先置 false）。 */
let playingStateCb: ((playing: boolean) => void) | null = null;

/**
 * 统一的播放状态通知入口（方案 1，对齐 +按钮模式）：播放成功立即亮均衡器、
 * 跳过闪烁，一个状态一个图标，颜色全程平稳。false=立即恢复图标。
 */
function firePlaying(cb: ((playing: boolean) => void) | null | undefined, on: boolean): void {
  if (!cb) return;
  try { cb(on); } catch { /* ignore */ }
}

export function playAudio(
  urls: string | string[],
  win?: Window,
  flashBtn?: HTMLButtonElement | null,
  /** 播放状态回调：true=开始播放，false=播放结束/全部失败/被新播放取代 */
  onPlaying?: (playing: boolean) => void,
): void {
  const list = (Array.isArray(urls) ? urls : [urls]).filter((u) => !!u);
  if (list.length === 0) return;
  // v0.4.x P4 防御：同 URL 链 200ms 内重复触发只播一次（keydown 监听可能被
  // 多次触发 / 多个窗口同时命中）。按钮 click 场景单次调用不受影响。
  const now = Date.now();
  if (list[0] === lastPlayKey && now - lastPlayAt < 200) return;
  lastPlayKey = list[0];
  lastPlayAt = now;

  let idx = 0;
  let audio = ensureSharedAudio(win);
  let settled = false;
  // 播放中状态回调管理：新播放取代旧播放时先把旧的置 false（单例化语义）
  if (playingStateCb && playingStateCb !== onPlaying) {
    firePlaying(playingStateCb, false);
  }
  playingStateCb = onPlaying ?? null;
  // 当前正在尝试的 URL。所有失败回调（error/abort/play-reject）都绑定
  // URL 身份：仅当 currentUrl 仍是触发失败的那个 URL 时才切换——防止
  // play() 被拒 + error 事件对同一 URL 双触发导致跳过下一个来源。
  let currentUrl = "";

  const tryNext = (reason?: string) => {
    if (settled) return;
    if (idx >= list.length) {
      settled = true;
      firePlaying(playingStateCb, false);
      playingStateCb = null;
      try {
        (globalThis as any).Zotero?.debug?.(
          `[hover-translate-eudic] playAudio: all ${list.length} source(s) failed` +
          (reason ? ` (last: ${reason})` : ""),
        );
      } catch { /* ignore */ }
      return;
    }
    const url = list[idx++];
    if (!audio) {
      // 元素创建失败（ensureSharedAudio 已尝试三级回退）
      settled = true;
      try {
        (globalThis as any).Zotero?.debug?.(
          "[hover-translate-eudic] playAudio: cannot create <audio> element",
        );
      } catch { /* ignore */ }
      return;
    }
    const onFail = (reason: string) => {
      if (settled) return;
      if (currentUrl !== url) return; // 该失败已不属于当前 URL（已切换/已换 src）
      tryNext(reason);
    };
    try {
      audio.onerror = () => onFail("load-error");
      audio.onabort = () => onFail("abort");
      currentUrl = url;
      audio.src = url;
      audio.load();
      const p: any = audio.play();
      if (p && typeof p.catch === "function") {
        p.then(() => {
          if (currentUrl === url) {
            settled = true; // 播放已开始
            // 播放中状态：延迟300ms亮均衡器（先让闪烁反馈走完，见 firePlaying）
            firePlaying(onPlaying, true);
            try {
              audio.onended = () => {
                firePlaying(onPlaying, false);
                playingStateCb = null;
              };
            } catch { /* ignore */ }
            // 播放成功反馈（方案 1，对齐 +按钮模式）：有均衡器回调时跳过
            // 闪烁——均衡器立即出场即"播放中"的确认，闪烁的 brightness
            // 压暗会与 #ccc 竖条叠加造成颜色突跳。无回调场景保留闪烁。
            if (flashBtn && !onPlaying) flashPronButton(flashBtn);
          }
        }).catch(() => {
          if (currentUrl === url) onFail("play-rejected");
        });
      }
    } catch (e) {
      if (currentUrl === url) tryNext(String((e as any)?.message || e));
    }
  };

  // v0.4.x P4 单例化：新调用先停掉上一个播放，杜绝同 URL 并发双声。
  try {
    if (audio && typeof audio.pause === "function") audio.pause();
  } catch { /* ignore */ }

  tryNext();
}

/**
 * 播放成功时的发音按钮反馈（自动发音 / 快捷键触发场景，让用户知道
 * 当前播放的是哪个词的发音）。样式与 applyBtnFeedback 的按下状态一致：
 * 即时变暗 + 微缩（无过渡），保持 ~130ms 后平滑恢复。
 */
export function flashPronButton(btn: HTMLButtonElement | null | undefined): void {
  try {
    if (!btn || !btn.isConnected) return;
    btn.style.transition = "color 0.2s, border-color 0.2s, box-shadow 0.2s";
    btn.style.filter = "brightness(0.75)";
    btn.style.transform = "scale(0.92)";
    btn.style.boxShadow = "0 0 8px rgba(128,128,128,0.4)";
    setTimeout(() => {
      try {
        if (!btn.isConnected) return;
        btn.style.transition =
          "color 0.2s, border-color 0.2s, box-shadow 0.2s, filter 0.15s, transform 0.15s";
        btn.style.filter = "brightness(1)";
        btn.style.transform = "scale(1)";
        btn.style.boxShadow = "none";
      } catch { /* ignore */ }
    }, 130);
  } catch {
    /* ignore */
  }
}

/** 当前活跃的发音数据（最后取词的弹窗）。 */
interface ActivePron {
  audioUrls: string[];
  win: Window;
  /** 当前弹窗的发音按钮（播放成功时对其做反馈动画；可为 null）。 */
  pronBtn?: HTMLButtonElement | null;
}
let activePron: ActivePron | null = null;

/** 设置/清空当前活跃发音数据（翻译完成时设置，弹窗清除时置 null）。 */
export function setActivePron(data: ActivePron | null): void {
  activePron = data;
}

/** 供调试。 */
export function getActivePron(): ActivePron | null {
  return activePron;
}

/** True when the event target is an editable field (never trigger shortcuts). */
function isEditableEventTarget(target: EventTarget | null): boolean {
  const element =
    target && (target as { nodeType?: number }).nodeType === 1
      ? (target as Element)
      : null;
  return !!element?.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  );
}

/**
 * Install a keydown (capture) listener on `win` that plays the current
 * hovered word's pronunciation when the configured shortcut is pressed.
 * @returns cleanup function.
 */
export function installPronunciationShortcut(win: Window): () => void {
  const handler = (ev: KeyboardEvent) => {
    try {
      const raw = getPref("pronunciationShortcut") as string;
      if (!raw) return; // empty = disabled
      const kb = parseKeybinding(raw);
      if (!kb || !matchesKeybinding(ev, kb)) return;
      if (isEditableEventTarget(ev.target)) return; // typing in inputs
      if (!activePron || !activePron.audioUrls?.length) return; // no current word
      ev.preventDefault();
      ev.stopPropagation();
      // 快捷键触发：播放成功时发音按钮做按下反馈（有按钮才传，避免误反馈）
      const pronBtn = activePron.pronBtn || null;
      playAudio(
        activePron.audioUrls,
        activePron.win,
        pronBtn,
        // 快捷键路径同样显示播放中均衡器动画（与点击/自动路径对齐）
        (playing) => setPronPlaying(pronBtn, playing),
      );
    } catch {
      /* never break the event chain */
    }
  };
  win.addEventListener("keydown", handler, true);
  return () => win.removeEventListener("keydown", handler, true);
}

/* ------------------------- 播放中状态（均衡器动画） ------------------------- */

/** 均衡器动画样式（三竖条交替压缩，参考 loading-20，缩放至 28px 按钮内）。
 *  只注入一次/文档；颜色 currentColor 跟随按钮 --hte-raw 灰色。 */
export function ensureEqStyle(doc: Document): void {
  const STYLE_ID = "hte-pron-eq-style";
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.hte-playing { width:18px; height:20px; display:inline-flex; align-items:center; justify-content:center; gap:3px; pointer-events:none; color:#cccccc; }
.hte-playing span { width:3px; border-radius:2px; background:currentColor; display:block; animation:hte-eq .5s ease-in-out infinite alternate; }
.hte-playing span:nth-child(1) { height:16px; animation-delay:0s; }
.hte-playing span:nth-child(2) { height:8px;  animation-delay:.17s; }
.hte-playing span:nth-child(3) { height:12px; animation-delay:.34s; }
@keyframes hte-eq { from { height:16px; } to { height:4px; } }`;
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

/** 切换发音按钮的播放中图标（on=true 显示均衡器动画，false 恢复喇叭图标）。
 *  原始图标在 maybeAddPronunciationButton 创建时存于 __hteIcon。 */
export function setPronPlaying(
  btn: HTMLButtonElement | null | undefined,
  on: boolean,
): void {
  try {
    if (!btn || !btn.isConnected) return;
    const icon = (btn as any).__hteIcon as string | undefined;
    if (!icon) return;
    if (on) {
      const doc = btn.ownerDocument;
      if (doc) ensureEqStyle(doc);
      btn.innerHTML =
        `<span class="hte-playing"><span></span><span></span><span></span></span>`;
    } else {
      btn.innerHTML = icon;
    }
  } catch { /* ignore */ }
}
