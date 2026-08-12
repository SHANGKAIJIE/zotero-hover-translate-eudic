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
export function playAudio(
  urls: string | string[],
  win?: Window,
  flashBtn?: HTMLButtonElement | null,
): void {
  const list = (Array.isArray(urls) ? urls : [urls]).filter((u) => !!u);
  if (list.length === 0) return;
  let idx = 0;
  let audio: any = null;
  let settled = false;
  // 当前正在尝试的 URL。所有失败回调（error/abort/play-reject）都绑定
  // URL 身份：仅当 currentUrl 仍是触发失败的那个 URL 时才切换——防止
  // play() 被拒 + error 事件对同一 URL 双触发导致跳过下一个来源。
  let currentUrl = "";

  const tryNext = (reason?: string) => {
    if (settled) return;
    if (idx >= list.length) {
      settled = true;
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
      // 1. 主窗口 document（chrome 无 CSP / autoplay 限制，实测可靠）
      try {
        const mainWin = (globalThis as any).Zotero?.getMainWindow?.();
        if (mainWin?.document) {
          audio = mainWin.document.createElement("audio");
          audio.style.display = "none";
        }
      } catch { /* ignore */ }
      // 2. 事件源 document（点击场景保留用户激活；仅主窗口不可用时使用）
      if (!audio && win?.document) {
        try {
          audio = win.document.createElement("audio");
          audio.style.display = "none";
        } catch { /* ignore */ }
      }
      // 3. Audio 构造器
      if (!audio) {
        try {
          audio = new ((globalThis as any).Audio)();
        } catch { /* ignore */ }
      }
      if (!audio) {
        settled = true;
        try {
          (globalThis as any).Zotero?.debug?.(
            "[hover-translate-eudic] playAudio: cannot create <audio> element",
          );
        } catch { /* ignore */ }
        return;
      }
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
            // 播放成功 → 按钮反馈（自动发音 / 快捷键场景；点击场景由 mousedown 反馈）
            if (flashBtn) flashPronButton(flashBtn);
          }
        }).catch(() => {
          if (currentUrl === url) onFail("play-rejected");
        });
      }
    } catch (e) {
      if (currentUrl === url) tryNext(String((e as any)?.message || e));
    }
  };

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
        btn.style.boxShadow = "0 0 4px rgba(128,128,128,0.15)";
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
      playAudio(activePron.audioUrls, activePron.win, activePron.pronBtn || null);
    } catch {
      /* never break the event chain */
    }
  };
  win.addEventListener("keydown", handler, true);
  return () => win.removeEventListener("keydown", handler, true);
}
