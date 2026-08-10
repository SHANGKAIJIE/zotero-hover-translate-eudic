/**
 * Wordbook panel — PDF 右侧生词本面板（Item Pane）。
 *
 * 通过 Zotero.ItemPaneManager.registerSection 将生词本注册为右侧面板：
 *  - 顶部工具栏：隐藏释义 / 隐藏音标 / 放大字体 / 缩小字体 / 清空
 *  - 单词卡片：第一行 单词（点击跳转原文）+ 音标；第二行 字典释义；
 *    卡片右侧 编辑 / 删除 按钮
 *  - 数据源：本地生词表（CSV）或 Zotero 笔记；编辑/删除同步修改底层数据
 *  - 高度限制：列表 max-height + overflow-y:auto，超出滚动展示
 *  - UI 态持久化：隐藏释义/音标、字体大小存 pref，跨重启记忆
 *
 * 仅当生词本平台为「本地生词表 / Zotero 笔记」时可用。
 *
 * ---
 * @license MIT
 * MIT License
 *
 * Copyright (c) 2026 chen7447
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * 参考实现：https://github.com/chen7447/word-translator-zotero（MIT）
 *  - ItemPaneManager.registerSection 面板机制、卡片渲染、字体缩放思路移植自该仓库
 */

import { config } from "../../package.json";
import { getPref, setPref, registerPrefObserver } from "../utils/prefs";
import { getString, getLocaleID } from "../utils/locale";
import {
  getWords as getLocalWords,
  deleteWordByIndex as deleteLocalWordByIndex,
  updateWordByIndex as updateLocalWordByIndex,
} from "./localWordbook";
import {
  getWordsFromNote,
  deleteWordFromNote,
  updateWordInNote,
  getNoteTitle,
  openSourceLink,
  parseSourceLink,
  updateAnnotationsForWord,
  deleteAnnotationsForWord,
} from "./zoteroNote";

const ref = config.addonRef;
const PLUGIN_ID = config.addonID;
const PANE_ID = "hover-translate-wordbook";
// 参考 llm-for-zotero：sidenav 使用 20px 专用图标（chrome://.../icon-20.png）
const ICON_URI = `chrome://${ref}/content/icons/icon-20.png`;

/* ------------------------------------------------------------------ */
/*  Pronunciation (TTS)                                                */
/* ------------------------------------------------------------------ */

/**
 * 生成发音播放 URL（参考 zotero-pdf-translate 的 `new Audio(url).play()` 方式；
 * 词典 mp3 需服务端解析，这里使用 Google TTS 直接生成，语言取 eudicLanguage pref）。
 */
function buildTTSUrl(word: string): string {
  const lang = (getPref("eudicLanguage") as string) || "en";
  return (
    "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=" +
    encodeURIComponent(lang) +
    "&q=" +
    encodeURIComponent(word || "")
  );
}

/** 播放单词发音（播放失败静默，不影响界面）。 */
function playPronunciation(word: string): void {
  try {
    const AudioCtor = (ztoolkit.getGlobal("Audio") ||
      (globalThis as any).Audio) as any;
    if (!AudioCtor) return;
    const audio = new AudioCtor(buildTTSUrl(word));
    audio.play().catch?.((e: any) => {
      Zotero.debug(`[hover-translate-eudic/panel] play error: ${e?.message || e}`);
    });
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/panel] play error: ${e?.message || e}`);
  }
}

/** 字号范围（与参考项目一致）。 */
const FONT_MIN = 9;
const FONT_MAX = 24;

/** 面板排序模式（与 wordtranslator 一致）：reverse=倒序(最新在前) | forward=顺序 | alpha=字母序 */
type PanelSortMode = "reverse" | "forward" | "alpha";
const SORT_MODES: PanelSortMode[] = ["reverse", "forward", "alpha"];
const SORT_LABELS: Record<PanelSortMode, string> = {
  reverse: "倒序",
  forward: "顺序",
  alpha: "字母",
};

/** 读取当前排序模式（pref 持久化，全局生效）。 */
function getPanelSortMode(): PanelSortMode {
  const m = getPref("panelSortMode") as string;
  return SORT_MODES.includes(m as PanelSortMode) ? (m as PanelSortMode) : "reverse";
}

/**
 * 返回排序后的索引数组（词条原列表的索引），参考 wordtranslator：
 * - reverse（默认）：最新添加的单词排在最前面（列表按时间追加，倒序即可）
 * - forward：按收录先后排列（原序）
 * - alpha：按单词 A-Z 字母序（localeCompare）
 * 删除/编辑仍基于原始索引（origIdx），不受排序影响。
 */
function getSortedIndices(words: { word: string }[], mode: PanelSortMode): number[] {
  if (!words || words.length === 0) return [];
  const indices = words.map((_, i) => i);
  switch (mode) {
    case "forward":
      return indices;
    case "reverse":
      return indices.slice().reverse();
    case "alpha":
      return indices.slice().sort((a, b) => {
        const wa = (words[a].word || "").toLowerCase();
        const wb = (words[b].word || "").toLowerCase();
        return wa.localeCompare(wb);
      });
    default:
      return indices.slice().reverse();
  }
}

/** 面板条目映射：paneUID（每窗口 section 实例唯一）-> { refresh, setEnabled }。
 *  用于加词/编辑/删除后强制刷新面板，以及平台/开关变化时更新启用状态。
 *  **key 必须用 paneUID 而非 itemID**：主窗口显示父条目、PDF 附件场景下
 *  itemID 不同甚至可能相同，用 itemID 做 key 会导致两个窗口的面板互相覆盖
 *  （后注册的覆盖先注册的）→ 一侧刷新回调丢失 → "面板无反应"。
 *  refresh 回调 = Zotero 的 _handleRefresh → _forceRenderAll（绕过
 *  _isAlreadyRendered 缓存强制重渲染）——这是加词后刷新面板的正确机制；
 *  Notifier.trigger("refresh","itempane") 只触发 box.render()，会被
 *  _isAlreadyRendered 拦截（item 未变时不触发 onRender），不能用于数据刷新。 */
/** 面板注册表条目。 */
interface PanelEntry {
  refresh: () => void;
  setEnabled: (v: boolean) => void;
  /** 直接重渲染面板内容（绕过 Zotero 的 hidden/pending/_isAlreadyRendered 拦截）。 */
  rerender: () => void;
}

/**
 * 跨窗口共享的面板注册表。
 *
 * Zotero 7 插件 bundle 在每个窗口（主窗口 / PDF reader）的 JS 上下文独立执行，
 * 模块级变量各窗口互不可见——用模块级 Map 存 refresh 回调会导致：PDF 侧加词后
 * 只能刷新 PDF 侧自己注册的面板，主窗口面板刷不到（表现为"PDF 面板更新了、
 * 条目面板没更新"）。因此注册表挂载到 Zotero 全局命名空间（跨窗口共享），
 * 所有窗口的 section 实例注册到同一份 Map；任一窗口数据变更后遍历刷新即可
 * 覆盖所有窗口的所有面板。
 */
function getPanelEntries(): Map<string, PanelEntry> {
  const Z = Zotero as any;
  if (!Z.__htePanelEntries || !(Z.__htePanelEntries instanceof Map)) {
    Z.__htePanelEntries = new Map<string, PanelEntry>();
  }
  return Z.__htePanelEntries as Map<string, PanelEntry>;
}

let _paneKey: string | null = null;
/** 主题监听器：主窗口 theme 属性变化时刷新面板（跟随 zotero-style 亮暗切换）。 */
let _themeObserver: MutationObserver | null = null;
/** 平台 pref 观察器：wordbookPlatform 变化 → 重新评估 setEnabled（信息栏面板与开启按钮）。 */
let _platformObserver: symbol | null = null;
/** 同步至本地 pref 观察器：syncToLocal 变化 → 重新评估。 */
let _syncObserver: symbol | null = null;
/** 术语库 pref 观察器：enableTerminology 变化 → 重新评估。 */
let _termObserver: symbol | null = null;
/** 渲染代次（按面板 body 隔离）：每次 renderPanel 自增该面板自身的代次，
 *  过期 await 完成时检测不匹配则丢弃填充。注意：必须是**每面板独立**——
 *  主窗口与 PDF reader 两个窗口会同时渲染各自的面板，若用全局单例代次，
 *  一侧的渲染会被另一侧的 `++` 顶掉（await 完成后发现代次不匹配 → 丢弃），
 *  表现为"一侧卡住、点击无反应"。用 WeakMap 按 body 隔离后互不干扰。 */
const _panelRenderGen = new WeakMap<HTMLElement, number>();

/** 侧边栏面板启用条件（三处统一：onInit / onItemChange / reevaluatePanelEnabled）：
 *  勾选 enableWordbookPanel 且满足任一：
 *    - 生词本平台 ∈ {本地生词表, Zotero 笔记}
 *    - 同步至本地 ∈ {本地生词表, Zotero 笔记}
 *    - 开启术语库 */
function computePanelEnabled(): boolean {
  const platformOk = supportedPlatform() !== null;
  const syncMode = getPref("syncToLocal") as string;
  const syncOk = syncMode === "local" || syncMode === "zotero";
  const termOk = !!getPref("enableTerminology");
  return !!getPref("enableWordbookPanel") && (platformOk || syncOk || termOk);
}

/** 重新评估所有已注册面板的启用状态（v0.3.2：平台 ∈ {local,zotero} ∨ 同步至本地 ∈ {local,zotero} ∨ 开启术语库，且勾选开关）。 */
function reevaluatePanelEnabled(): void {
  const enabled = computePanelEnabled();
  for (const [, entry] of getPanelEntries()) {
    try {
      entry.setEnabled(enabled);
    } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/*  Dark-mode detection (JS 检测，避免依赖 CSS window[theme] 选择器)    */
/* ------------------------------------------------------------------ */

/**
 * 检测当前是否为暗色模式（多策略兜底，覆盖 Zotero 原生 + zotero-style + OS 主题）。
 */
function detectDark(): boolean {
  // Strategy 1: Zotero 原生 — 主窗口 <window> theme 属性
  try {
    const docEl = Zotero.getMainWindow().document.documentElement;
    const theme = docEl?.getAttribute("theme");
    if (theme === "dark") return true;
    if (theme === "light") return false;
  } catch { /* ignore */ }
  // Strategy 2: Zotero 7 主题 pref browser.theme.toolbar-theme（0=dark, 1=light, 2=auto）。
  // 注意数值方向与 ui.theme 相反！部分版本仍用 ui.theme（1=light, 2=dark），两者都兼容。
  try {
    const tbTheme = Zotero.Prefs.get("browser.theme.toolbar-theme", true);
    if (tbTheme === 0 || tbTheme === "0" || tbTheme === "dark") return true;
    if (tbTheme === 1 || tbTheme === "1" || tbTheme === "light") return false;
  } catch { /* ignore */ }
  try {
    const uiTheme = Zotero.Prefs.get("ui.theme", true);
    if (uiTheme === "dark" || uiTheme === 2 || uiTheme === "2") return true;
    if (uiTheme === "light" || uiTheme === 1 || uiTheme === "1") return false;
  } catch { /* ignore */ }
  // Strategy 3: zotero-style 兼容 — data-theme 属性 / classList
  try {
    const docEl = Zotero.getMainWindow().document.documentElement;
    if (docEl) {
      const dataTheme = docEl.getAttribute("data-theme");
      if (dataTheme === "dark") return true;
      if (dataTheme === "light") return false;
      const cls = docEl.classList;
      if (cls?.contains("theme-dark")) return true;
      if (cls?.contains("dark")) return true;
    }
  } catch { /* ignore */ }
  // Strategy 4: matchMedia 系统主题（OS 级）
  try {
    const mql = Zotero.getMainWindow().matchMedia("(prefers-color-scheme: dark)");
    if (mql?.matches) return true;
  } catch { /* ignore */ }
  // Strategy 5: 计算主窗口背景色亮度（最稳定的兜底——任何主题切换方式都会改变背景色）
  try {
    const mainWin = Zotero.getMainWindow();
    const docEl = mainWin.document.documentElement;
    const body: any = mainWin.document.body || docEl;
    const parseRGB = (bg: string): number[] | null => {
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      const h = bg.match(/#([0-9a-fA-F]{6})/);
      if (h) {
        const n = parseInt(h[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      return null;
    };
    const brightnessOf = (rgb: number[] | null): number | null => {
      if (!rgb) return null;
      return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
    };
    // 依次取 body / documentElement 背景；transparent 时继续下一层
    for (const node of [body, docEl]) {
      if (!node) continue;
      const bg = (mainWin.getComputedStyle(node) as CSSStyleDeclaration).backgroundColor || "";
      if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;
      const brightness = brightnessOf(parseRGB(bg));
      if (brightness !== null) {
        if (brightness < 128) return true;
        return false;
      }
    }
    // Strategy 5b: 读 Zotero 7 主题变量 --color-sidepane / --fill-primary（暗色自动变深）
    if (docEl) {
      const style = mainWin.getComputedStyle(docEl) as CSSStyleDeclaration & Record<string, string>;
      for (const prop of ["--color-sidepane", "--color-window", "--fill-primary"]) {
        const v = style.getPropertyValue?.(prop) || "";
        const rgb = parseRGB(v.trim());
        const brightness = brightnessOf(rgb);
        if (brightness !== null) {
          if (brightness < 128) return true;
          return false;
        }
      }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 刷新所有窗口（主窗口 + PDF reader）的所有面板——三层保障：
 *
 * 1. Zotero 原生 Notifier（wordtranslator 同款）：
 *    Notifier.trigger("refresh","itempane") → 所有窗口 ItemDetails.notify
 *    → renderCustomSections() + render()。面板处于 hidden 状态时，
 *    refresh 回调只设 pending，Notifier 让 ItemDetails.render() 检查
 *    pending 并在面板恢复可见时渲染。
 * 2. refresh 回调（entry.refresh()）：Zotero _handleRefresh → _forceRenderAll，
 *    _resetRenderedFlags 绕过 _isAlreadyRendered 缓存强制重渲染（面板可见时
 *    立即生效）。
 * 3. 直接重渲染（entry.rerender()）：绕过 Zotero 的 hidden/pending/缓存
 *    拦截，直接调 renderPanel 重绘面板 DOM——任何状态下都能刷新。
 *
 * 单靠 refresh 回调在"面板 hidden"或"跨窗口"场景可能失效（模块级 Map 隔离
 * 或 _forceRenderAll 跳过渲染），三层组合覆盖所有场景。
 */
function refreshAllPanels(): void {
  // ① Zotero 原生 Notifier：刷新所有窗口的 ItemPane（触发 ItemDetails.render）
  try {
    const Z = (globalThis as any).Zotero;
    if (Z?.Notifier && typeof Z.Notifier.trigger === "function") {
      Z.Notifier.trigger("refresh", "itempane", []).catch?.(() => {});
    }
  } catch { /* ignore */ }

  // ② + ③ 遍历共享注册表：refresh 回调（强制重渲染）+ 直接重渲染（绕过隐藏状态）
  for (const [, entry] of getPanelEntries()) {
    try {
      entry.refresh();
    } catch (e: any) {
      try {
        Zotero.debug(`[hover-translate-eudic/panel] refresh error: ${e?.message || e}`);
      } catch { /* ignore */ }
    }
    try {
      entry.rerender();
    } catch { /* ignore */ }
  }
}

/** 导出：加词 / 编辑 / 删除等数据变更后，刷新所有窗口（主窗口 + PDF reader）的面板。 */
export { refreshAllPanels };

/** 启动主题监听：
 *  1. MutationObserver 监听主窗口 theme/data-theme/class/style 属性变化
 *  2. matchMedia change 事件（Zotero 7 内部用 prefers-color-scheme 检测主题）
 *  3. 定时轮询兜底（zotero-style 等纯 CSS 主题插件不产生 DOM 属性变化，必须轮询检测） */
let _themeTimer: ReturnType<typeof setInterval> | null = null;
let _lastDark: boolean | null = null;
function startThemeWatcher(): void {
  try {
    if (_themeObserver) return;
    const mainWin = Zotero.getMainWindow();
    const root = mainWin.document.documentElement;
    // 1) 属性变化监听
    if (root && typeof MutationObserver !== "undefined") {
      _themeObserver = new MutationObserver(() => {
        _lastDark = null;
        refreshAllPanels();
      });
      _themeObserver.observe(root, {
        attributes: true,
        attributeFilter: ["theme", "data-theme", "class", "style"],
      });
    }
    // 2) matchMedia change（Zotero 7 官方检测方式）
    try {
      const mql = mainWin.matchMedia("(prefers-color-scheme: dark)");
      if (mql && typeof mql.addEventListener === "function") {
        mql.addEventListener("change", () => {
          _lastDark = null;
          refreshAllPanels();
        });
      }
    } catch { /* ignore */ }
    // 3) 定时轮询兜底：纯 CSS 主题切换（无属性变化）也能感知
    if (!_themeTimer) {
      _themeTimer = setInterval(() => {
        try {
          const dark = detectDark();
          if (_lastDark === null) {
            _lastDark = dark;
            return;
          }
          if (dark !== _lastDark) {
            _lastDark = dark;
            refreshAllPanels();
          }
        } catch { /* ignore */ }
      }, 1500);
    }
  } catch { /* ignore */ }
}

function stopThemeWatcher(): void {
  try {
    _themeObserver?.disconnect();
  } catch { /* ignore */ }
  _themeObserver = null;
  try {
    if (_themeTimer !== null) {
      clearInterval(_themeTimer);
      _themeTimer = null;
    }
  } catch { /* ignore */ }
  _lastDark = null;
}

/* ------------------------------------------------------------------ */
/*  DOM helpers (XUL doc → XHTML namespace)                            */
/* ------------------------------------------------------------------ */

function el(doc: Document, tag: string, attrs?: Record<string, string>, children?: (Node | string)[]): HTMLElement {
  const e = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else e.setAttribute(k, v);
    }
  }
  (children || []).forEach((c) =>
    e.append(typeof c === "string" ? doc.createTextNode(c) : c),
  );
  return e;
}

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ */
/*  Data access                                                        */
/* ------------------------------------------------------------------ */

interface PanelWord {
  word: string;
  phon: string;
  exp: string;
  src: string;
  /** 术语库缩写（仅术语模式；生词本为空）。 */
  abbr?: string;
  /** 词条来源附件 itemID（由 src 解析，用于「当前条目」视图过滤；无 src 时为 0）。 */
  srcItemID: number;
}

/** 面板支持的数据源平台。 */
function supportedPlatform(): "local" | "zotero" | null {
  const platform = getPref("wordbookPlatform") as string;
  if (platform === "local") return "local";
  if (platform === "zotero") return "zotero";
  return null;
}

/** 解析词条 src 链接 → 来源附件 itemID（失败返回 0）。 */
function resolveSrcItemID(src: string): number {
  try {
    const parsed = parseSourceLink(src);
    return parsed?.itemID || 0;
  } catch {
    return 0;
  }
}

/** 判断词条来源附件是否属于当前条目（附件自身或其父条目匹配）。 */
function srcBelongsToItem(srcItemID: number, currentItemID: number): boolean {
  if (!srcItemID || !currentItemID) return false;
  if (srcItemID === currentItemID) return true;
  try {
    const item = Zotero.Items.get(srcItemID) as any;
    const parentID = Number(item?.parentID || 0);
    if (parentID && parentID === currentItemID) return true;
  } catch { /* ignore */ }
  return false;
}

/** 面板生词数据源：生词本平台（local/zotero）优先，否则回退「同步至本地」（local/zotero）。 */
function wordSource(): "local" | "zotero" | null {
  const platform = supportedPlatform();
  if (platform) return platform;
  const syncMode = getPref("syncToLocal") as string;
  if (syncMode === "local" || syncMode === "zotero") return syncMode;
  return null;
}

async function loadWords(): Promise<{ platform: "local" | "zotero" | null; words: PanelWord[] }> {
  const platform = wordSource();
  if (platform === "local") {
    const rows = await getLocalWords();
    return {
      platform,
      words: rows.map((r) => ({
        word: r.word, phon: r.phon, exp: r.exp, src: r.src,
        srcItemID: resolveSrcItemID(r.src),
      })),
    };
  }
  if (platform === "zotero") {
    const rows = await getWordsFromNote(getNoteTitle());
    return {
      platform,
      words: rows.map((r) => ({
        word: r.word, phon: r.phon, exp: r.exp, src: r.src,
        srcItemID: resolveSrcItemID(r.src),
      })),
    };
  }
  return { platform: null, words: [] };
}

/** 加载术语库数据（按术语库平台 local/zotero 分发）。 */
async function loadTerms(): Promise<{ platform: "local" | "zotero" | null; words: PanelWord[] }> {
  try {
    const { getTerminologyTerms } = await import("./terminology");
    const { platform, terms } = await getTerminologyTerms();
    return {
      platform,
      words: terms.map((t) => ({
        word: t.term,
        phon: "",
        exp: t.exp,
        src: t.src,
        abbr: t.abbr,
        srcItemID: resolveSrcItemID(t.src),
      })),
    };
  } catch (e: any) {
    try {
      Zotero.debug(`[hover-translate-eudic/panel] loadTerms error: ${e?.message || e}`);
    } catch { /* ignore */ }
    return { platform: null, words: [] };
  }
}

/** 面板内容模式：wordbook=生词本 | terminology=术语库。 */
function panelContentMode(): "wordbook" | "terminology" {
  return getPref("panelContentMode") === "terminology" ? "terminology" : "wordbook";
}

/* ------------------------------------------------------------------ */
/*  Panel render                                                       */
/* ------------------------------------------------------------------ */

async function renderPanel(doc: Document, body: HTMLElement, itemID: number): Promise<void> {
  // 渲染代次（按面板隔离）：onRender 与 onItemChange 触发的 refresh 都会调用
  // 本函数，同面板并发时各自 await 让出线程，导致内容叠加。代次让过期的不再填充。
  // 注意：代次必须挂在当前 body 上，不能用全局计数——主窗口与 PDF reader
  // 双窗口并发渲染各自面板时，全局计数会互相顶掉（详见 _panelRenderGen 注释）。
  const myGen = (_panelRenderGen.get(body) || 0) + 1;
  _panelRenderGen.set(body, myGen);

  // 同步设置主题属性，CSS 据此渲染，避免闪烁
  body.dataset.hteTheme = detectDark() ? "dark" : "light";

  // 注意：不要在 await 之前 replaceChildren 清空 body——若 loadWords 抛异常
  // 或并发渲染导致本轮回被判定过期 return，body 已空且无人填充 → 面板空白、
  // 按钮消失（"点击无反应"）。改为所有内容构建完成后一次性清空并填充，
  // 任何异常都在 catch 中兜底显示占位，保证面板始终有内容。
  const mode = panelContentMode();
  let platform: "local" | "zotero" | null = null;
  let words: PanelWord[] = [];
  try {
    const loaded = mode === "terminology" ? await loadTerms() : await loadWords();
    if (myGen !== _panelRenderGen.get(body)) return; // 已被更新的渲染取代
    platform = loaded.platform;
    words = loaded.words;
  } catch (e: any) {
    try {
      Zotero.debug(`[hover-translate-eudic/panel] loadWords error: ${e?.message || e}`);
    } catch { /* ignore */ }
    if (myGen !== _panelRenderGen.get(body)) return;
    // 数据加载失败：显示占位，避免空白面板
    body.replaceChildren();
    const hint = el(doc, "div", {
      class: `${ref}-panel-hint`,
      style: "font-size:12px;padding:6px 4px;",
    }, [getString("hte-panel-load-failed")]);
    body.append(hint);
    injectStyle(body);
    return;
  }

  const fontSize = Number(getPref("panelFontSize")) || 15;
  const hidePhon = !!getPref("panelHidePhon");
  const hideExp = !!getPref("panelHideExp");
  const hidePlay = !!getPref("panelHidePlay");
  const hideAbbr = !!getPref("panelHideAbbr");
  const scope = getPref("panelWordScope") === "current" ? "current" : "all";

  // 数据已就绪：此时一次性清空旧内容，然后 header + list 依次 append。
  // 注意：replaceChildren 必须放在这里（构建 UI 之前），不能放在函数尾部——
  // 否则会清掉已经 append 的 header（工具栏按钮消失）。且必须在 await 之后，
  // 避免"清空后无人填充"的空白期（异常已在上面 catch 兜底）。
  body.replaceChildren();

  // 视图过滤：当前条目 → 仅保留 src 归属当前条目的词条。
  // 记录每个词条在全量列表中的原始索引（local 平台的增删改按全量索引操作，
  // 过滤视图下不能使用可见索引，否则会删错词条）。
  const visibleWords =
    scope === "current"
      ? words
          .map((w, origIdx) => ({ w, origIdx }))
          .filter(({ w }) => srcBelongsToItem(w.srcItemID, itemID))
      : words.map((w, origIdx) => ({ w, origIdx }));
  // 排序：按当前模式对可见词条排序（origIdx 保持全量索引，删除/编辑不受影响）
  const sortMode = getPanelSortMode();
  const sortedIndices = getSortedIndices(visibleWords.map((v) => v.w), sortMode);
  const sortedVisible = sortedIndices.map((i) => visibleWords[i]);

  // ---------- 头部工具栏 ----------
  const header = el(doc, "div", {
    class: `${ref}-panel-toolbar`,
    style: "display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;",
  });

  const right = el(doc, "div", { style: "display:flex;align-items:center;gap:4px;flex-wrap:wrap;" });
  const mkBtn = (title: string, text: string, onClick: () => void, active = false): HTMLElement => {
    const b = el(doc, "button", {
      type: "button",
      title,
      class: active ? `${ref}-panel-toolbar-btn ${ref}-panel-toolbar-btn-active` : `${ref}-panel-toolbar-btn`,
      style: "border-radius:6px;cursor:pointer;padding:2px 8px;font-size:12px;",
    }, [text]);
    b.addEventListener("click", onClick);
    return b;
  };

  // 视图切换：单个 toggle 按钮，点击切换「当前条目 ↔ 所有条目」。
  // 默认「当前条目」；「所有条目」模式下按钮 active 高亮。
  const scopeToggleBtn = mkBtn(
    scope === "current"
      ? "点击切换到所有条目"
      : "点击切换到当前条目",
    scope === "current" ? "当前条目" : "所有条目",
    () => {
      setPref("panelWordScope", scope === "current" ? "all" : "current");
      refreshPanel(itemID);
    },
    scope === "all",
  );

  // 内容切换：词（生词本）↔ 语（术语库）。位于「当前条目」后、「隐藏译文」前。
  // 按钮显示「词」= 生词本卡片，「语」= 术语库卡片（术语库不显示音标，音标位置显示缩写）。
  const contentToggleBtn = mkBtn(
    mode === "wordbook"
      ? "切换到术语库"
      : "切换到生词本",
    mode === "wordbook" ? "词" : "语",
    () => {
      setPref("panelContentMode", mode === "wordbook" ? "terminology" : "wordbook");
      refreshPanel(itemID);
    },
    mode === "terminology",
  );

  const hideExpBtn = mkBtn("隐藏释义", "译", () => {
    setPref("panelHideExp", !getPref("panelHideExp"));
    refreshPanel(itemID);
  }, hideExp);
  // 「音标/缩写」按钮：生词本模式为「隐藏音标」（字母 A + 音符 SVG）；
  // 术语库模式为「隐藏缩写」（三条横线 + 三角 SVG，用户指定图标）。
  // 图标大小(width/height=15)与颜色(fill=currentColor)两种模式保持一致。
  const isTermMode = mode === "terminology";
  const hideTarget = isTermMode ? hideAbbr : hidePhon;
  const hidePhonBtn = el(doc, "button", {
    type: "button",
    title: hideTarget
      ? isTermMode ? "显示缩写" : "显示音标"
      : isTermMode ? "隐藏缩写" : "隐藏音标",
    class: hideTarget ? `${ref}-panel-toolbar-btn ${ref}-panel-toolbar-btn-active` : `${ref}-panel-toolbar-btn`,
    style: "border-radius:6px;cursor:pointer;padding:2px 8px;font-size:12px;display:inline-flex;align-items:center;",
  });
  hidePhonBtn.innerHTML = isTermMode
    // 隐藏缩写图标（用户提供：三条横线 + 右三角，尺寸/颜色与隐藏音标一致）
    ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="15" height="15" fill="currentColor" aria-hidden="true">' +
      '<path d="M153.6 153.6h716.8a51.2 51.2 0 0 1 0 102.4H153.6a51.2 51.2 0 1 1 0-102.4z m0 614.4h716.8a51.2 51.2 0 0 1 0 102.4H153.6a51.2 51.2 0 0 1 0-102.4z m0-307.2h358.4a51.2 51.2 0 0 1 0 102.4H153.6a51.2 51.2 0 0 1 0-102.4z m520.5504 67.9936l213.1456 135.2704c11.8272 7.8848 34.304 3.4304 34.304-19.968V385.28c0-26.4704-19.5584-28.2112-31.7952-21.504l-215.6544 136.8064c-11.776 7.3216-11.008 20.3776 0 28.2112z"/>' +
      "</svg>"
    // 隐藏音标图标（原有：字母 A + 音符）
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="15" height="15" fill="currentColor" aria-hidden="true">' +
      '<path d="M609.5 627.6c-10.3-20.6-20.5-60.2-30.7-118.9l80.8-207.3h-77.3l-33.9 104.4h-1.9c-13.2-35.8-33.1-63.8-59.8-84-26.7-20.2-57.5-30.3-92.6-30.3-60.2 0-108 21.7-143.4 65.1-35.4 43.5-53.1 99.3-53.1 167.7 0 60.5 15.4 110.3 46.1 149.6 30.7 39.2 71.8 58.8 123.1 58.8 72.4 0 128.5-41.3 168.4-123.8h1.5c15.5 78.5 45.1 117.7 88.8 117.7 11.4 0 25.4-2 41.9-6.1v-64.8c-4.6 1.8-10.7 2.7-18.3 2.7-16.2 0-29.3-10.3-39.6-30.8z m-98.5-101c-30.7 94.8-75 142.1-133 142.1-32.3 0-57.7-14.3-76.4-43.1-18.7-28.7-28-63.9-28-105.5 0-46.7 11-86.4 33.1-118.9s52.1-48.8 89.9-48.8c58.2 0 98.3 52 120.4 155.9l-6 18.3zM775.4 634.8c-14 0-25.7 4.7-35.1 14.1-9.4 9.4-14.1 21-14.1 34.7 0 13.2 4.6 24.6 13.9 34.1S761 732 775 732c14.5 0 26.4-4.8 35.8-14.3 9.4-9.5 14.1-20.9 14.1-34.1 0-13.5-4.7-25-14.1-34.5-9.4-9.5-21.2-14.3-35.4-14.3zM775.4 292.6c-13.5 0-25 4.6-34.7 13.7-9.7 9.1-14.5 20.6-14.5 34.3 0 13.5 4.7 24.9 14.1 34.3 9.4 9.4 21 14.1 34.7 14.1 14.5 0 26.4-4.7 35.8-14.1 9.4-9.4 14.1-20.8 14.1-34.3s-4.8-24.8-14.5-34.1c-9.6-9.2-21.3-13.9-35-13.9z"/>' +
      '<path d="M926.2 270.6c-19.9 0-36.1-16.2-36.1-36.1V83.7c0-6.2-5.2-11.5-11.5-11.5H143.7c-6.2 0-11.5 5.2-11.5 11.5v150.8c0 20-16.2 36.1-36.1 36.1S60 254.5 60 234.5V83.7C60 37.5 97.6 0 143.7 0h734.9c46.1 0 83.7 37.5 83.7 83.7v150.8c0 20-16.2 36.1-36.1 36.1z"/>' +
      '<path d="M878.6 1024H143.7c-46.1 0-83.7-37.5-83.7-83.7V732.7c0-20 16.2-36.1 36.1-36.1s36.1 16.2 36.1 36.1v207.6c0 6.2 5.2 11.5 11.5 11.5h734.9c6.2 0 11.5-5.2 11.5-11.5V732.7c0-20 16.2-36.1 36.1-36.1s36.1 16.2 36.1 36.1v207.6c0 46.2-37.5 83.7-83.7 83.7z"/>' +
      "</svg>";
  hidePhonBtn.addEventListener("click", () => {
    if (isTermMode) {
      setPref("panelHideAbbr", !getPref("panelHideAbbr"));
    } else {
      setPref("panelHidePhon", !getPref("panelHidePhon"));
    }
    refreshPanel(itemID);
  });
  // 隐藏播放图标：使用喇叭 SVG 图标（无文字），位于「隐藏音标」之后
  const hidePlayBtn = el(doc, "button", {
    type: "button",
    title: hidePlay ? "显示播放图标" : "隐藏播放图标",
    class: hidePlay ? `${ref}-panel-toolbar-btn ${ref}-panel-toolbar-btn-active` : `${ref}-panel-toolbar-btn`,
    style: "border-radius:6px;cursor:pointer;padding:2px 8px;font-size:12px;display:inline-flex;align-items:center;",
  });
  hidePlayBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<path d="M3 9v6h4l5 5V4L7 9H3z"/>' +
    '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>' +
    "</svg>";
  hidePlayBtn.addEventListener("click", () => {
    setPref("panelHidePlay", !getPref("panelHidePlay"));
    refreshPanel(itemID);
  });
  // 排序按钮：随模式变化（与 wordtranslator 一致）——倒序→「倒」、顺序→「正」、
  // 字母→A-Z 图标；点击循环切换；hover 显示当前模式名。排序模式全局生效且
  // pref 持久化（关闭 Zotero 后自动保存）。位于隐藏播放图标之后、放大字体之前。
  const sortBtn = el(doc, "button", {
    type: "button",
    title: `当前排序：${SORT_LABELS[sortMode]}（点击切换）`,
    class: `${ref}-panel-toolbar-btn`,
    style: "border-radius:6px;cursor:pointer;padding:2px 8px;font-size:12px;display:inline-flex;align-items:center;justify-content:center;",
  });
  if (sortMode === "reverse") {
    sortBtn.textContent = "倒";
  } else if (sortMode === "forward") {
    sortBtn.textContent = "正";
  } else {
    // alpha：字母序图标（用户提供的 上下箭头+字母A 样式，currentColor 跟随主题色）
    sortBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="15" height="15" fill="currentColor" aria-hidden="true">' +
      '<path d="M686.471529 120.470588c13.432471 0 24.545882 10.059294 26.172236 23.04l0.180706 3.312941v693.970824a26.352941 26.352941 0 0 1-52.495059 3.312941l-0.210824-3.312941V146.823529c0-14.546824 11.806118-26.352941 26.352941-26.352941zM458.089412 542.117647c22.377412 0 34.093176 25.750588 20.811294 42.526118l-2.168471 2.469647-236.122353 236.092235h217.47953c13.432471 0 24.515765 10.059294 26.142117 23.070118l0.210824 3.312941a26.352941 26.352941 0 0 1-23.04 26.142118l-3.312941 0.180705H177.001412c-22.377412 0-34.093176-25.750588-20.811294-42.526117l2.16847-2.43953 236.092236-236.122353h-217.449412a26.352941 26.352941 0 0 1-26.142118-23.04l-0.210823-3.312941c0-13.432471 10.059294-24.515765 23.04-26.142117l3.312941-0.210824h281.088zM298.977882 134.716235a26.352941 26.352941 0 0 1 45.296942-2.590117l1.837176 3.252706 135.710118 281.088a26.352941 26.352941 0 0 1-45.839059 25.810823l-1.626353-2.891294-112.790588-233.652706-121.163294 234.315294a26.352941 26.352941 0 0 1-32.496942 12.619294l-3.011764-1.325176a26.352941 26.352941 0 0 1-12.649412-32.496941l1.355294-3.011765 145.377882-281.118118z"/>' +
      '<path d="M808.387765 690.386824a26.352941 26.352941 0 0 1 39.634823 34.575058l-2.349176 2.710589-140.559059 140.528941a26.352941 26.352941 0 0 1-34.575059 2.349176l-2.710588-2.349176-140.528941-140.559059a26.352941 26.352941 0 0 1 34.575059-39.604706l2.710588 2.349177 121.886117 121.886117 121.916236-121.886117z"/>' +
      "</svg>";
  }
  sortBtn.addEventListener("click", () => {
    const idx = SORT_MODES.indexOf(sortMode);
    const next = SORT_MODES[(idx + 1) % SORT_MODES.length];
    setPref("panelSortMode", next);
    refreshPanel(itemID);
  });
  const zoomInBtn = mkBtn("放大字体", "A+", () => {
    setPref("panelFontSize", Math.min(FONT_MAX, (Number(getPref("panelFontSize")) || 15) + 1));
    refreshPanel(itemID);
  });
  const zoomOutBtn = mkBtn("缩小字体", "A-", () => {
    setPref("panelFontSize", Math.max(FONT_MIN, (Number(getPref("panelFontSize")) || 15) - 1));
    refreshPanel(itemID);
  });
  const clearBtn = mkBtn("清空", "清空", () => void confirmClear(doc, body, itemID, platform, mode));
  right.append(contentToggleBtn, scopeToggleBtn, hideExpBtn, hidePhonBtn, hidePlayBtn, sortBtn, zoomInBtn, zoomOutBtn, clearBtn);
  header.append(right);
  body.append(header);

  // ---------- 平台不支持提示（保留工具栏——用户可切换到「语」术语库等可用模式；
  // 不清空 header，否则顶部按钮消失） ----------
  if (!platform) {
    const hint = el(doc, "div", {
      class: `${ref}-panel-hint`,
      style: "font-size:12px;padding:6px 4px;",
    }, [getString("hte-panel-platform-hint")]);
    body.append(hint);
    injectStyle(body);
    return;
  }

  // ---------- 卡片列表（高度限制 + 滚动） ----------
  const list = el(doc, "div", {
    class: `${ref}-panel-list`,
    style: "display:flex;flex-direction:column;gap:6px;max-height:70vh;overflow-y:auto;padding-right:4px;width:100%;box-sizing:border-box;",
  });
  if (visibleWords.length === 0) {
    const emptyMsg = mode === "terminology"
      ? (scope === "current" ? "当前条目暂无术语。划词后点击「+术语库」即可加入。" : "暂无术语。划词后点击「+术语库」即可加入。")
      : (scope === "current" ? getString("hte-panel-empty-current") : getString("hte-panel-empty"));
    list.append(el(doc, "div", {
      class: `${ref}-panel-hint`,
      style: "font-size:12px;padding:6px 4px;",
    }, [emptyMsg]));
  } else {
    sortedVisible.forEach(({ w, origIdx }) => {
      if (mode === "terminology") {
        list.append(renderTermCard(doc, body, itemID, platform!, w, origIdx, fontSize, hideExp, hideAbbr));
      } else {
        list.append(renderCard(doc, body, itemID, platform!, w, origIdx, fontSize, hidePhon, hideExp, hidePlay));
      }
    });
  }
  body.append(list);
  injectStyle(body);
}

/** 渲染单个单词卡片。 */
function renderCard(
  doc: Document,
  body: HTMLElement,
  itemID: number,
  platform: "local" | "zotero",
  w: PanelWord,
  idx: number,
  fontSize: number,
  hidePhon: boolean,
  hideExp: boolean,
  hidePlay: boolean,
): HTMLElement {
  const card = el(doc, "div", {
    class: `${ref}-panel-card`,
    style:
      "position:relative;padding:6px 8px;" +
      "border-radius:8px;width:100%;box-sizing:border-box;",
  });

  // 文本区：占满卡片整个宽度；不设 padding-right（否则译文行右侧也会留白）。
  // 按钮占位只在第一行（row1）单独处理。
  const textWrap = el(doc, "div", {
    style: `width:100%;box-sizing:border-box;font-size:${fontSize}px;line-height:1.5;user-select:text;overflow-wrap:anywhere;`,
  });

  // 第一行：单词（可点击跳转原文，字号放大）+ 音标
  // padding-right 仅作用于第一行，为右上角编辑/删除按钮留出空间，不影响译文行
  const row1 = el(doc, "div", {
    style: "display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;padding-right:44px;box-sizing:border-box;",
  });
  if (w.src) {
    const wordLink = el(doc, "a", {
      href: w.src,
      "data-hte-src": w.src,
      title: "跳转到原文",
      class: `${ref}-panel-card-word`,
      style: `font-weight:700;font-size:${fontSize + 2}px;cursor:pointer;text-decoration:none;overflow-wrap:anywhere;`,
    }, [w.word]);
    wordLink.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void openSourceLink(w.src, w.word);
    });
    row1.append(wordLink);
  } else {
    row1.append(el(doc, "span", {
      class: `${ref}-panel-card-word`,
      style: `font-weight:700;font-size:${fontSize + 2}px;overflow-wrap:anywhere;`,
    }, [w.word]));
  }
  if (w.phon && !hidePhon) {
    // 音标：去掉数据源可能已带的首尾斜杠，统一显示为 /xx/。
    // 两侧斜杠用正体（font-style:normal）包裹——斜体下的斜杠会特别倾斜；
    // 音标主体保持斜体（词典惯例，斜杠不倾斜、内容倾斜）。
    const phon = String(w.phon || "").replace(/^\/+|\/+$/g, "").trim();
    if (phon) {
      row1.append(el(doc, "span", {
        class: `${ref}-panel-card-phon`,
        style: "flex-shrink:0;",
      }, [
        el(doc, "span", { style: "font-style:normal;opacity:0.85;" }, ["/"]),
        el(doc, "span", { style: "font-style:italic;" }, [phon]),
        el(doc, "span", { style: "font-style:normal;opacity:0.85;" }, ["/"]),
      ]));
    }
  }

  // 发音播放按钮：位于音标之后；若音标隐藏则自动跟在单词后面（row1 末尾）。
  // hidePlay 时整组不渲染。
  if (!hidePlay) {
    const playBtn = el(doc, "button", {
      type: "button",
      title: "播放发音",
      class: `${ref}-panel-icon-btn ${ref}-panel-play-btn`,
      style:
        "border:none;background:transparent;cursor:pointer;padding:2px 4px;" +
        "border-radius:4px;line-height:1;display:inline-flex;align-items:center;flex-shrink:0;",
    });
    // 喇叭 SVG（fill=currentColor 跟随按钮颜色）
    playBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">' +
      '<path d="M3 9v6h4l5 5V4L7 9H3z"/>' +
      '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>' +
      '<path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>' +
      "</svg>";
    playBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      playPronunciation(w.word);
    });
    row1.append(playBtn);
  }
  textWrap.append(row1);

  // 第二行：字典释义（隐藏释义时整行不渲染，卡片高度自动缩小）
  if (w.exp && !hideExp) {
    textWrap.append(el(doc, "div", {
      class: `${ref}-panel-card-exp`,
      style: "margin-top:2px;overflow-wrap:anywhere;width:100%;",
    }, [w.exp]));
  }

  // 右侧：编辑 / 删除按钮——绝对定位浮在卡片右上角，与单词同行，
  // 不占文档流高度，译文可延伸至卡片右缘
  const btnGroup = el(doc, "div", {
    style:
      "position:absolute;top:6px;right:6px;display:flex;flex-direction:row;gap:0;",
  });
  const editBtn = el(doc, "button", {
    type: "button",
    title: "编辑",
    class: `${ref}-panel-icon-btn`,
    style: "border:none;background:transparent;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px;line-height:1;display:inline-flex;align-items:center;",
  });
  // 编辑铅笔图标（SVG 内联；fill=currentColor 跟随按钮颜色，亮暗模式自动适配）
  editBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor">' +
    '<path d="M474.58679343 587.16868738c-11.45302241 0-22.90604486-4.37057868-31.6472022-13.11173601-17.48231469-17.48231469-17.48231469-45.83841849 0-63.29440437l487.24053555-487.24053552c17.48231469-17.48231469 45.81208967-17.48231469 63.29440431 0 17.48231469 17.48231469 17.48231469 45.83841849 0 63.29440441L506.23399561 574.05695137a44.61676276 44.61676276 0 0 1-31.64720218 13.11173601z" fill="currentColor"></path>' +
    '<path d="M904.16728498 1017.19676833h-781.96497912c-62.68884228 0-113.68770304-50.99886074-113.68770305-113.71403181v-781.96497913c0-62.71517108 50.99886074-113.71403182 113.66137425-113.71403185l457.51533479 0.0263288c24.72273117 0 44.75893818 20.03620706 44.75893819 44.7589382s-20.03620706 44.75893818-44.75893819 44.7589382l-457.51533479-0.02632877c-13.2960375 0-24.14349786 10.84746035-24.14349785 24.16982661v781.96497915c0 13.32236631 10.84746035 24.1698266 24.16982665 24.16982664h781.96497912c13.32236631 0 24.1698266-10.84746035 24.16982668-24.16982664V403.42008173c0-24.72273117 20.06253583-44.75893818 44.75893815-44.75893828 24.72273117 0 44.75893818 20.03620706 44.7589382 44.75893828V903.50906532c0 62.68884228-50.99886074 113.68770304-113.68770303 113.68770301z" fill="currentColor"></path>' +
    "</svg>";
  editBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void openEditDialog(doc, body, itemID, platform, w, idx);
  });
  const delBtn = el(doc, "button", {
    type: "button",
    title: "删除",
    class: `${ref}-panel-icon-btn`,
    style: "border:none;background:transparent;cursor:pointer;font-size:15px;padding:2px 6px;border-radius:4px;line-height:1;",
  }, ["✕"]);
  delBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void confirmDelete(doc, body, itemID, platform, w, idx);
  });
  btnGroup.append(editBtn, delBtn);

  card.append(textWrap, btnGroup);
  return card;
}

/** 渲染单个术语卡片（术语库模式）：无音标/无发音按钮，音标位置显示缩写。 */
function renderTermCard(
  doc: Document,
  body: HTMLElement,
  itemID: number,
  platform: "local" | "zotero",
  w: PanelWord,
  idx: number,
  fontSize: number,
  hideExp: boolean,
  hideAbbr: boolean,
): HTMLElement {
  const card = el(doc, "div", {
    class: `${ref}-panel-card`,
    style:
      "position:relative;padding:6px 8px;" +
      "border-radius:8px;width:100%;box-sizing:border-box;",
  });

  const textWrap = el(doc, "div", {
    style: `width:100%;box-sizing:border-box;font-size:${fontSize}px;line-height:1.5;user-select:text;overflow-wrap:anywhere;`,
  });

  // 第一行：术语（可点击跳转原文）+ 缩写（音标位置）
  const row1 = el(doc, "div", {
    style: "display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;padding-right:44px;box-sizing:border-box;",
  });
  if (w.src) {
    const wordLink = el(doc, "a", {
      href: w.src,
      "data-hte-src": w.src,
      title: "跳转到原文",
      class: `${ref}-panel-card-word`,
      style: `font-weight:700;font-size:${fontSize + 2}px;cursor:pointer;text-decoration:none;overflow-wrap:anywhere;`,
    }, [w.word]);
    wordLink.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void openSourceLink(w.src, w.word);
    });
    row1.append(wordLink);
  } else {
    row1.append(el(doc, "span", {
      class: `${ref}-panel-card-word`,
      style: `font-weight:700;font-size:${fontSize + 2}px;overflow-wrap:anywhere;`,
    }, [w.word]));
  }
  // 缩写（选填）：显示在音标位置，正体灰色；无缩写则不显示；
  // 「隐藏缩写」按钮(术语库模式)可切换显示
  const abbr = (w.abbr || "").trim();
  if (abbr && !hideAbbr) {
    row1.append(el(doc, "span", {
      class: `${ref}-panel-card-phon`,
      style: "flex-shrink:0;",
    }, [abbr]));
  }
  textWrap.append(row1);

  // 第二行：释义
  if (w.exp && !hideExp) {
    textWrap.append(el(doc, "div", {
      class: `${ref}-panel-card-exp`,
      style: "margin-top:2px;overflow-wrap:anywhere;width:100%;",
    }, [w.exp]));
  }

  // 编辑 / 删除按钮（右上角）
  const btnGroup = el(doc, "div", {
    style:
      "position:absolute;top:6px;right:6px;display:flex;flex-direction:row;gap:0;",
  });
  const editBtn = el(doc, "button", {
    type: "button",
    title: "编辑",
    class: `${ref}-panel-icon-btn`,
    style: "border:none;background:transparent;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px;line-height:1;display:inline-flex;align-items:center;",
  });
  editBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor">' +
    '<path d="M474.58679343 587.16868738c-11.45302241 0-22.90604486-4.37057868-31.6472022-13.11173601-17.48231469-17.48231469-17.48231469-45.83841849 0-63.29440437l487.24053555-487.24053552c17.48231469-17.48231469 45.81208967-17.48231469 63.29440431 0 17.48231469 17.48231469 17.48231469 45.83841849 0 63.29440441L506.23399561 574.05695137a44.61676276 44.61676276 0 0 1-31.64720218 13.11173601z"/>' +
    '<path d="M904.16728498 1017.19676833h-781.96497912c-62.68884228 0-113.68770304-50.99886074-113.68770305-113.71403181v-781.96497913c0-62.71517108 50.99886074-113.71403182 113.66137425-113.71403185l457.51533479 0.0263288c24.72273117 0 44.75893818 20.03620706 44.75893819 44.7589382s-20.03620706 44.75893818-44.75893819 44.7589382l-457.51533479-0.02632877c-13.2960375 0-24.14349786 10.84746035-24.14349785 24.16982661v781.96497915c0 13.32236631 10.84746035 24.1698266 24.16982665 24.16982664h781.96497912c13.32236631 0 24.1698266-10.84746035 24.16982668-24.16982664V403.42008173c0-24.72273117 20.06253583-44.75893818 44.75893815-44.75893828 24.72273117 0 44.75893818 20.03620706 44.7589382 44.75893828V903.50906532c0 62.68884228-50.99886074 113.68770304-113.68770303 113.68770301z"/>' +
    "</svg>";
  editBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void openEditTermDialog(doc, body, itemID, platform, w, idx);
  });
  const delBtn = el(doc, "button", {
    type: "button",
    title: "删除",
    class: `${ref}-panel-icon-btn`,
    style: "border:none;background:transparent;color:#999;cursor:pointer;font-size:15px;padding:2px 6px;border-radius:4px;line-height:1;",
  }, ["✕"]);
  delBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void confirmDeleteTerm(doc, body, itemID, platform, w, idx);
  });
  btnGroup.append(editBtn, delBtn);

  card.append(textWrap, btnGroup);
  return card;
}

/** 编辑术语弹窗（术语/缩写/释义）。 */
function openEditTermDialog(
  doc: Document,
  body: HTMLElement,
  itemID: number,
  platform: "local" | "zotero",
  w: PanelWord,
  idx: number,
): void {
  const overlay = el(doc, "div", {
    style:
      "position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:2147483647;" +
      "display:flex;align-items:center;justify-content:center;",
  });
  const dlg = el(doc, "div", {
    style:
      "background:var(--color-sidepane,#fff);border:1px solid var(--color-border,#d4d4d4);" +
      "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.2);padding:16px;width:360px;max-width:90vw;",
  });
  dlg.append(el(doc, "div", { style: "font-weight:600;margin-bottom:10px;" }, ["编辑术语"]));

  const mkField = (label: string, value: string): HTMLInputElement => {
    dlg.append(el(doc, "label", { style: "display:block;font-size:12px;color:#666;margin-top:6px;" }, [label]));
    const input = el(doc, "input", {
      type: "text",
      style: "width:100%;box-sizing:border-box;margin-top:2px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;",
    }) as HTMLInputElement;
    input.value = value;
    dlg.append(input);
    return input;
  };

  const termInput = mkField("术语", w.word);
  const abbrInput = mkField("缩写（选填）", w.abbr || "");
  const expInput = mkField("释义", w.exp);

  const btnRow = el(doc, "div", { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;" });
  const saveBtn = el(doc, "button", {
    style:
      "border:1px solid #1e88e5;background:#1e88e5;color:#fff;border-radius:6px;" +
      "cursor:pointer;padding:4px 14px;font-size:13px;",
  }, ["保存"]);
  saveBtn.addEventListener("click", async () => {
    const patch = {
      term: termInput.value.trim(),
      abbr: abbrInput.value.trim(),
      exp: expInput.value.trim(),
    };
    overlay.remove();
    if (!patch.term) return;
    let ok = false;
    try {
      const { updateTerminologyEntry } = await import("./terminology");
      ok = await updateTerminologyEntry(platform, idx, w.word, patch);
    } catch { /* ignore */ }
    if (ok) {
      // 术语注释同步：勾选「加入术语库时同步添加到注释」时,同步更新带术语
      // tag 的注释(参考生词卡片行为;用术语 tag 过滤,避免误伤同名词条
      // 的生词注释;词形还原感知匹配,容错不抛错)。
      try {
        if (getPref("enableTerminologyAnnotationSync")) {
          const termTag = (getPref("terminologyTagName") as string) || "术语";
          await updateAnnotationsForWord(w.word, {
            word: patch.term,
            exp: patch.exp,
          }, w.exp, termTag);
        }
      } catch { /* ignore */ }
      refreshAllPanels();
    }
  });
  const cancelBtn = el(doc, "button", {
    style: "border:1px solid #ccc;background:transparent;border-radius:6px;cursor:pointer;padding:4px 14px;font-size:13px;",
  }, ["取消"]);
  cancelBtn.addEventListener("click", () => overlay.remove());
  btnRow.append(cancelBtn, saveBtn);
  dlg.append(btnRow);

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  overlay.append(dlg);
  mountOverlay(doc, overlay);
  termInput.focus();
}

/** 删除术语（二次确认）。 */
function confirmDeleteTerm(
  doc: Document,
  body: HTMLElement,
  itemID: number,
  platform: "local" | "zotero",
  w: PanelWord,
  idx: number,
): void {
  showConfirm(doc, body, "删除术语", `确定删除「${w.word}」吗？`, async () => {
    let ok = false;
    try {
      const { deleteTerminologyEntry } = await import("./terminology");
      ok = await deleteTerminologyEntry(platform, idx, w.word);
    } catch { /* ignore */ }
    if (ok) {
      // 术语注释同步：勾选「加入术语库时同步添加到注释」时,同步删除带术语
      // tag 的注释(参考生词卡片行为;用术语 tag 过滤避免误伤生词注释)。
      try {
        if (getPref("enableTerminologyAnnotationSync")) {
          const termTag = (getPref("terminologyTagName") as string) || "术语";
          await deleteAnnotationsForWord(w.word, termTag);
        }
      } catch { /* ignore */ }
      refreshAllPanels();
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Modal overlay (全屏遮罩，覆盖整个主窗口含信息栏)                   */
/* ------------------------------------------------------------------ */

/**
 * 将 overlay 挂载到主窗口 documentElement，确保遮罩覆盖整个窗口
 * （含 Item Pane 信息栏图标与搜索框），而非仅面板 body 区域。
 */
function mountOverlay(doc: Document, overlay: HTMLElement): void {
  try {
    const mainWin = Zotero.getMainWindow();
    const rootEl = mainWin.document.documentElement;
    if (rootEl) {
      rootEl.append(overlay);
      return;
    }
  } catch { /* fall through */ }
  // 兜底：挂到面板 body
  doc.body?.append(overlay);
}

/* ------------------------------------------------------------------ */
/*  Edit dialog (自定义 HTML 弹窗)                                     */
/* ------------------------------------------------------------------ */

function openEditDialog(
  doc: Document,
  body: HTMLElement,
  itemID: number,
  platform: "local" | "zotero",
  w: PanelWord,
  idx: number,
): void {
  // 遮罩层（挂主窗口，覆盖全屏）
  const overlay = el(doc, "div", {
    class: `${ref}-panel-overlay`,
    style:
      "position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:2147483647;" +
      "display:flex;align-items:center;justify-content:center;",
  });
  // 对话框
  const dlg = el(doc, "div", {
    class: `${ref}-panel-dialog`,
    style:
      "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.2);padding:16px;width:340px;max-width:90vw;",
  });
  dlg.append(el(doc, "div", { style: "font-weight:600;margin-bottom:10px;" }, [getString("hte-panel-edit-title")]));

  const mkField = (label: string, value: string): HTMLInputElement => {
    dlg.append(el(doc, "label", { style: "display:block;font-size:12px;margin-top:6px;" }, [label]));
    const input = el(doc, "input", {
      type: "text",
      style: "width:100%;box-sizing:border-box;margin-top:2px;padding:4px 6px;border:1px solid;border-radius:4px;",
    }) as HTMLInputElement;
    input.value = value;
    dlg.append(input);
    return input;
  };

  const wordInput = mkField(getString("hte-panel-edit-word"), w.word);
  const phonInput = mkField(getString("hte-panel-edit-phon"), w.phon);
  const expInput = mkField(getString("hte-panel-edit-exp"), w.exp);

  const btnRow = el(doc, "div", { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;" });
  const saveBtn = el(doc, "button", {
    type: "button",
    style:
      "border:1px solid #1e88e5;background:#1e88e5;color:#fff;border-radius:6px;" +
      "cursor:pointer;padding:4px 14px;font-size:13px;",
  }, [getString("hte-panel-edit-save")]);
  saveBtn.addEventListener("click", async () => {
    const patch = {
      word: wordInput.value.trim(),
      phon: phonInput.value.trim(),
      exp: expInput.value.trim(),
    };
    overlay.remove();
    if (!patch.word) return;
    let ok = false;
    if (platform === "local") {
      ok = await updateLocalWordByIndex(idx, patch);
    } else {
      ok = await updateWordInNote(getNoteTitle(), w.word, patch);
    }
    if (ok) {
      // 同步注释：若该单词有匹配注释（加入生词本时同步添加到注释的），
      // 注释中的单词与翻译也一并更新（词形还原感知匹配，容错不抛错）。
      try {
        await updateAnnotationsForWord(w.word, {
          word: patch.word,
          exp: patch.exp,
        }, w.exp);
      } catch { /* ignore */ }
      // 刷新所有已注册面板：主窗口条目面板与 PDF reader 侧面板的条目 key
      // 可能不同（父条目 ID vs 附件 ID），仅刷 itemID 会导致另一侧不同步。
      refreshAllPanels();
    }
  });
  const cancelBtn = el(doc, "button", {
    type: "button",
    style: "border:1px solid;background:transparent;border-radius:6px;cursor:pointer;padding:4px 14px;font-size:13px;",
  }, [getString("hte-panel-edit-cancel")]);
  cancelBtn.addEventListener("click", () => overlay.remove());
  btnRow.append(cancelBtn, saveBtn);
  dlg.append(btnRow);

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  overlay.append(dlg);
  // 挂到主窗口 documentElement，覆盖整个窗口（含信息栏）
  mountOverlay(doc, overlay);
  wordInput.focus();
}

/* ------------------------------------------------------------------ */
/*  Delete / Clear confirm                                             */
/* ------------------------------------------------------------------ */

function confirmDelete(
  doc: Document,
  body: HTMLElement,
  itemID: number,
  platform: "local" | "zotero",
  w: PanelWord,
  idx: number,
): void {
  showConfirm(doc, body, getString("hte-panel-del-title"), getString("hte-panel-del-msg", { args: { word: w.word } }), async () => {
    let ok = false;
    if (platform === "local") {
      ok = await deleteLocalWordByIndex(idx);
    } else {
      ok = await deleteWordFromNote(getNoteTitle(), w.word);
    }
    if (ok) {
      // 同步删除注释：加入生词本时同步添加到注释的（词形还原感知匹配，容错不抛错）
      try {
        await deleteAnnotationsForWord(w.word);
      } catch { /* ignore */ }
      // 刷新所有面板（主窗口 + PDF reader 侧），避免一侧不同步
      refreshAllPanels();
    }
  });
}

function confirmClear(
  doc: Document,
  body: HTMLElement,
  itemID: number,
  platform: "local" | "zotero" | null,
  mode: "wordbook" | "terminology" = "wordbook",
): void {
  if (!platform) return;
  const scope = getPref("panelWordScope") === "current" ? "current" : "all";
  const title = mode === "terminology" ? "清空术语库" : getString("hte-panel-clear-title");
  const msg = mode === "terminology"
    ? "确定清空当前条目的全部术语吗？此操作不可撤销。"
    : getString("hte-panel-clear-msg");
  showConfirm(doc, body, title, msg, async () => {
    if (mode === "terminology") {
      // 术语库清空：按平台遍历删除（local 按索引倒序，zotero 按 term）
      let deletedTerms: string[] = [];
      try {
        const { getTerminologyTerms, deleteTerminologyEntry } = await import("./terminology");
        const { platform: termPlatform, terms } = await getTerminologyTerms();
        const targets =
          scope === "current"
            ? terms.filter((t) => srcBelongsToItem(resolveSrcItemID(t.src), itemID))
            : terms;
        if (termPlatform === "local") {
          // 本地术语表：先在全量快照中收集所有匹配目标的行索引，
          // 再按索引**倒序**删除 —— 删除靠后的行不会影响靠前行索引，
          // 避免顺序删除时索引错位导致残留（修复「清空后术语卡片有残留」）。
          const all = await (await import("./terminology")).getTerms();
          const idxs = all
            .map((r, i) => ({ r, i }))
            .filter(({ r }) =>
              targets.some(
                (t) => t.term.toLowerCase() === r.term.toLowerCase() && t.src === r.src,
              ),
            )
            .map(({ i }) => i)
            .sort((a, b) => b - a); // 倒序
          for (const idx of idxs) {
            await deleteTerminologyEntry("local", idx, all[idx].term);
            deletedTerms.push(all[idx].term);
          }
        } else {
          for (const t of targets) {
            await deleteTerminologyEntry("zotero", -1, t.term);
            deletedTerms.push(t.term);
          }
        }
      } catch { /* ignore */ }
      // 术语注释同步：勾选「加入术语库时同步添加到注释」时,同步删除每个
      // 被清空术语对应的注释(带术语 tag,容错不抛错)。
      try {
        if (getPref("enableTerminologyAnnotationSync")) {
          const termTag = (getPref("terminologyTagName") as string) || "术语";
          for (const term of deletedTerms) {
            await deleteAnnotationsForWord(term, termTag);
          }
        }
      } catch { /* ignore */ }
      refreshAllPanels();
      return;
    }
    const { words } = await loadWords();
    // 「当前条目」视图：只清空属于当前条目的词条；「所有条目」视图清空全部
    const targets =
      scope === "current"
        ? words.filter((w) => srcBelongsToItem(w.srcItemID, itemID))
        : words;
    if (platform === "local") {
      // 本地 CSV 无条目概念，仅按 src 归属过滤后逐条删除（需按单词匹配行索引）
      for (const w of targets) {
        const rows = await getLocalWords();
        const idx = rows.findIndex(
          (r) => r.word.toLowerCase() === w.word.toLowerCase() && r.src === w.src,
        );
        if (idx >= 0) await deleteLocalWordByIndex(idx);
      }
    } else {
      for (const w of targets) {
        await deleteWordFromNote(getNoteTitle(), w.word);
      }
    }
    // 同步删除注释：清空的每个单词若有匹配注释一并删除（容错不抛错）
    try {
      for (const w of targets) {
        await deleteAnnotationsForWord(w.word);
      }
    } catch { /* ignore */ }
    // 刷新所有面板（主窗口 + PDF reader 侧），避免一侧不同步
    refreshAllPanels();
  });
}

function showConfirm(
  doc: Document,
  body: HTMLElement,
  title: string,
  message: string,
  onOk: () => void,
): void {
  const overlay = el(doc, "div", {
    class: `${ref}-panel-overlay`,
    style:
      "position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:2147483647;" +
      "display:flex;align-items:center;justify-content:center;",
  });
  const dlg = el(doc, "div", {
    class: `${ref}-panel-dialog`,
    style:
      "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.2);padding:16px;width:320px;max-width:90vw;",
  });
  dlg.append(el(doc, "div", { style: "font-weight:600;margin-bottom:8px;" }, [title]));
  dlg.append(el(doc, "div", { style: "font-size:13px;margin-bottom:14px;word-break:break-word;" }, [message]));

  const btnRow = el(doc, "div", { style: "display:flex;justify-content:flex-end;gap:8px;" });
  const okBtn = el(doc, "button", {
    type: "button",
    style: "border:1px solid #d9534f;background:#d9534f;color:#fff;border-radius:6px;cursor:pointer;padding:4px 14px;font-size:13px;",
  }, [getString("hte-panel-confirm-ok")]);
  okBtn.addEventListener("click", () => {
    overlay.remove();
    onOk();
  });
  const cancelBtn = el(doc, "button", {
    type: "button",
    style: "border:1px solid;background:transparent;border-radius:6px;cursor:pointer;padding:4px 14px;font-size:13px;",
  }, [getString("hte-panel-confirm-cancel")]);
  cancelBtn.addEventListener("click", () => overlay.remove());
  btnRow.append(cancelBtn, okBtn);
  dlg.append(btnRow);

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) overlay.remove();
  });
  overlay.append(dlg);
  // 挂到主窗口 documentElement，覆盖整个窗口（含信息栏）
  mountOverlay(doc, overlay);
}

/* ------------------------------------------------------------------ */
/*  Refresh & registration                                             */
/* ------------------------------------------------------------------ */

/** 主动刷新面板（加词/编辑/删除后调用）——刷新所有窗口的所有面板。
 *  保留 itemID 参数仅为兼容旧调用点，内部统一走 refreshAllPanels（强制重渲染）。 */
export function refreshPanel(itemID: number): void {
  refreshAllPanels();
}

/** 注册 Item Pane 面板。开启「生词本面板」后调用；返回注册 key 或 null。 */
export function registerWordbookPanel(): string | null {
  try {
    if (typeof (Zotero as any).ItemPaneManager?.registerSection !== "function") {
      Zotero.debug("[hover-translate-eudic/panel] ItemPaneManager.registerSection unavailable");
      return null;
    }
    const key = (Zotero as any).ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: PLUGIN_ID,
      header: {
        // 注意：本项目 scaffold 构建会给 ftl 键加 addonRef 前缀
        // （hovertranslateeudic-hte-panel-head），l10nID 必须用带前缀的
        // 完整键（getLocaleID 封装），否则 ItemPane 的 document.l10n 找不到。
        l10nID: getLocaleID("hte-panel-head"),
        icon: ICON_URI,
      },
      sidenav: {
        l10nID: getLocaleID("hte-panel-sidenav"),
        icon: ICON_URI,
        orderable: false,
      },
      bodyXHTML: `<html:div class="${ref}-panel-body" style="padding:8px;"></html:div>`,
      onInit: ({ body, refresh, setEnabled }: any) => {
        // 启用条件：与 reevaluatePanelEnabled 同一逻辑（平台∨同步至本地∨术语库）。
        // 注意：**主窗口与 PDF reader 窗口的面板都启用**（用户期望两侧都可用、
        // 内容同步）。不要按窗口禁用——早前把非主窗口 setEnabled(false) 导致
        // PDF 侧面板"完全无反应"（按钮点击无效）。同一窗口内内容叠加的问题
        // 由 _panelRenderGen（WeakMap 按 body 隔离）解决，与窗口无关。
        setEnabled(computePanelEnabled());
        const uid = Zotero.Utilities.randomString(8);
        if (body) {
          body.dataset.htePaneUid = uid;
          (body as any)._hteRefresh = refresh;
          (body as any)._hteSetEnabled = setEnabled;
        }
      },
      onDestroy: ({ body }: any) => {
        const uid = body?.dataset?.htePaneUid;
        if (uid) getPanelEntries().delete(uid);
      },
      onItemChange: ({ item, setEnabled, body }: any) => {
        // 主窗口与 PDF reader 窗口都启用（与 onInit 同一条件）
        setEnabled(computePanelEnabled());
        // 切换条目 / PDF 时强制刷新面板内容。
        // Zotero 的 _isAlreadyRendered 以 [tabID, item.id] 为缓存依赖，
        // 同一父条目下切换不同 PDF 附件时 item.id 不变不会触发 onRender，
        // 因此这里主动调用 refresh 绕过缓存（延迟到当前渲染循环结束后）。
        try {
          const itemID = Number(item?.id || 0);
          const lastID = Number(body?.dataset?.hteLastItemID || 0);
          if (itemID && itemID !== lastID && body?._hteRefresh) {
            body.dataset.hteLastItemID = String(itemID);
            setTimeout(() => {
              try {
                body._hteRefresh();
              } catch { /* ignore */ }
            }, 0);
          }
        } catch { /* ignore */ }
      },
      onRender: ({ doc, body, item }: any) => {
        const itemID = Number(item?.id || 0);
        if (!itemID) return;
        // key 用 paneUID（每窗口 section 实例唯一），避免主窗口/PDF 附件
        // 共用 itemID 导致的互相覆盖（刷新回调丢失 → 一侧面板无反应）
        const uid = body?.dataset?.htePaneUid;
        if (uid && (body as any)._hteRefresh) {
          getPanelEntries().set(uid, {
            refresh: (body as any)._hteRefresh,
            setEnabled: (body as any)._hteSetEnabled || (() => {}),
            // 直接重渲染：绕过 Zotero hidden/pending 拦截，任何状态下强制刷新
            rerender: () => void renderPanel(doc, body, itemID),
          });
        }
        // onRender 必须同步；实际渲染在 renderPanel 内异步完成
        void renderPanel(doc, body, itemID);
      },
    });
    _paneKey = key || null;
    if (_paneKey) {
      startThemeWatcher();
      // 平台切换 / 同步至本地 / 开启术语库 变化时实时更新
      // 信息栏面板与开启按钮的启用状态，无需取消/重新勾选或重启 Zotero。
      if (!_platformObserver) {
        _platformObserver = registerPrefObserver("wordbookPlatform", () => {
          reevaluatePanelEnabled();
        });
      }
      if (!_syncObserver) {
        _syncObserver = registerPrefObserver("syncToLocal", () => {
          reevaluatePanelEnabled();
        });
      }
      if (!_termObserver) {
        _termObserver = registerPrefObserver("enableTerminology", () => {
          reevaluatePanelEnabled();
        });
      }
    }
    return _paneKey;
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/panel] register error: ${e?.message || e}`);
    return null;
  }
}

/** 注销 Item Pane 面板。 */
export function unregisterWordbookPanel(): void {
  try {
    if (_paneKey && (Zotero as any).ItemPaneManager?.unregisterSection) {
      (Zotero as any).ItemPaneManager.unregisterSection(_paneKey);
    }
  } catch (e: any) {
    Zotero.debug(`[hover-translate-eudic/panel] unregister error: ${e?.message || e}`);
  }
  _paneKey = null;
  stopThemeWatcher();
  try {
    if (_platformObserver) {
      Zotero.Prefs.unregisterObserver(_platformObserver);
      _platformObserver = null;
    }
    if (_syncObserver) {
      Zotero.Prefs.unregisterObserver(_syncObserver);
      _syncObserver = null;
    }
    if (_termObserver) {
      Zotero.Prefs.unregisterObserver(_termObserver);
      _termObserver = null;
    }
  } catch { /* ignore */ }
  getPanelEntries().clear();
}

/** 注入面板样式（挂一次，body 内部最安全）。 */
function injectStyle(body: HTMLElement): void {
  if (body.querySelector(`.${ref}-panel-style`)) return;
  const doc = body.ownerDocument;
  if (!doc) return;
  const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style") as HTMLStyleElement;
  style.className = `${ref}-panel-style`;
  style.textContent = `
    .${ref}-panel-body { font-family: inherit; color: var(--fill-primary, #1a1a1a); }
    .${ref}-panel-body button:hover { background: rgba(0,0,0,0.06); }
    .${ref}-panel-body a:hover { text-decoration: underline; }

    /* 卡片：亮色白底（显式 #fafafa，不依赖 var，避免 zotero-style 等将
       --color-sidepane 改为深色导致亮色下仍为深色）。暗色由 @media 主机制覆盖。 */
    .${ref}-panel-card {
      background: #fafafa;
      border: 1px solid var(--color-border, rgba(0,0,0,0.12));
      color: var(--fill-primary, #1a1a1a);
    }
    .${ref}-panel-card-word { color: #1e88e5; }
    .${ref}-panel-card-phon { color: var(--fill-secondary, #888888); }
    .${ref}-panel-card-exp { color: var(--fill-primary, #333333); }

    /* 工具栏按钮 */
    .${ref}-panel-toolbar-btn {
      border: 1px solid var(--color-border, #ccc);
      background: transparent;
      color: var(--fill-secondary, #555);
    }
    .${ref}-panel-toolbar-btn:hover { background: rgba(0,0,0,0.06); }
    .${ref}-panel-toolbar-btn-active {
      background: rgba(0,0,0,0.12);
      color: var(--fill-primary, #111);
    }

    /* 图标按钮（编辑/删除） */
    .${ref}-panel-icon-btn { color: var(--fill-secondary, #999); }
    .${ref}-panel-icon-btn:hover { color: var(--fill-primary, #555); background: rgba(0,0,0,0.06); }

    /* 发音播放按钮（位于音标后；隐藏音标时自动跟在单词后） */
    .${ref}-panel-play-btn { color: var(--fill-secondary, #888); }
    .${ref}-panel-play-btn:hover { color: #1e88e5; background: rgba(0,0,0,0.06); }

    /* 提示 / 空态 */
    .${ref}-panel-hint { color: var(--fill-secondary, #888); }

    /* 弹窗 */
    .${ref}-panel-dialog {
      background: var(--color-sidepane, #fff);
      border: 1px solid var(--color-border, #d4d4d4);
      color: var(--fill-primary, #1a1a1a);
    }
    .${ref}-panel-dialog input {
      background: var(--color-sidepane, #fff);
      border-color: var(--color-border, #ccc);
      color: var(--fill-primary, #1a1a1a);
    }
    .${ref}-panel-dialog label { color: var(--fill-secondary, #666); }
    .${ref}-panel-dialog button { color: var(--fill-primary, #1a1a1a); }

    /* ================= 深色模式主机制：@media (prefers-color-scheme: dark) =================
       Zotero 7 官方（reader.js / aceWrapper.js / cachedTypes.js）全部用该媒体特性检测主题，
       它跟随 Zotero 主题 pref（browser.theme.toolbar-theme）而非 OS —— 内核级、100% 可靠，
       不依赖任何 JS 检测或 DOM 属性。亮色模式不受影响（默认 #fafafa 白底）。 */
    @media (prefers-color-scheme: dark) {
      .${ref}-panel-body { color: #e6e6e6; }
      .${ref}-panel-body button:hover { background: rgba(255,255,255,0.1); }
      .${ref}-panel-card {
        background: #2c323e;
        border-color: rgba(255,255,255,0.15);
        color: #e6e6e6;
      }
      .${ref}-panel-card-word { color: #6db3f2; }
      .${ref}-panel-card-phon { color: #9aa0aa; }
      .${ref}-panel-card-exp { color: #d0d0d0; }
      .${ref}-panel-toolbar-btn {
        border-color: rgba(255,255,255,0.25);
        background: transparent;
        color: #e6e6e6 !important;
      }
      .${ref}-panel-toolbar-btn:hover { background: rgba(255,255,255,0.12); }
      .${ref}-panel-toolbar-btn-active {
        background: rgba(100,160,255,0.35) !important;
        color: #ffffff !important;
        border-color: rgba(100,160,255,0.6) !important;
      }
      .${ref}-panel-icon-btn { color: #9aa0aa; }
      .${ref}-panel-icon-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
      .${ref}-panel-play-btn { color: #9aa0aa; }
      .${ref}-panel-play-btn:hover { color: #6db3f2; background: rgba(255,255,255,0.1); }
      .${ref}-panel-hint { color: #9aa0aa; }
      .${ref}-panel-dialog {
        background: #2c323e;
        border-color: rgba(255,255,255,0.15);
        color: #e6e6e6;
      }
      .${ref}-panel-dialog input {
        background: #23272f;
        border-color: rgba(255,255,255,0.2);
        color: #e6e6e6;
      }
      .${ref}-panel-dialog label { color: #9aa0aa; }
      .${ref}-panel-dialog button { color: #e6e6e6; }
      .${ref}-panel-overlay { background: rgba(0,0,0,0.45); }
    }

    /* 辅助兜底 1：data-hte-theme（JS detectDark 检测成功时精确覆盖，与 @media 等价） */
    .${ref}-panel-body[data-hte-theme="dark"] { color: #e6e6e6; }
    .${ref}-panel-body[data-hte-theme="dark"] button:hover { background: rgba(255,255,255,0.1); }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-card {
      background: #2c323e;
      border-color: rgba(255,255,255,0.15);
      color: #e6e6e6;
    }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-card-word { color: #6db3f2; }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-card-phon { color: #9aa0aa; }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-card-exp { color: #d0d0d0; }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-toolbar-btn {
      border-color: rgba(255,255,255,0.25);
      background: transparent;
      color: #e6e6e6 !important;
    }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-toolbar-btn:hover {
      background: rgba(255,255,255,0.12);
    }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-toolbar-btn-active {
      background: rgba(100,160,255,0.35) !important;
      color: #ffffff !important;
      border-color: rgba(100,160,255,0.6) !important;
    }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-icon-btn { color: #9aa0aa; }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-icon-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-play-btn { color: #9aa0aa; }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-play-btn:hover { color: #6db3f2; background: rgba(255,255,255,0.1); }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-hint { color: #9aa0aa; }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-dialog {
      background: #2c323e;
      border-color: rgba(255,255,255,0.15);
      color: #e6e6e6;
    }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-dialog input {
      background: #23272f;
      border-color: rgba(255,255,255,0.2);
      color: #e6e6e6;
    }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-dialog label { color: #9aa0aa; }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-dialog button { color: #e6e6e6; }
    .${ref}-panel-body[data-hte-theme="dark"] .${ref}-panel-overlay { background: rgba(0,0,0,0.45); }

    /* 辅助兜底 2：window[theme="dark"]（zotero-style 老式属性） */
    window[theme="dark"] .${ref}-panel-card { background: #2c323e; }
    window[theme="dark"] .${ref}-panel-card-exp { color: #d0d0d0; }
    window[theme="dark"] .${ref}-panel-card-phon { color: #9aa0aa; }
    window[theme="dark"] .${ref}-panel-body button { color: #bbb; }
    window[theme="dark"] .${ref}-panel-dialog {
      background: #2c323e;
      border-color: rgba(255,255,255,0.15);
      color: #e6e6e6;
    }
  `;
  body.append(style);
}
