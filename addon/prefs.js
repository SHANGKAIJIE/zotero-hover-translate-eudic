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
pref("highlightColor", "rgba(255,233,79,1.0)");
pref("hoverDelay", 900);
pref("disableOnSelection", true); // 划词时禁用悬停弹窗（避免与划词翻译弹窗冲突）
pref("popupAutoCloseDelay", 30); // 秒
pref("translateDisplayMode", "simple"); // simple | full
pref("translateEngine", "dict");          // "dict" | "translate"

// ---- 3.2 生词本设置 ----
pref("wordbookPlatform", "eudic"); // "eudic" | "maimemo" | "local" | "shanbay"
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
// Shanbay
pref("shanbayToken", "");
pref("shanbayCategoryId", "default");
pref("shanbayCategoryName", "默认生词本");
pref("eudicLanguage", "en"); // en | fr | de | es
pref("buttonShowScene", "both"); // both | hover | selection
pref("wordButtonPosition", "right"); // left | right
pref("addWordMode", "manual"); // manual | auto
pref("lemmaMode", "lemma"); // lemma | inflected

// ---- 3.3 注释设置 ----
pref("enableAnnotationSync", false);              // 加入生词本时同步添加到注释（总开关）
pref("enableAnnotationTranslate", false);         // 自动翻译注释
pref("annotationTranslatePosition", "comment");   // comment | body（翻译保存位置：评论/正文）
pref("annotationTranslatePositionInBody", "before"); // before | after（翻译保存顺序：仅 body 时生效）
pref("annotationSeparatorMode", "newline");       // newline | separator（分隔方式）
pref("annotationSeparator", "\n\n");              // 分隔符（原文与翻译之间，仅 separator 模式生效）
pref("annotationWordPosition", "none");           // none | comment（单词保存位置：仅 comment 时生效）
pref("annotationMarkType", "highlight");          // highlight | underline（标注方式）
pref("annotationColor", "#ffd400");               // 标注颜色（hex 格式）
pref("enableAnnotationAutoTag", false);           // 翻译后自动为注释添加标签
pref("annotationTagName", "单词");                // 标签名称
pref("hideNoteIcon", false);                      // 隐藏便签图标（总开关）
pref("hideNoteIconMode", "word");                 // word | all（隐藏范围：仅隐藏单词文本 / 仅隐藏全部文本）
pref("hideNoteIconNotes", false);                 // 独立便签图标：是否隐藏（不受隐藏范围限制）
pref("annotationTrackedIDs", "{}");               // 本插件创建注释的 ID 跟踪列表：JSON {"附件itemID": ["KEY", ...]}

// ---- 3.4 导出生词本 ----
pref("exportAutoReveal", true);
pref("exportSavePath", "");
