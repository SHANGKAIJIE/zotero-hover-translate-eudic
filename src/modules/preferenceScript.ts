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
import { exportWordbook, exportWordEntries } from "./eudicExport";

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
  highlightColor: "rgba(255,213,79,0.45)",
  hoverDelay: 900,
  disableOnSelection: true,
  popupAutoCloseDelay: 30,
  translateDisplayMode: "simple",
  enableEudicSync: false,
  wordbookPlatform: "eudic",
  eudicToken: "",
  eudicCategoryId: "0",
  eudicCategoryName: "默认生词本",
  maimemoToken: "",
  maimemoCategoryId: "",
  maimemoCategoryName: "",
  eudicLanguage: "en",
  buttonShowScene: "both",
  addWordMode: "manual",
  lemmaMode: "lemma",
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
  bindPrefEvents(win);
  // Auto-fetch categories on panel open if token is configured for the active platform.
  const platform = getPref("wordbookPlatform") as string;
  const token = platform === "maimemo"
    ? getPref("maimemoToken") as string
    : getPref("eudicToken") as string;
  const autoFetch = getPref("enableEudicSync") && !!token;
  if (autoFetch) {
    win.setTimeout(() => void refreshCategories(win, true), 200);
  }
  // Defer: let Zotero's preference binding + Fluent localization settle,
  // then force menulist labels to refresh from current pref values.
  win.setTimeout(() => {
    updateModifierRowState(win);
    updateTokenVisibility(win);
    syncAllMenulists(win);
  }, 100);
  win.setTimeout(() => syncAllMenulists(win), 500);
}

/** Init the color picker + R/G/B/A inputs from the saved rgba highlight color. */
function initColorPicker(win: Window) {
  const picker = $(`zotero-prefpane-${ref}-highlightColorPicker`, win) as any;
  const hidden = $(`zotero-prefpane-${ref}-highlightColor`, win) as any;
  const rInput = $(`zotero-prefpane-${ref}-highlightColorR`, win) as any;
  const gInput = $(`zotero-prefpane-${ref}-highlightColorG`, win) as any;
  const bInput = $(`zotero-prefpane-${ref}-highlightColorB`, win) as any;
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
      if (rInput) rInput.value = r;
      if (gInput) gInput.value = g;
      if (bInput) bInput.value = b;
      if (aInput) aInput.value = a;
    }
  };
  syncFromPref();

  // Write the current R/G/B/A values back to the pref + color picker.
  const syncToPref = () => {
    const r = Math.max(0, Math.min(255, parseInt(rInput?.value) || 0));
    const g = Math.max(0, Math.min(255, parseInt(gInput?.value) || 0));
    const b = Math.max(0, Math.min(255, parseInt(bInput?.value) || 0));
    const aPct = Math.max(0, Math.min(100, parseInt(aInput?.value) || 0));
    const a = (aPct / 100).toFixed(2);
    const rgba = `rgba(${r},${g},${b},${a})`;
    hidden.value = rgba;
    setPref("highlightColor", rgba);
    const hex =
      "#" +
      [r, g, b]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
    picker.value = hex;
  };

  // Color picker → R/G/B inputs + pref.
  picker.addEventListener("input", () => {
    const hex = picker.value || "#ffd54f";
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (rInput) rInput.value = r;
    if (gInput) gInput.value = g;
    if (bInput) bInput.value = b;
    syncToPref();
  });

  // R/G/B/A inputs → pref + color picker.
  [rInput, gInput, bInput, aInput].forEach((el) => {
    if (el) {
      el.addEventListener("input", syncToPref);
      el.addEventListener("change", syncToPref);
    }
  });
}

/** Force every bound menulist to reflect its current pref value's label. */
function syncAllMenulists(win: Window) {
  win.document.querySelectorAll("menulist[preference]").forEach((ml: any) => {
    const key = ml.getAttribute("preference");
    if (!key) return;
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

/** Show/hide Eudic vs Maimemo token boxes based on selected platform. */
function updateTokenVisibility(win: Window) {
  const platform = getPref("wordbookPlatform") as string;
  const eudicBox = $(`${ref}-eudicTokenBox`, win);
  const maimemoBox = $(`${ref}-maimemoTokenBox`, win);
  if (eudicBox) eudicBox.hidden = platform !== "eudic";
  if (maimemoBox) maimemoBox.hidden = platform !== "maimemo";
  const hint = $(`${ref}-maimemoExportHint`, win);
  if (hint) hint.hidden = platform !== "maimemo";
  const lemmaModeBox = $(`${ref}-lemmaModeBox`, win);
  if (lemmaModeBox) lemmaModeBox.hidden = platform !== "eudic";
}

/** Reflect the currently saved eudicCategoryId in the menulist UI. */
function syncCategorySelectionUI(win: Window) {
  const menulist = $(`zotero-prefpane-${ref}-eudicCategoryId`, win);
  if (!menulist) return;
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

  // export button

  // edit category button
  const editBtn = $(`${ref}-editCategoryBtn`, win);
  if (editBtn) {
    editBtn.addEventListener("command", () => void handleEditWordbooks(win));
  }
  // export button
  const exportBtn = $(`${ref}-exportBtn`, win);
  if (exportBtn) {
    exportBtn.addEventListener("command", () => void handleExport(win));
  }
}

/* ----------------------------- export ----------------------------- */

const EXPORT_NAME = "eudic-wordbook";

/** Handle the export button click. Uses the main wordbook category. */
async function handleExport(win: Window) {
  const platform = getPref("wordbookPlatform") as string;

  let token: string;
  let categoryId: string;

  if (platform === "maimemo") {
    token = getPref("maimemoToken") as string;
    categoryId = (getPref("maimemoCategoryId") as string) || "";
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
          parent.append(`${EXPORT_NAME}.${ext}`);
          outFile = parent;
        }
      } else {
        if (!file.exists()) {
          file.create((Components as any).interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
        }
        file.append(`${EXPORT_NAME}.${ext}`);
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
      });
    } else {
      const language = getPref("eudicLanguage") as string;
      const client = new EudicClient(token, language);
      msg = await exportWordbook(client, categoryId, format as any, {
        outFile: outFile || undefined,
        autoReveal,
      });
    }
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
  let token: string;
  let client: EudicClient | MaimemoClient;

  if (platform === "maimemo") {
    token = getPref("maimemoToken") as string;
    if (!token) {
      pdbg("no maimemo token");
      if (!silent) win.alert(getString("hint-token-invalid"));
      refreshInProgress = false;
      return;
    }
    client = new MaimemoClient(token);
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
    categories = await client.getCategories();
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
    platform === "maimemo" ? "maimemoCategoryId" : "eudicCategoryId",
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
  // Re-sync color picker + R/G/B/A inputs from the reset pref.
  initColorPicker(win);
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
