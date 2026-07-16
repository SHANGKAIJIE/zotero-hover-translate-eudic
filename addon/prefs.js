/* eslint-disable no-undef */
// Default preferences. Keys are relative to prefsPrefix
// (extensions.zotero.hovertranslateeudic).

// ---- 3.1 基础功能设置 ----
pref("enableHoverTranslate", true);
pref("triggerMode", "hover"); // "hover" | "modifier" | "click"
pref("modifierCtrl", false);
pref("modifierAlt", false);
pref("modifierShift", false);
pref("enableHighlight", false);
pref("highlightColor", "rgba(255,213,79,0.45)");
pref("hoverDelay", 900);
pref("disableOnSelection", true);
pref("popupAutoCloseDelay", 30); // 秒
pref("translateDisplayMode", "simple"); // simple | full

// ---- 3.2 生词本设置 ----
pref("wordbookPlatform", "eudic"); // "eudic" | "maimemo" | "local"
// Local
pref("localSavePath", "");
pref("enableEudicSync", false);
// Eudic
pref("eudicToken", "");
pref("eudicCategoryId", "0");
pref("eudicCategoryName", "默认生词本");
// Maimemo
pref("maimemoToken", "");
pref("maimemoCategoryId", "");
pref("maimemoCategoryName", "");
pref("eudicLanguage", "en"); // en | fr | de | es
pref("buttonShowScene", "both"); // both | hover | selection
pref("addWordMode", "manual"); // manual | auto
pref("lemmaMode", "lemma"); // lemma | inflected

// ---- 3.3 导出生词本 ----
pref("exportAutoReveal", true);
pref("exportSavePath", "");
