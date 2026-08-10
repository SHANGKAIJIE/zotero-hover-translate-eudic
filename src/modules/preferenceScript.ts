/**
 * Preference panel script.
 *
 * Handles UI interactions that the static `preference=` binding cannot cover:
 *  - toggle modifier-key row enabled state based on triggerMode
 *  - toggle Eudic config box based on enableEudicSync
 *  - refresh wordbook category list from Eudic OpenAPI
 *  - sync eudicCategoryName when the target category changes
 *  - refresh category list when the word language changes
 *  - reset all settings to defaults
 */
import { config } from "../../package.json";
import { getPref, setPref, clearPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { EudicClient, createEudicClientFromPrefs } from "./eudic";
import { MaimemoClient, createMaimemoClientFromPrefs } from "./maimemo";
import { ShanbayClient, createShanbayClientFromPrefs } from "./shanbay";
import { exportWordbook, exportWordEntries } from "./eudicExport";
import { getWords as getLocalWords } from "./localWordbook";
import { getWordsFromNote, openNoteForEditing, listNotes, createNoteWordbook, renameNoteWordbook, deleteNoteWordbook, getNoteTitle } from "./zoteroNote";
import { parseKeybinding } from "./addWordShortcut";
import { FilePickerHelper } from "zotero-plugin-toolkit";

const ref = config.addonRef;
const $ = (id: string, win: Window) =>
  win.document.getElementById(id) as any;

const DEFAULTS: Record<string, any> = {
  enableHoverTranslate: true,
  triggerMode: "hover",
  modifierCtrl: false,
  modifierAlt: false,
  modifierShift: false,
  enableHighlight: false,
  highlightColor: "rgba(255,233,79,1.0)",
  hoverDelay: 900,
  disableOnSelection: true,
  popupAutoCloseDelay: 30,
  popupPosition: "top",
  translateDisplayMode: "simple",
  translateEngine: "dict" as string,
  enableEudicSync: false,
  wordbookPlatform: "eudic",
  eudicToken: "",
  eudicCategoryId: "0",
  eudicCategoryName: "默认生词本",
  maimemoToken: "",
  maimemoCategoryId: "",
  maimemoCategoryName: "",
  shanbayToken: "",
  shanbayCategoryId: "default",
  shanbayCategoryName: "默认生词本",
  eudicLanguage: "en",
  buttonShowScene: "both",
  addWordMode: "manual",
  addWordShortcut: "",
  lemmaMode: "lemma",
  localSavePath: "",
  zoteroNoteTitle: "生词本",
  // 同步至本地（平台为欧路/扇贝/墨墨时显示）
  syncToLocal: "none",
  // 术语库设置
  enableTerminology: false,
  terminologyPlatform: "local",
  terminologyLocalSavePath: "",
  terminologyNoteTitle: "术语库",
  // 生词本面板设置
  enableWordbookPanel: false,
  panelFontSize: 15,
  panelHidePhon: false,
  panelHideExp: false,
  panelHidePlay: false,
  panelHideAbbr: false,
  panelWordScope: "current",
  panelSortMode: "reverse",
  panelContentMode: "wordbook",
  // 注释设置
  enableAnnotationSync: false,
  enableAnnotationTranslate: false,
  annotationTranslatePosition: "comment",
  annotationTranslatePositionInBody: "before",
  annotationSeparator: "\n\n",
  annotationMarkType: "highlight",
  annotationColor: "#ffd400",
  enableAnnotationAutoTag: false,
  annotationTagName: "单词",
  // 术语注释
  enableTerminologyAnnotationSync: false,
  terminologyMarkType: "highlight",
  terminologyColor: "#ffd400",
  terminologyTagName: "术语",
  hideNoteIcon: false,
  hideNoteIconMode: "word",
  hideNoteIconNotes: false,
  exportContent: "wordbook",
  exportAutoReveal: true,
  exportSavePath: "",
};

export async function registerPrefsScripts(win: Window) {
  addon.data.prefs = { window: win };
  updateModifierRowState(win);
  updateHoverConfigState(win);
  updateEudicBoxState(win);
  updateTokenVisibility(win);
  syncCategorySelectionUI(win);
  initColorPicker(win);
  initAnnotationColorPicker(win);
  initTerminologyColorPicker(win);
  updateAnnotationBoxState(win);
  updateAnnotationTranslatePositionState(win);
  updateHideNoteIconState(win);
  updateSyncToLocalState(win);
  updateTerminologyState(win);
  bindPrefEvents(win);
  // Auto-fetch categories on panel open if token is configured for the active platform.
  const platform = getPref("wordbookPlatform") as string;
  let token: string | undefined;
  if (platform === "maimemo") token = getPref("maimemoToken") as string;
  else if (platform === "shanbay") token = getPref("shanbayToken") as string;
  else token = getPref("eudicToken") as string;
  const autoFetch = getPref("enableEudicSync") && !!token;
  // Zotero 笔记平台：无需 token，直接填充笔记标题下拉
  if (autoFetch || platform === "zotero") {
    win.setTimeout(() => void refreshCategories(win, true), 200);
  }
  updateTranslateEngineHintVisibility(win);
  // Defer: let Zotero's preference binding + Fluent localization settle,
  // then force menulist labels to refresh from current pref values.
  win.setTimeout(() => {
    updateModifierRowState(win);
    updateTokenVisibility(win);
    syncAllMenulists(win);
  }, 100);
  win.setTimeout(() => syncAllMenulists(win), 500);
}

/** Init the color picker + hex + alpha inputs from the saved rgba highlight color. */
function initColorPicker(win: Window) {
  const picker = $(`zotero-prefpane-${ref}-highlightColorPicker`, win) as any;
  const hidden = $(`zotero-prefpane-${ref}-highlightColor`, win) as any;
  const hexInput = $(`zotero-prefpane-${ref}-highlightColorHex`, win) as any;
  const aInput = $(`zotero-prefpane-${ref}-highlightColorA`, win) as any;
  if (!picker || !hidden) return;

  // Parse the saved rgba string and populate all inputs.
  const syncFromPref = () => {
    const rgba = String(getPref("highlightColor") || "");
    const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\)/);
    if (m) {
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      const a = m[4] !== undefined ? Math.round(parseFloat(m[4]) * 100) : 45;
      const hex =
        "#" +
        [r, g, b]
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
      picker.value = hex;
      if (hexInput) hexInput.value = hex;
      if (aInput) aInput.value = a;
    }
  };
  syncFromPref();

  // Write the current hex + alpha values back to the pref + color picker.
  const syncToPref = () => {
    const hexRaw = String(hexInput?.value || "").trim();
    const hexMatch = hexRaw.match(/^#?([0-9a-fA-F]{6})$/);
    const hex = hexMatch
      ? "#" + hexMatch[1].toLowerCase()
      : "#ffe949";
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const aPct = Math.max(0, Math.min(100, parseInt(aInput?.value) || 0));
    const a = (aPct / 100).toFixed(2);
    const rgba = `rgba(${r},${g},${b},${a})`;
    hidden.value = rgba;
    setPref("highlightColor", rgba);
    picker.value = hex;
    if (hexInput && hexInput.value !== hex) hexInput.value = hex;
  };

  // Color picker → hex input + pref.
  picker.addEventListener("input", () => {
    const hex = picker.value || "#ffe949";
    if (hexInput) hexInput.value = hex;
    syncToPref();
  });

  // hex input → pref + color picker.
  if (hexInput) {
    hexInput.addEventListener("input", syncToPref);
    hexInput.addEventListener("change", syncToPref);
  }

  // alpha input → pref.
  if (aInput) {
    aInput.addEventListener("input", syncToPref);
    aInput.addEventListener("change", syncToPref);
  }
}

/** Init the annotation color picker + hex input from the saved hex annotation color. */
function initAnnotationColorPicker(win: Window) {
  const picker = $(`zotero-prefpane-${ref}-annotationColorPicker`, win) as any;
  const hexInput = $(`zotero-prefpane-${ref}-annotationColorHex`, win) as any;
  if (!picker) return;

  const syncFromPref = () => {
    const hex = String(getPref("annotationColor") || "#ffd400");
    picker.value = hex;
    if (hexInput) hexInput.value = hex;
  };
  syncFromPref();

  const syncToPref = () => {
    const hexRaw = String(hexInput?.value || "").trim();
    const hexMatch = hexRaw.match(/^#?([0-9a-fA-F]{6})$/);
    const hex = hexMatch
      ? "#" + hexMatch[1].toLowerCase()
      : "#ffd400";
    setPref("annotationColor", hex);
    picker.value = hex;
    if (hexInput && hexInput.value !== hex) hexInput.value = hex;
  };

  picker.addEventListener("input", () => {
    const hex = picker.value || "#ffd400";
    if (hexInput) hexInput.value = hex;
    syncToPref();
  });

  if (hexInput) {
    hexInput.addEventListener("input", syncToPref);
    hexInput.addEventListener("change", syncToPref);
  }
}

/** Init the terminology color picker + hex input (术语标注颜色). */
function initTerminologyColorPicker(win: Window) {
  const picker = $(`zotero-prefpane-${ref}-terminologyColorPicker`, win) as any;
  const hexInput = $(`zotero-prefpane-${ref}-terminologyColorHex`, win) as any;
  if (!picker) return;

  const syncFromPref = () => {
    const hex = String(getPref("terminologyColor") || "#ffd400");
    picker.value = hex;
    if (hexInput) hexInput.value = hex;
  };
  syncFromPref();

  const syncToPref = () => {
    const hexRaw = String(hexInput?.value || "").trim();
    const hexMatch = hexRaw.match(/^#?([0-9a-fA-F]{6})$/);
    const hex = hexMatch
      ? "#" + hexMatch[1].toLowerCase()
      : "#ffd400";
    setPref("terminologyColor", hex);
    picker.value = hex;
    if (hexInput && hexInput.value !== hex) hexInput.value = hex;
  };

  picker.addEventListener("input", () => {
    const hex = picker.value || "#ffd400";
    if (hexInput) hexInput.value = hex;
    syncToPref();
  });

  if (hexInput) {
    hexInput.addEventListener("input", syncToPref);
    hexInput.addEventListener("change", syncToPref);
  }
}

/** Force every bound menulist to reflect its current pref value's label. */
function syncAllMenulists(win: Window) {
  const isZoteroPlatform = (getPref("wordbookPlatform") as string) === "zotero";
  win.document.querySelectorAll("menulist[preference]").forEach((ml: any) => {
    const key = ml.getAttribute("preference");
    if (!key) return;
    // Zotero 笔记平台：eudicCategoryId 下拉实际承载笔记标题（由 refreshCategories 管理），跳过强制同步
    if (isZoteroPlatform && key === "eudicCategoryId") return;
    const val = getPref(key as any);
    if (val == null) return;
    const v = String(val);
    try {
      ml.value = v;
    } catch {
      /* ignore */
    }
    const item = ml.querySelector(`menuitem[value="${v}"]`) as any;
    if (item) {
      const label = item.label || item.getAttribute("label") || "";
      if (label) {
        try {
          ml.label = label;
        } catch {
          /* ignore */
        }
      }
    }
  });
}

/* ----------------------------- UI state ----------------------------- */

function updateModifierRowState(win: Window) {
  const mode = getPref("triggerMode");
  const modifierBox = $(`${ref}-modifierKeysBox`, win);
  if (modifierBox) {
    modifierBox.style.opacity = mode === "modifier" ? "1" : "0.45";
    modifierBox.style.pointerEvents = mode === "modifier" ? "auto" : "none";
  }
  ["modifierCtrl", "modifierAlt", "modifierShift"].forEach((k) => {
    const el = $(`zotero-prefpane-${ref}-${k}`, win);
    if (el) el.disabled = mode !== "modifier";
  });
  // When triggerMode is "click", hover delay is irrelevant — gray it out.
  const delayInput = $(`zotero-prefpane-${ref}-hoverDelay`, win);
  if (delayInput) delayInput.disabled = mode !== "hover";
  const delayRow = $(`${ref}-hoverDelayRow`, win);
  if (delayRow) {
    delayRow.style.opacity = mode === "hover" ? "1" : "0.45";
    delayRow.style.pointerEvents = mode === "hover" ? "auto" : "none";
  }
}

function updateHoverConfigState(win: Window) {
  const enabled = getPref("enableHoverTranslate");
  const box = $(`${ref}-hoverConfigBox`, win);
  if (!box) return;
  box.style.opacity = enabled ? "1" : "0.45";
  box.style.pointerEvents = enabled ? "auto" : "none";
}

function updateEudicBoxState(win: Window) {
  const enabled = getPref("enableEudicSync");
  const box = $(`${ref}-eudicConfigBox`, win);
  if (!box) return;
  // Toggle a visual disabled state on the config box.
  box.style.opacity = enabled ? "1" : "0.5";
  box.style.pointerEvents = enabled ? "auto" : "none";
}

/** Show/hide token boxes / path input based on selected platform. */
function updateTokenVisibility(win: Window) {
  const platform = getPref("wordbookPlatform") as string;
  const eudicBox = $(`${ref}-eudicTokenBox`, win);
  const maimemoBox = $(`${ref}-maimemoTokenBox`, win);
  const shanbayBox = $(`${ref}-shanbayTokenBox`, win);
  if (eudicBox) eudicBox.hidden = platform !== "eudic";
  if (maimemoBox) maimemoBox.hidden = platform !== "maimemo";
  if (shanbayBox) shanbayBox.hidden = platform !== "shanbay";
  const maimemoHint = $(`${ref}-maimemoExportHint`, win);
  if (maimemoHint) maimemoHint.hidden = platform !== "maimemo";
  const shanbayHint = $(`${ref}-shanbayExportHint`, win);
  if (shanbayHint) shanbayHint.hidden = platform !== "shanbay";
  const lemmaModeBox = $(`${ref}-lemmaModeBox`, win);
  if (lemmaModeBox) lemmaModeBox.hidden = platform === "maimemo" || platform === "shanbay";
  const localPathBox = $(`${ref}-localSavePathBox`, win);
  if (localPathBox) localPathBox.hidden = platform !== "local";
  const categoryRow = $(`${ref}-categoryRow`, win);
  if (categoryRow) categoryRow.hidden = platform === "local";

  // 同步至本地：仅当平台为欧路/扇贝/墨墨（云端平台）时显示
  const syncToLocalBox = $(`${ref}-syncToLocalBox`, win);
  if (syncToLocalBox) syncToLocalBox.hidden = platform === "local" || platform === "zotero";
  updateSyncToLocalState(win);

  // Zotero 笔记平台 UI：
  //  - 「选择生词本」文字改为「笔记名称」，固定为「生词本」（menulist 禁用）
  //  - 去掉「刷新列表」「编辑词本」按钮，保留「打开笔记」按钮
  const isZotero = platform === "zotero";
  const eudicCatLabel = $(`${ref}-eudicCategoryLabel`, win);
  const zoteroCatLabel = $(`${ref}-zoteroCategoryLabel`, win);
  if (eudicCatLabel) eudicCatLabel.hidden = isZotero;
  if (zoteroCatLabel) zoteroCatLabel.hidden = !isZotero;
  const catMenulist = $(`zotero-prefpane-${ref}-eudicCategoryId`, win);
  if (catMenulist) {
    catMenulist.disabled = isZotero;
    if (isZotero) {
      // 固定显示「生词本」（不随 eudicCategoryId pref 变化）
      try {
        catMenulist.value = "生词本";
        catMenulist.label = "生词本";
      } catch { /* ignore */ }
    }
  }
  const refreshBtn = $(`${ref}-refreshCategoryBtn`, win);
  if (refreshBtn) refreshBtn.hidden = isZotero;
  const editCatBtn = $(`${ref}-editCategoryBtn`, win);
  if (editCatBtn) editCatBtn.hidden = isZotero;
  const editNoteBtn = $(`${ref}-editNoteBtn`, win);
  if (editNoteBtn) editNoteBtn.hidden = !isZotero;

  // 生词本面板设置区块：始终显示（「开启右侧信息栏的生词本面板」与提示
  // 「仅当生词本平台为本地生词表、Zotero 笔记时可使用」一直可见）。
  // 实际启用由面板 setEnabled 逻辑控制：平台 ∈ {local, zotero} 且勾选
  // enableWordbookPanel 时才启用信息栏的面板与面板开启按钮。
  const panelSectionBox = $(`${ref}-panelSectionBox`, win);
  if (panelSectionBox) {
    panelSectionBox.hidden = false;
  }
}

/** Show/hide the translate engine hint — only visible when engine is "translate". */
function updateTranslateEngineHintVisibility(win: Window) {
  const engine = getPref("translateEngine") as string;
  const hint = $(`${ref}-translateEngineHint`, win);
  if (hint) hint.hidden = engine !== "translate";
}

/** 同步至本地：syncToLocal 值决定「存储路径+词形选择(本地)」或「笔记名称+词形选择(本地)」子区块的显示。 */
function updateSyncToLocalState(win: Window) {
  const mode = getPref("syncToLocal") as string;
  const localBox = $(`${ref}-syncLocalPathBox`, win);
  if (localBox) localBox.hidden = mode !== "local";
  const zoteroBox = $(`${ref}-syncZoteroBox`, win);
  if (zoteroBox) zoteroBox.hidden = mode !== "zotero";
}

/** 术语库设置：开启术语库 → 配置区可操作；平台决定 存储路径/笔记名称 显示。 */
function updateTerminologyState(win: Window) {
  const enabled = !!getPref("enableTerminology");
  const configBox = $(`${ref}-terminologyConfigBox`, win);
  if (configBox) {
    configBox.style.opacity = enabled ? "1" : "0.5";
    configBox.style.pointerEvents = enabled ? "auto" : "none";
  }
  const platform = getPref("terminologyPlatform") as string;
  const isZotero = platform === "zotero";
  const localBox = $(`${ref}-termLocalSavePathBox`, win);
  if (localBox) localBox.hidden = isZotero;
  const zoteroBox = $(`${ref}-termZoteroBox`, win);
  if (zoteroBox) zoteroBox.hidden = !isZotero;
  // 术语注释相关设置（加入术语库时同步添加到注释 / 术语标注方式 / 颜色 / 标签名）
  // 仅在启用术语库时显示。
  updateTerminologyAnnotationVisibility(win);
}

/** 术语注释设置组显隐：未勾选「启用术语库」时整体隐藏。 */
function updateTerminologyAnnotationVisibility(win: Window) {
  const show = !!getPref("enableTerminology");
  const ids = [
    `zotero-prefpane-${ref}-enableTerminologyAnnotationSync`,
    `${ref}-terminologyMarkTypeRow`,
    `${ref}-terminologyColorRow`,
    `${ref}-terminologyTagNameRow`,
  ];
  for (const id of ids) {
    const el = $(id, win);
    if (el) el.hidden = !show;
  }
}

/** Toggle the annotation config box enabled state based on enableAnnotationSync. */
function updateAnnotationBoxState(win: Window) {
  const enabled = getPref("enableAnnotationSync");
  const box = $(`${ref}-annotationConfigBox`, win);
  if (!box) return;
  box.style.opacity = enabled ? "1" : "0.45";
  box.style.pointerEvents = enabled ? "auto" : "none";
}

/**
 * Toggle the "hide note icon" sub-rows:
 *  - 总开关 hideNoteIcon 关闭 → 隐藏范围行 + 独立便签行 置灰
 *  - 总开关开启 → 隐藏范围行可操作；独立便签行始终显示（不受隐藏范围限制）
 */
function updateHideNoteIconState(win: Window) {
  const enabled = !!getPref("hideNoteIcon");
  const modeBox = $(`${ref}-hideNoteIconModeBox`, win);
  const notesBox = $(`${ref}-hideNoteIconNotesBox`, win);
  if (modeBox) {
    modeBox.style.opacity = enabled ? "1" : "0.45";
    modeBox.style.pointerEvents = enabled ? "auto" : "none";
  }
  if (notesBox) {
    notesBox.hidden = !enabled;
  }
  // 同步独立便签图标 menulist 选中项（boolean pref 不依赖自动绑定，显式同步；
  // 用 String() 兼容历史遗留的字符串值）
  const notesMl = $(`zotero-prefpane-${ref}-hideNoteIconNotes`, win) as any;
  if (notesMl) {
    const v = String(getPref("hideNoteIconNotes")) === "true" ? "true" : "false";
    if (notesMl.value !== v) {
      notesMl.value = v;
    }
  }
}

/** Toggle annotation sub-rows based on annotationTranslatePosition,
 *  annotationWordPosition and annotationSeparatorMode.
 *  - position=body: show "翻译保存顺序" row + "分隔方式(body)" row
 *  - position=comment: show "单词保存位置" row
 *    - wordPosition=comment: show "分隔方式(comment)" row
 *  - separatorMode=newline: hide separator input in the relevant row
 *  - separatorMode=separator: show separator input in the relevant row
 *  - Both separator inputs are synced (same pref: annotationSeparator).
 */
function updateAnnotationTranslatePositionState(win: Window) {
  const position = getPref("annotationTranslatePosition") as string;
  const wordPosition = getPref("annotationWordPosition") as string;
  const sepMode = getPref("annotationSeparatorMode") as string;
  const showBody = position === "body";
  const showComment = position === "comment";
  const showWordPosRow = showComment;
  const showCommentSepRow = showComment && wordPosition === "comment";
  const showSeparatorInput = sepMode === "separator";

  // 1. 翻译保存顺序 row (only when position=body)
  const orderMl = $(`zotero-prefpane-${ref}-annotationTranslatePositionInBody`, win) as any;
  const orderHbox = orderMl?.closest?.("hbox") || orderMl?.parentElement;
  if (orderHbox) orderHbox.hidden = !showBody;
  if (orderMl) orderMl.disabled = !showBody;

  // 2. 分隔方式 (body) row (only when position=body)
  const bodySepModeMl = $(`zotero-prefpane-${ref}-annotationSeparatorModeBody`, win) as any;
  const bodySepHbox = bodySepModeMl?.closest?.("hbox") || bodySepModeMl?.parentElement;
  if (bodySepHbox) bodySepHbox.hidden = !showBody;
  if (bodySepModeMl) bodySepModeMl.disabled = !showBody;
  // Toggle body separator input visibility
  const bodySepInput = $(`zotero-prefpane-${ref}-annotationSeparatorBody`, win) as any;
  if (bodySepInput) {
    bodySepInput.hidden = !showSeparatorInput;
    bodySepInput.disabled = !showBody || !showSeparatorInput;
  }

  // 3. 单词保存位置 row (only when position=comment)
  const wordPosMl = $(`zotero-prefpane-${ref}-annotationWordPosition`, win) as any;
  const wordPosHbox = wordPosMl?.closest?.("hbox") || wordPosMl?.parentElement;
  if (wordPosHbox) wordPosHbox.hidden = !showWordPosRow;
  if (wordPosMl) wordPosMl.disabled = !showWordPosRow;

  // 4. 分隔方式 (comment) row (only when position=comment && wordPosition=comment)
  const commentSepModeMl = $(`zotero-prefpane-${ref}-annotationSeparatorModeComment`, win) as any;
  const commentSepHbox = commentSepModeMl?.closest?.("hbox") || commentSepModeMl?.parentElement;
  if (commentSepHbox) commentSepHbox.hidden = !showCommentSepRow;
  if (commentSepModeMl) commentSepModeMl.disabled = !showCommentSepRow;
  // Toggle comment separator input visibility
  const commentSepInput = $(`zotero-prefpane-${ref}-annotationSeparatorComment`, win) as any;
  if (commentSepInput) {
    commentSepInput.hidden = !showSeparatorInput;
    commentSepInput.disabled = !showCommentSepRow || !showSeparatorInput;
  }

  // 5. Sync the two separator mode menulists (they share the same pref, but
  //    we need to keep their displayed value in sync when toggling).
  if (bodySepModeMl && bodySepModeMl.value !== sepMode) bodySepModeMl.value = sepMode;
  if (commentSepModeMl && commentSepModeMl.value !== sepMode) commentSepModeMl.value = sepMode;
}

/** Reflect the currently saved eudicCategoryId in the menulist UI. */
function syncCategorySelectionUI(win: Window) {
  const menulist = $(`zotero-prefpane-${ref}-eudicCategoryId`, win);
  if (!menulist) return;
  // Zotero 笔记平台：下拉值即笔记标题，由 refreshCategories 填充，无需按 ID 同步
  if ((getPref("wordbookPlatform") as string) === "zotero") return;
  const savedId = getPref("eudicCategoryId");
  // Ensure the popup contains an item for the saved id.
  const popup = menulist.menupopup || menulist.querySelector("menupopup");
  if (popup) {
    let exists = false;
    for (const item of Array.from(
      popup.querySelectorAll("menuitem"),
    ) as any[]) {
      if (item.value === savedId) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      const item = (win.document as any).createXULElement("menuitem") as any;
      item.value = savedId;
      item.label = getPref("eudicCategoryName") || savedId;
      popup.appendChild(item);
    }
  }
  try {
    menulist.value = savedId;
  } catch {
    /* ignore */
  }
}

/* ----------------------------- events ----------------------------- */

function bindPrefEvents(win: Window) {
  // triggerMode -> toggle modifier row
  const triggerMode = $(`zotero-prefpane-${ref}-triggerMode`, win);
  triggerMode?.addEventListener("command", () => {
    // value is auto-saved by preference binding; read from pref
    setTimeout(() => updateModifierRowState(win), 0);
  });

  // enableHoverTranslate -> toggle hover config box
  const enableHover = $(`zotero-prefpane-${ref}-enableHoverTranslate`, win);
  enableHover?.addEventListener("command", () => {
    setTimeout(() => updateHoverConfigState(win), 0);
  });

  // enableEudicSync -> toggle config box
  const enableSync = $(`zotero-prefpane-${ref}-enableEudicSync`, win);
  enableSync?.addEventListener("command", () => {
    setTimeout(() => updateEudicBoxState(win), 0);
  });

  // wordbookPlatform -> toggle token boxes + auto-refresh wordbook list
  const platformSel = $(`zotero-prefpane-${ref}-wordbookPlatform`, win);
  platformSel?.addEventListener("command", () => {
    setTimeout(() => {
      updateTokenVisibility(win);
      void refreshCategories(win, true);
    }, 0);
  });

  // syncToLocal -> toggle 存储路径/笔记名称 子区块
  const syncToLocalSel = $(`zotero-prefpane-${ref}-syncToLocal`, win);
  syncToLocalSel?.addEventListener("command", () => {
    setTimeout(() => updateSyncToLocalState(win), 0);
  });

  // enableTerminology -> toggle terminology config box
  const enableTerm = $(`zotero-prefpane-${ref}-enableTerminology`, win);
  enableTerm?.addEventListener("command", () => {
    setTimeout(() => updateTerminologyState(win), 0);
  });

  // terminologyPlatform -> toggle 存储路径/笔记名称 子区块
  const termPlatformSel = $(`zotero-prefpane-${ref}-terminologyPlatform`, win);
  termPlatformSel?.addEventListener("command", () => {
    setTimeout(() => updateTerminologyState(win), 0);
  });

  // terminology local save path choose directory button
  const chooseTermBtn = $(`${ref}-chooseTermDirBtn`, win);
  if (chooseTermBtn) {
    chooseTermBtn.addEventListener("command", async () => {
      try {
        const titleStr =
          (getString("pref-local-chooseDir-label") as string) ||
          "选择存储目录";
        const f = await new FilePickerHelper(titleStr, "folder").open();
        if (f) {
          setPref("terminologyLocalSavePath", f);
          const input = $(`zotero-prefpane-${ref}-terminologyLocalSavePath`, win) as any;
          if (input) input.value = f;
        }
      } catch {
        /* ignore */
      }
    });
  }

  // 打开术语库笔记按钮
  const editTermNoteBtn = $(`${ref}-editTermNoteBtn`, win);
  if (editTermNoteBtn) {
    editTermNoteBtn.addEventListener("command", () => {
      void (async () => {
        try {
          const { openTerminologyNote } = await import("./terminology");
          await openTerminologyNote();
        } catch { /* ignore */ }
      })();
    });
  }

  // 同步至本地（local）：选择存储目录按钮——写 localSavePath（与生词本平台=本地生词表
  // 同 pref），并同步两个存储路径输入框的显示值
  const chooseSyncLocalBtn = $(`${ref}-chooseSyncLocalDirBtn`, win);
  if (chooseSyncLocalBtn) {
    chooseSyncLocalBtn.addEventListener("command", async () => {
      try {
        const titleStr =
          (getString("pref-local-chooseDir-label") as string) ||
          "选择存储目录";
        const f = await new FilePickerHelper(titleStr, "folder").open();
        if (f) {
          setPref("localSavePath", f);
          const a = $(`zotero-prefpane-${ref}-localSavePath`, win) as any;
          if (a) a.value = f;
          const b = $(`zotero-prefpane-${ref}-syncLocalSavePath`, win) as any;
          if (b) b.value = f;
        }
      } catch {
        /* ignore */
      }
    });
  }

  // 同步至本地（zotero）：打开生词本笔记按钮（同步至本地 zotero 写入的是「生词本」笔记）
  const editSyncNoteBtn = $(`${ref}-editSyncNoteBtn`, win);
  if (editSyncNoteBtn) {
    editSyncNoteBtn.addEventListener("command", () => {
      void (async () => {
        try {
          const { openNoteForEditing, getNoteTitle } = await import("./zoteroNote");
          await openNoteForEditing(getNoteTitle());
        } catch { /* ignore */ }
      })();
    });
  }

  // translateEngine -> toggle hint visibility
  const engineSel = $(`zotero-prefpane-${ref}-translateEngine`, win);
  engineSel?.addEventListener("command", () => {
    setTimeout(() => updateTranslateEngineHintVisibility(win), 0);
  });

  // enableAnnotationSync -> toggle annotation config box
  const enableAnnoSync = $(`zotero-prefpane-${ref}-enableAnnotationSync`, win);
  enableAnnoSync?.addEventListener("command", () => {
    setTimeout(() => updateAnnotationBoxState(win), 0);
  });

  // annotationTranslatePosition -> toggle sub-rows
  const annoPos = $(`zotero-prefpane-${ref}-annotationTranslatePosition`, win);
  annoPos?.addEventListener("command", () => {
    setTimeout(() => updateAnnotationTranslatePositionState(win), 0);
  });

  // annotationWordPosition -> toggle "分隔方式(comment)" row
  const wordPos = $(`zotero-prefpane-${ref}-annotationWordPosition`, win);
  wordPos?.addEventListener("command", () => {
    setTimeout(() => updateAnnotationTranslatePositionState(win), 0);
  });

  // hideNoteIcon -> toggle hide-note-icon sub-rows
  const hideNoteIcon = $(`zotero-prefpane-${ref}-hideNoteIcon`, win);
  hideNoteIcon?.addEventListener("command", () => {
    setTimeout(() => updateHideNoteIconState(win), 0);
  });

  // hideNoteIconMode -> toggle 独立便签行
  const hideNoteIconMode = $(`zotero-prefpane-${ref}-hideNoteIconMode`, win);
  hideNoteIconMode?.addEventListener("command", () => {
    setTimeout(() => updateHideNoteIconState(win), 0);
  });

  // hideNoteIconNotes -> 显式写入 boolean pref（menulist 自动绑定会把 boolean
  // 写成字符串，导致 !!getPref() 恒为 true，独立便签开关失效）
  const hideNoteIconNotes = $(`zotero-prefpane-${ref}-hideNoteIconNotes`, win) as any;
  hideNoteIconNotes?.addEventListener("command", () => {
    setPref("hideNoteIconNotes", hideNoteIconNotes.value === "true");
  });

  // annotationSeparatorMode (both menulists) -> toggle separator input visibility
  const sepModeBody = $(`zotero-prefpane-${ref}-annotationSeparatorModeBody`, win);
  sepModeBody?.addEventListener("command", () => {
    // Sync the comment menulist value
    const sepModeComment = $(`zotero-prefpane-${ref}-annotationSeparatorModeComment`, win) as any;
    if (sepModeComment && sepModeComment.value !== (sepModeBody as any).value) {
      sepModeComment.value = (sepModeBody as any).value;
    }
    setTimeout(() => updateAnnotationTranslatePositionState(win), 0);
  });
  const sepModeComment = $(`zotero-prefpane-${ref}-annotationSeparatorModeComment`, win);
  sepModeComment?.addEventListener("command", () => {
    // Sync the body menulist value
    const sepModeBody2 = $(`zotero-prefpane-${ref}-annotationSeparatorModeBody`, win) as any;
    if (sepModeBody2 && sepModeBody2.value !== (sepModeComment as any).value) {
      sepModeBody2.value = (sepModeComment as any).value;
    }
    setTimeout(() => updateAnnotationTranslatePositionState(win), 0);
  });

  // Sync the two separator text inputs (they share the same pref, but we
  // also sync their displayed value when either changes).
  const sepInputBody = $(`zotero-prefpane-${ref}-annotationSeparatorBody`, win) as any;
  const sepInputComment = $(`zotero-prefpane-${ref}-annotationSeparatorComment`, win) as any;
  sepInputBody?.addEventListener("input", () => {
    if (sepInputComment && sepInputComment.value !== sepInputBody.value) {
      sepInputComment.value = sepInputBody.value;
    }
  });
  sepInputComment?.addEventListener("input", () => {
    if (sepInputBody && sepInputBody.value !== sepInputComment.value) {
      sepInputBody.value = sepInputComment.value;
    }
  });

  // export choose directory button
  const chooseBtn = $(`${ref}-chooseExportDirBtn`, win);
  if (chooseBtn) {
    chooseBtn.addEventListener("command", async () => {
      try {
        const titleStr =
          (getString("pref-export-chooseDir-label") as string) ||
          "选择导出目录";
        const f = await new FilePickerHelper(titleStr, "folder").open();
        if (f) {
          setPref("exportSavePath", f);
          const input = $(`zotero-prefpane-${ref}-exportSavePath`, win) as any;
          if (input) input.value = f;
        }
      } catch {
        /* ignore */
      }
    });
  }

  // local save path choose directory button
  const chooseLocalBtn = $(`${ref}-chooseLocalDirBtn`, win);
  if (chooseLocalBtn) {
    chooseLocalBtn.addEventListener("command", async () => {
      try {
        const titleStr =
          (getString("pref-local-chooseDir-label") as string) ||
          "选择存储目录";
        const f = await new FilePickerHelper(titleStr, "folder").open();
        if (f) {
          setPref("localSavePath", f);
          const input = $(`zotero-prefpane-${ref}-localSavePath`, win) as any;
          if (input) input.value = f;
        }
      } catch {
        /* ignore */
      }
    });
  }

  // language change -> refresh category list
  const lang = $(`zotero-prefpane-${ref}-eudicLanguage`, win);
  lang?.addEventListener("command", () => {
    setTimeout(() => refreshCategories(win, /*silent*/ true), 0);
  });

  // category selection -> sync name
  const catList = $(`zotero-prefpane-${ref}-eudicCategoryId`, win);
  catList?.addEventListener("command", () => {
    const v = catList.value;
    const popup = catList.menupopup || catList.querySelector("menupopup");
    let name = v;
    if (popup) {
      for (const item of Array.from(
        popup.querySelectorAll("menuitem"),
      ) as any[]) {
        if (item.value === v) {
          name = item.label;
          break;
        }
      }
    }
    // Zotero 笔记平台：下拉已禁用且固定为「生词本」，不写 zoteroNoteTitle
    if ((getPref("wordbookPlatform") as string) === "zotero") {
      return;
    }
    setPref("eudicCategoryId", String(v));
    setPref("eudicCategoryName", String(name));
  });

  // refresh category button (use command only — click fires twice in XUL)
  const refreshBtn = $(`${ref}-refreshCategoryBtn`, win);
  if (refreshBtn) {
    refreshBtn.addEventListener("command", () => void refreshCategories(win, false));
  }

  // reset button
  $(`${ref}-resetBtn`, win)?.addEventListener("command", () => {
    resetDefaults(win);
  });

  // help link & apply-token link — text-link class doesn't auto-open in Zotero 7+, need explicit handlers
  const helpLink = win.document.querySelector(
    `label[data-l10n-id="${ref}-pref-help-link"]`,
  ) as any;
  if (helpLink) {
    helpLink.style.cursor = "pointer";
    helpLink.addEventListener("click", () => {
      try {
        Zotero.launchURL(
          "https://github.com/SHANGKAIJIE/zotero-hover-translate-eudic#readme",
        );
      } catch {
        win.open(
          "https://github.com/SHANGKAIJIE/zotero-hover-translate-eudic#readme",
          "_blank",
        );
      }
    });
  }

  // apply-token link → Eudic OpenAPI Authorization page (NIS token)
  const applyLink = win.document.querySelector(
    `label[data-l10n-id="${ref}-pref-eudicToken-apply"]`,
  ) as any;
  if (applyLink) {
    applyLink.style.cursor = "pointer";
    applyLink.addEventListener("click", () => {
      try {
        Zotero.launchURL("https://my.eudic.net/OpenAPI/Authorization");
      } catch {
        win.open("https://my.eudic.net/OpenAPI/Authorization", "_blank");
      }
    });
  }

  // apply-token link → Maimemo OpenAPI Access Token page
  const maimemoApplyLink = win.document.querySelector(
    `label[data-l10n-id="${ref}-pref-maimemoToken-apply"]`,
  ) as any;
  if (maimemoApplyLink) {
    maimemoApplyLink.style.cursor = "pointer";
    maimemoApplyLink.addEventListener("click", () => {
      try {
        Zotero.launchURL("https://open.maimemo.com/open/api/v1/tokens/openapi");
      } catch {
        win.open("https://open.maimemo.com/open/api/v1/tokens/openapi", "_blank");
      }
    });
  }

  // apply-token link → HTE Bridge GitHub repo
  const shanbayApplyLink = win.document.querySelector(
    `label[data-l10n-id="${ref}-pref-shanbayToken-apply"]`,
  ) as any;
  if (shanbayApplyLink) {
    shanbayApplyLink.style.cursor = "pointer";
    shanbayApplyLink.addEventListener("click", () => {
      try {
        Zotero.launchURL("https://github.com/SHANGKAIJIE/hte-bridge");
      } catch {
        win.open("https://github.com/SHANGKAIJIE/hte-bridge", "_blank");
      }
    });
  }

  // maimemo HTE-Bridge download link
  const maimemoBridgeLink = win.document.querySelector(
    `label[data-l10n-id="${ref}-pref-maimemoToken-hte-bridge"]`,
  ) as any;
  if (maimemoBridgeLink) {
    maimemoBridgeLink.style.cursor = "pointer";
    maimemoBridgeLink.addEventListener("click", () => {
      try {
        Zotero.launchURL("https://github.com/SHANGKAIJIE/hte-bridge");
      } catch {
        win.open("https://github.com/SHANGKAIJIE/hte-bridge", "_blank");
      }
    });
  }

  // export button

  // edit category button
  const editBtn = $(`${ref}-editCategoryBtn`, win);
  if (editBtn) {
    editBtn.addEventListener("command", () => void handleEditWordbooks(win));
  }
  // Zotero 笔记平台：打开笔记按钮
  const editNoteBtn = $(`${ref}-editNoteBtn`, win);
  if (editNoteBtn) {
    editNoteBtn.addEventListener("command", () => {
      const title = getNoteTitle();
      void openNoteForEditing(title).then((opened) => {
        if (!opened) win.alert("未找到或无法打开笔记，请先添加一个单词以创建笔记");
      });
    });
  }
  // 加词快捷键输入框：聚焦即录（点击后直接按单字母/组合键即可识别）。
  bindShortcutInputCapture(win, `zotero-prefpane-${ref}-addWordShortcut`);
  // export button
  const exportBtn = $(`${ref}-exportBtn`, win);
  if (exportBtn) {
    exportBtn.addEventListener("command", () => void handleExport(win));
  }
}

/* ------------------- add-word shortcut input capture ------------------- */

const SHORTCUT_MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/**
 * 聚焦即录快捷键输入框：点击输入框后直接按下按键（单字母或组合键）即
 * 自动识别并写入；Backspace/Delete 清空（= 留空不启用）；Escape 取消。
 * 中文输入法激活时 Firefox keydown.key 为 "Process"，用 ev.code 回退
 * （KeyA→A / Digit1→1 / Numpad1→1）；死键（Dead）忽略。
 */
function bindShortcutInputCapture(win: Window, inputId: string) {
  const input = $(inputId, win) as any;
  if (!input) return;

  const keyFromEvent = (ev: KeyboardEvent): string => {
    const key = ev.key;
    if (key && key !== "Process" && key !== "Dead") return key;
    const code = ev.code || "";
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
    return "";
  };

  const commit = () => {
    const raw = (input.value || "").toString().trim();
    if (!raw) {
      setPref("addWordShortcut", "");
      return;
    }
    // 规范化：统一大写显示（单字母场景），保留组合键顺序。
    const kb = parseKeybinding(raw);
    if (!kb) {
      input.value = (getPref("addWordShortcut") as string) || "";
      return;
    }
    const parts: string[] = [];
    if (kb.ctrl) parts.push("Ctrl");
    if (kb.alt) parts.push("Alt");
    if (kb.shift) parts.push("Shift");
    if (kb.meta) parts.push("Meta");
    parts.push(kb.key.length === 1 ? kb.key.toUpperCase() : kb.key);
    const normalized = parts.join("+");
    input.value = normalized;
    setPref("addWordShortcut", normalized);
  };

  // 初始化显示当前保存值
  const saved = (getPref("addWordShortcut") as string) || "";
  input.value = saved;

  const onKeyDown = (ev: KeyboardEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const key = keyFromEvent(ev);
    if (!key) return;
    if (key === "Backspace" || key === "Delete") {
      input.value = "";
      setPref("addWordShortcut", "");
      return;
    }
    if (key === "Escape") {
      input.value = (getPref("addWordShortcut") as string) || "";
      input.blur();
      return;
    }
    if (SHORTCUT_MODIFIER_KEYS.has(key)) return; // 等待主键
    const parts: string[] = [];
    if (ev.ctrlKey) parts.push("Ctrl");
    if (ev.altKey) parts.push("Alt");
    if (ev.shiftKey) parts.push("Shift");
    if (ev.metaKey) parts.push("Meta");
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    input.value = parts.join("+");
    commit();
    input.blur();
  };

  input.addEventListener("focus", () => {
    input.classList.add("hte-shortcut-recording");
  });
  input.addEventListener("blur", () => {
    input.classList.remove("hte-shortcut-recording");
    commit();
  });
  input.addEventListener("keydown", onKeyDown, true);
}

/* ----------------------------- export ----------------------------- */

function getExportBaseName(): string {
  const p = getPref("wordbookPlatform") as string;
  if (p === "maimemo") return "maimemo-wordbook";
  if (p === "shanbay") return "shanbay-wordbook";
  if (p === "local") return "local-wordbook";
  if (p === "zotero") return "zotero-note-wordbook";
  return "eudic-wordbook";
}

/** Handle the export button click. Uses the main wordbook category. */
async function handleExport(win: Window) {
  // 导出内容：生词本（默认）或 术语库（按当前术语库平台导出）
  const exportContent = getPref("exportContent") as string;
  if (exportContent === "terminology") {
    await handleExportTerminology(win);
    return;
  }
  const platform = getPref("wordbookPlatform") as string;

  // Local platform: read directly from CSV, no API call needed
  if (platform === "local") {
    const formatEl = $(`${ref}-exportFormat`, win) as any;
    const format: string = formatEl?.value || "csv";
    const autoReveal = getPref("exportAutoReveal") as boolean;
    const savePath = (getPref("exportSavePath") as string || "").trim();

    const extMap: Record<string, string> = {
      csv: "csv", tsv: "tsv", txt: "txt", json: "json",
    };
    const ext = extMap[format] || "csv";

    let outFile: any = null;
    if (savePath) {
      try {
        const nsIFile = (Components as any).interfaces.nsIFile;
        const file = (Components as any).classes["@mozilla.org/file/local;1"]
          .createInstance(nsIFile);
        file.initWithPath(savePath);
        if (file.exists() && !file.isDirectory()) {
          const parent = file.parent;
          if (parent) {
            parent.append(`${getExportBaseName()}.${ext}`);
            outFile = parent;
          }
        } else {
          if (!file.exists()) {
            file.create((Components as any).interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
          }
          file.append(`${getExportBaseName()}.${ext}`);
          outFile = file;
        }
      } catch { /* fall through */ }
    }

    try {
      const words = await getLocalWords();
      if (words.length === 0) {
        win.alert("本地生词本为空，无内容可导出");
        return;
      }
      const msg = await exportWordEntries(words, format as any, {
        outFile: outFile || undefined,
        autoReveal,
        compact: true,
        baseName: getExportBaseName(),
      });
      win.alert(msg);
    } catch (e: any) {
      win.alert(`导出失败：${e?.message || "未知错误"}`);
    }
    return;
  }

  // Zotero 笔记平台：从笔记读取词条导出（复用同一导出管线）
  if (platform === "zotero") {
    const formatEl = $(`${ref}-exportFormat`, win) as any;
    const format: string = formatEl?.value || "csv";
    const autoReveal = getPref("exportAutoReveal") as boolean;
    const savePath = (getPref("exportSavePath") as string || "").trim();

    const extMap: Record<string, string> = {
      csv: "csv", tsv: "tsv", txt: "txt", json: "json",
    };
    const ext = extMap[format] || "csv";

    let outFile: any = null;
    if (savePath) {
      try {
        const nsIFile = (Components as any).interfaces.nsIFile;
        const file = (Components as any).classes["@mozilla.org/file/local;1"]
          .createInstance(nsIFile);
        file.initWithPath(savePath);
        if (file.exists() && !file.isDirectory()) {
          const parent = file.parent;
          if (parent) {
            parent.append(`${getExportBaseName()}.${ext}`);
            outFile = parent;
          }
        } else {
          if (!file.exists()) {
            file.create((Components as any).interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
          }
          file.append(`${getExportBaseName()}.${ext}`);
          outFile = file;
        }
      } catch { /* fall through */ }
    }

    try {
      const title = getNoteTitle();
      const words = await getWordsFromNote(title);
      if (words.length === 0) {
        win.alert("笔记生词本为空，无内容可导出");
        return;
      }
      const msg = await exportWordEntries(words, format as any, {
        outFile: outFile || undefined,
        autoReveal,
        compact: true,
        baseName: getExportBaseName(),
      });
      win.alert(msg);
    } catch (e: any) {
      win.alert(`导出失败：${e?.message || "未知错误"}`);
    }
    return;
  }

  let token: string;
  let categoryId: string;

  if (platform === "maimemo") {
    token = getPref("maimemoToken") as string;
    categoryId = (getPref("maimemoCategoryId") as string) || "";
  } else if (platform === "shanbay") {
    token = getPref("shanbayToken") as string;
    categoryId = "default";
  } else {
    token = getPref("eudicToken") as string;
    categoryId = (getPref("eudicCategoryId") as string) || "0";
  }

  if (!token) {
    win.alert(getString("hint-token-invalid"));
    return;
  }

  if (platform === "maimemo" && !categoryId) {
    win.alert("请先选择要导出的墨墨云词本");
    return;
  }

  const formatEl = $(`${ref}-exportFormat`, win) as any;
  const format: string = formatEl?.value || "csv";
  const autoReveal = getPref("exportAutoReveal") as boolean;
  const savePath = (getPref("exportSavePath") as string || "").trim();

  const extMap: Record<string, string> = {
    csv: "csv", tsv: "tsv", txt: "txt", json: "json",
  };
  const ext = extMap[format] || "csv";

  // Build nsIFile
  let outFile: any = null;
  if (savePath) {
    try {
      const nsIFile = (Components as any).interfaces.nsIFile;
      const file = (Components as any).classes["@mozilla.org/file/local;1"]
        .createInstance(nsIFile);
      file.initWithPath(savePath);
      if (file.exists() && !file.isDirectory()) {
        const parent = file.parent;
        if (parent) {
          parent.append(`${getExportBaseName()}.${ext}`);
          outFile = parent;
        }
      } else {
        if (!file.exists()) {
          file.create((Components as any).interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
        }
        file.append(`${getExportBaseName()}.${ext}`);
        outFile = file;
      }
    } catch {
      /* fall through */
    }
  }

  try {
    let msg: string;
    if (platform === "maimemo") {
      const mClient = new MaimemoClient(token);
      const words = await mClient.getWords(categoryId);
      if (words.length === 0) {
        throw new Error("该云词本中没有任何单词");
      }
      msg = await exportWordEntries(words, format as any, {
        outFile: outFile || undefined,
        autoReveal,
        wordsOnly: true,
        baseName: getExportBaseName(),
      });
    } else if (platform === "shanbay") {
      const sClient = new ShanbayClient(token);
      const words = await sClient.getWords();
      if (words.length === 0) {
        throw new Error("扇贝生词本中没有任何单词");
      }
      msg = await exportWordEntries(words, format as any, {
        outFile: outFile || undefined,
        autoReveal,
        wordsOnly: true,
        note: "扇贝单词 — 仅支持导出单词列表",
        baseName: getExportBaseName(),
      });
    } else {
      const language = getPref("eudicLanguage") as string;
      const client = new EudicClient(token, language);
      msg = await exportWordbook(client, categoryId, format as any, {
        outFile: outFile || undefined,
        autoReveal,
        baseName: getExportBaseName(),
      });
    }
    win.alert(msg);
  } catch (e: any) {
    win.alert(`导出失败：${e?.message || "未知错误"}`);
  }
}

/** 导出术语库（按当前术语库平台 local/zotero 读取数据）。 */
async function handleExportTerminology(win: Window) {
  const formatEl = $(`${ref}-exportFormat`, win) as any;
  const format: string = formatEl?.value || "csv";
  const autoReveal = getPref("exportAutoReveal") as boolean;
  const savePath = (getPref("exportSavePath") as string || "").trim();
  const extMap: Record<string, string> = {
    csv: "csv", tsv: "tsv", txt: "txt", json: "json",
  };
  const ext = extMap[format] || "csv";

  let outFile: any = null;
  if (savePath) {
    try {
      const nsIFile = (Components as any).interfaces.nsIFile;
      const file = (Components as any).classes["@mozilla.org/file/local;1"]
        .createInstance(nsIFile);
      file.initWithPath(savePath);
      if (file.exists() && !file.isDirectory()) {
        const parent = file.parent;
        if (parent) {
          // 术语库导出文件名统一为 terminology-export.<ext>，与本地术语表
          // 存储文件 hover-translate-eudic-terminology.csv 明确区分，避免互相覆盖。
          parent.append(`terminology-export.${ext}`);
          outFile = parent;
        }
      } else {
        if (!file.exists()) {
          file.create((Components as any).interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
        }
        file.append(`terminology-export.${ext}`);
        outFile = file;
      }
    } catch { /* fall through */ }
  }

  try {
    const { getTerminologyTerms } = await import("./terminology");
    const { terms } = await getTerminologyTerms();
    if (terms.length === 0) {
      win.alert("术语库为空，无内容可导出");
      return;
    }
    // 术语库导出：缩写(abbr)与释义(exp)作为独立字段/列导出，
    // 不再拼成「缩写：xxx\n释义：yyy」同一个格。
    const mapped = terms.map((t) => ({
      word: t.term,
      abbr: t.abbr || "",
      exp: t.exp || "",
    }));
    const msg = await exportWordEntries(mapped, format as any, {
      outFile: outFile || undefined,
      autoReveal,
      compact: true,
      terminology: true,
      baseName: "terminology-export",
    });
    win.alert(msg);
  } catch (e: any) {
    win.alert(`导出失败：${e?.message || "未知错误"}`);
  }
}

/* ----------------------- edit wordbooks dialog ----------------------- */

/** Open a dialog to list/add/rename/delete wordbooks. */
async function handleEditWordbooks(win: Window) {
  const platform = getPref("wordbookPlatform") as string;

  if (platform === "maimemo") {
    const token = getPref("maimemoToken") as string;
    if (!token) {
      win.alert(getString("hint-token-invalid"));
      return;
    }
    const client = new MaimemoClient(token);
    const api = {
      getCategories: async () => {
        const cats = await client.getCategories();
        return cats.map(c => ({ id: c.id, name: c.name, language: c.language }));
      },
      createCategory: async (name: string) => { await client.createCategory(name); },
      renameCategory: async (id: string, currentName: string, newName: string) => {
        await client.renameCategory(id, currentName, newName);
      },
      deleteCategory: async (id: string, name: string) => { await client.deleteCategory(id, name); },
    };
    const args = { api, categories: [] };
    const mainWin = Zotero.getMainWindow() as any;
    try {
      mainWin.openDialog(
        "chrome://hovertranslateeudic/content/edit-wordbook-dialog.xhtml",
        "edit-wordbook",
        "centerscreen,resizable,width=520,height=400",
        args,
      );
    } catch {
      win.alert("无法打开编辑窗口，请确认插件已正确安装。");
    }
  } else if (platform === "shanbay") {
    win.alert("扇贝单词仅支持默认生词本，无需编辑。");
  } else if (platform === "zotero") {
    // Zotero 笔记平台：复用编辑词本对话框，这里的"生词本"即笔记
    const api = {
      getCategories: async () => {
        const notes = await listNotes();
        return notes.map((n) => ({ id: n.id, name: n.name, language: "note" }));
      },
      createCategory: async (name: string) => {
        await createNoteWordbook(name);
      },
      renameCategory: async (id: string, currentName: string, newName: string) => {
        await renameNoteWordbook(id, currentName, newName);
      },
      deleteCategory: async (id: string, name: string) => {
        await deleteNoteWordbook(id, name);
      },
    };
    const args = { api, categories: [] };
    const mainWin = Zotero.getMainWindow() as any;
    try {
      mainWin.openDialog(
        "chrome://hovertranslateeudic/content/edit-wordbook-dialog.xhtml",
        "edit-wordbook",
        "centerscreen,resizable,width=520,height=400",
        args,
      );
    } catch {
      win.alert("无法打开编辑窗口，请确认插件已正确安装。");
    }
  } else {
    // Eudic
    const token = getPref("eudicToken") as string;
    if (!token) {
      win.alert(getString("hint-token-invalid"));
      return;
    }
    const language = getPref("eudicLanguage") as string;
    const client = new EudicClient(token, language);
    let categories: { id: string; name: string; language: string }[];
    try {
      categories = addon.data.eudic?.categories?.length
        ? addon.data.eudic.categories
        : await client.getCategories();
    } catch (e: any) {
      const msg = `获取生词本失败：${(e as any)?.message || "网络错误"}`;
      win.alert(msg);
      return;
    }
    const api = {
      getCategories: async () => {
        const cats = await client.getCategories();
        return cats.map(c => ({ id: c.id, name: c.name, language: c.language }));
      },
      createCategory: async (name: string) => { await client.createCategory(name); },
      renameCategory: async (id: string, currentName: string, newName: string) => {
        await client.renameCategory(id, currentName, newName);
      },
      deleteCategory: async (id: string, name: string) => { await client.deleteCategory(id, name); },
    };
    const args = { api, categories };
    const mainWin = Zotero.getMainWindow() as any;
    try {
      mainWin.openDialog(
        "chrome://hovertranslateeudic/content/edit-wordbook-dialog.xhtml",
        "edit-wordbook",
        "centerscreen,resizable,width=520,height=400",
        args,
      );
    } catch {
      win.alert("无法打开编辑窗口，请确认插件已正确安装。");
    }
  }

  // After the dialog closes, refresh the category list in the preferences.
  const checkClosed = () => {
    const existing = (Zotero.getMainWindow() as any).document?.getElementById?.("hovertranslateeudic-editWordbookDialog");
    if (!existing) {
      void refreshCategories(win, true);
    } else {
      win.setTimeout(checkClosed, 500);
    }
  };
  win.setTimeout(checkClosed, 500);
}

/* ----------------------------- category refresh ----------------------------- */

let refreshInProgress = false;

async function refreshCategories(win: Window, silent: boolean) {
  if (refreshInProgress) {
    try { Zotero.debug("[hover-translate-eudic/prefs] refreshCategories already in progress, skipping"); } catch { /* ignore */ }
    return;
  }
  refreshInProgress = true;
  const pdbg = (m: string) => {
    try { Zotero.debug(`[hover-translate-eudic/prefs] ${m}`); } catch { /* ignore */ }
  };
  pdbg("refreshCategories start");

  const platform = getPref("wordbookPlatform") as string;

  // Zotero 笔记平台：笔记名称固定为「生词本」，下拉禁用，无需远程列表
  if (platform === "zotero") {
    try {
      const menulist = $(`zotero-prefpane-${ref}-eudicCategoryId`, win);
      if (menulist) {
        const popup: any =
          menulist.menupopup || menulist.querySelector("menupopup");
        if (popup) {
          while (popup.firstChild) popup.removeChild(popup.firstChild);
          const item = (win.document as any).createXULElement("menuitem") as any;
          item.setAttribute("value", "生词本");
          item.setAttribute("label", "生词本");
          popup.appendChild(item);
        }
        try {
          menulist.value = "生词本";
          menulist.label = "生词本";
        } catch { /* ignore */ }
      }
    } catch (e: any) {
      pdbg(`zotero titles refresh error: ${e?.message || e}`);
    }
    refreshInProgress = false;
    return;
  }

  let token: string;
  let client: EudicClient | MaimemoClient | ShanbayClient;

  if (platform === "maimemo") {
    token = getPref("maimemoToken") as string;
    if (!token) {
      pdbg("no maimemo token");
      if (!silent) win.alert(getString("hint-token-invalid"));
      refreshInProgress = false;
      return;
    }
    client = new MaimemoClient(token);
  } else if (platform === "shanbay") {
    token = getPref("shanbayToken") as string;
    if (!token) {
      pdbg("no shanbay token");
      if (!silent) win.alert(getString("hint-token-invalid"));
      refreshInProgress = false;
      return;
    }
    client = new ShanbayClient(token);
  } else {
    token = getPref("eudicToken") as string;
    if (!token) {
      pdbg("no eudic token");
      if (!silent) win.alert(getString("hint-token-invalid"));
      refreshInProgress = false;
      return;
    }
    const language = getPref("eudicLanguage") as string;
    client = new EudicClient(token, language);
  }

  const menulist = $(`zotero-prefpane-${ref}-eudicCategoryId`, win);
  let popup: any =
    menulist?.menupopup || menulist?.querySelector("menupopup");
  if (!popup && menulist) {
    popup = (win.document as any).createXULElement("menupopup");
    menulist.appendChild(popup);
  }
  if (!menulist || !popup) {
    pdbg("menulist/popup not found");
    refreshInProgress = false;
    return;
  }

  while (popup.firstChild) popup.removeChild(popup.firstChild);

  let categories: { id: string; name: string; language: string }[] = [];
  try {
    if (platform === "shanbay") {
      categories = [{ id: "default", name: "默认生词本", language: "en" }];
    } else {
      categories = await client.getCategories();
    }
    if (platform === "eudic") {
      addon.data.eudic.categories = categories;
      addon.data.eudic.client = client as EudicClient;
    }
    pdbg(`got ${categories.length} categories`);
  } catch (e: any) {
    pdbg(`getCategories failed: status=${e?.status} msg=${e?.message}`);
    const def = (win.document as any).createXULElement("menuitem") as any;
    def.setAttribute("value", "0");
    def.setAttribute("label", "默认生词本");
    popup.appendChild(def);
    try { menulist.selectedIndex = 0; menulist.value = "0"; } catch { /* ignore */ }
    setPref("eudicCategoryId", "0");
    setPref("eudicCategoryName", "默认生词本");
    if (!silent) {
      const status = e?.status;
      const msg =
        status === 401
          ? getString("hint-token-invalid")
          : status === 0
            ? `网络错误：${e?.message || "无法连接服务"}`
            : `刷新失败：${e?.message || `HTTP ${status}`}`;
      win.alert(msg);
    }
    refreshInProgress = false;
    return;
  }

  const items: any[] = [];
  if (categories.length === 0) {
    const def = (win.document as any).createXULElement("menuitem") as any;
    def.setAttribute("value", "0");
    def.setAttribute("label", "默认生词本");
    popup.appendChild(def);
    items.push(def);
  } else {
    for (const c of categories) {
      const item = (win.document as any).createXULElement("menuitem") as any;
      item.setAttribute("value", c.id);
      item.setAttribute("label", c.name || c.id);
      popup.appendChild(item);
      items.push(item);
    }
  }

  const savedId = getPref(
    platform === "maimemo" ? "maimemoCategoryId"
      : platform === "shanbay" ? "shanbayCategoryId"
      : "eudicCategoryId",
  );
  let targetIdx = items.findIndex((it) => it.getAttribute("value") === savedId);
  if (targetIdx < 0) targetIdx = 0;
  const targetItem = items[targetIdx];
  const targetId = targetItem.getAttribute("value");
  const targetLabel = targetItem.getAttribute("label") || targetId;
  try {
    menulist.selectedIndex = targetIdx;
    menulist.value = targetId;
    menulist.label = targetLabel;
  } catch { /* ignore */ }
  if (platform === "maimemo") {
    setPref("maimemoCategoryId", String(targetId));
    setPref("maimemoCategoryName", String(targetLabel));
  } else if (platform === "shanbay") {
    setPref("shanbayCategoryId", String(targetId));
    setPref("shanbayCategoryName", String(targetLabel));
  } else {
    setPref("eudicCategoryId", String(targetId));
    setPref("eudicCategoryName", String(targetLabel));
  }
  pdbg(`selected idx=${targetIdx} id=${targetId} label=${targetLabel}`);
  refreshInProgress = false;
}

/* ----------------------------- export helpers ----------------------------- */

/** Fill the export category menulist. Default selection follows main category. */
/* ----------------------------- reset ----------------------------- */

function resetDefaults(win: Window) {
  for (const key of Object.keys(DEFAULTS)) {
    clearPref(key as any);
    setPref(key as any, DEFAULTS[key]);
  }
  // Re-init clients.
  addon.data.eudic.client = createEudicClientFromPrefs();
  // Refresh UI from the reset prefs.
  updateModifierRowState(win);
  updateHoverConfigState(win);
  updateEudicBoxState(win);
  updateTokenVisibility(win);
  updateAnnotationBoxState(win);
  updateAnnotationTranslatePositionState(win);
  updateHideNoteIconState(win);
  // Re-sync color picker + hex/alpha inputs from the reset pref.
  initColorPicker(win);
  initAnnotationColorPicker(win);
  // Reload the panel so bound controls re-read prefs.
  try {
    // Force menulists/checkboxes to refresh from prefs.
    win.document.querySelectorAll("[preference]").forEach((el: any) => {
      const prefKey = el.getAttribute("preference");
      if (prefKey && DEFAULTS[prefKey] !== undefined) {
        if (typeof el.checked !== "undefined") {
          el.checked = !!DEFAULTS[prefKey];
        } else if (el.value !== undefined) {
          el.value = DEFAULTS[prefKey];
        }
      }
    });
  } catch {
    /* ignore */
  }
  win.alert(getString("hint-reset-done"));
}
