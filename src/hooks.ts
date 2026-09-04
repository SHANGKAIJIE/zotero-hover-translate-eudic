import { config } from "../package.json";
import { initLocale, getString } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import {
  initHoverTranslate,
  onTabNotify,
  cleanupAll as hoverCleanupAll,
} from "./modules/hoverTranslate";
import {
  registerSelectionButton,
  unregisterSelectionButton,
} from "./modules/selectionButton";
import { registerServer, unregisterServer } from "./modules/server";
import {
  initHideNoteIcon,
  cleanupHideNoteIcon,
} from "./modules/hideNoteIcon";
import {
  registerWordbookPanel,
  unregisterWordbookPanel,
} from "./modules/wordbookPanel";
import { attachNoteEditorLinks, retryFailedWords, retryOfflineAnnotations } from "./modules/zoteroNote";
import { retryFailedLocalWords } from "./modules/localWordbook";
import { getPref, registerPrefObserver } from "./utils/prefs";

let notifierID: string | null = null;
let noteLinkTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let panelPrefObserver: symbol | null = null;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // Register HTTP server endpoints for HTE Bridge communication
  try {
    await registerServer();
  } catch (e) {
    ztoolkit.log("hooks: registerServer failed", e);
  }

  // Each subsystem is isolated so a failure in one cannot break the others
  // (or other plugins' reader event handling).
  try {
    registerPrefs();
  } catch (e) {
    ztoolkit.log("hooks: registerPrefs failed", e);
  }
  try {
    registerNotifier();
  } catch (e) {
    ztoolkit.log("hooks: registerNotifier failed", e);
  }
  try {
    registerSelectionButton();
  } catch (e) {
    ztoolkit.log("hooks: registerSelectionButton failed", e);
  }
  try {
    initHoverTranslate();
  } catch (e) {
    ztoolkit.log("hooks: initHoverTranslate failed", e);
  }
  try {
    initHideNoteIcon();
  } catch (e) {
    ztoolkit.log("hooks: initHideNoteIcon failed", e);
  }

  // 生词本面板（PDF 右侧 Item Pane）：受 enableWordbookPanel pref 控制，
  // 开启时注册，关闭时注销；监听 pref 变化动态切换。
  try {
    if (getPref("enableWordbookPanel")) {
      registerWordbookPanel();
    }
    panelPrefObserver = registerPrefObserver("enableWordbookPanel", (value) => {
      if (value) {
        registerWordbookPanel();
      } else {
        unregisterWordbookPanel();
      }
    });
  } catch (e) {
    ztoolkit.log("hooks: registerWordbookPanel failed", e);
  }

  // 笔记编辑器 ↗ 链接跳转：轮询挂载 click 监听（笔记编辑器可能随时打开）
  try {
    attachNoteEditorLinks();
    noteLinkTimer = setInterval(attachNoteEditorLinks, 1500);
  } catch (e) {
    ztoolkit.log("hooks: attachNoteEditorLinks failed", e);
  }

  // 重启后自动重试翻译失败的单词（仅 Zotero 笔记平台；最多 3 次尝试）
  // 延迟等待 PDFTranslate 插件就绪后执行；若未就绪则稍后重试
  try {
    const runRetry = (attempt = 0) => {
      const pdfReady = !!(Zotero as any).PDFTranslate?.api?.translate;
      try {
        Zotero.debug(
          `[hover-translate-eudic] retry attempt=${attempt} pdfReady=${pdfReady} (PDFTranslate.api.translate=${typeof (Zotero as any).PDFTranslate?.api?.translate})`,
        );
      } catch { /* ignore */ }
      if (!pdfReady && attempt < 10) {
        retryTimer = setTimeout(() => runRetry(attempt + 1), 3000);
        return;
      }
      if (!pdfReady) {
        try {
          Zotero.debug("[hover-translate-eudic] retry aborted: PDFTranslate not ready after 10 attempts");
        } catch { /* ignore */ }
        return;
      }
      // 笔记重试：扫描生词本笔记中 failed/pending 词条
      void retryFailedWords().then((count) => {
        try {
          Zotero.debug(`[hover-translate-eudic] retryFinished count=${count}`);
        } catch { /* ignore */ }
      });
      // 注释独立补全：扫描所有含离线提示标记的注释（与笔记状态解耦，
      // 即使笔记中该词已完成或生词本不在 Zotero 平台也能补全）
      void retryOfflineAnnotations().then((count) => {
        try {
          Zotero.debug(`[hover-translate-eudic] annotationRetryFinished count=${count}`);
        } catch { /* ignore */ }
      });
      // 本地生词表补全：重试 exp 为空且 tries<3 的行（与笔记/注释解耦）
      void retryFailedLocalWords().then((count) => {
        try {
          Zotero.debug(`[hover-translate-eudic] localRetryFinished count=${count}`);
        } catch { /* ignore */ }
      });
    };
    retryTimer = setTimeout(() => runRetry(), 3000);
  } catch (e) {
    ztoolkit.log("hooks: retryFailedWords failed", e);
  }

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  // @ts-ignore moz feature
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Load stylesheet into the main window.
  try {
    const doc = win.document;
    const link = ztoolkit.UI.createElement(doc, "link", {
      properties: {
        type: "text/css",
        rel: "stylesheet",
        href: `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`,
      },
    });
    doc.documentElement?.appendChild(link);
  } catch (e) {
    ztoolkit.log("stylesheet load failed", e);
  }

  // Quiet startup notice (dev only)
  if (__env__ === "development") {
    new ztoolkit.ProgressWindow(addon.data.config.addonName, {
      closeOnClick: true,
      closeTime: 3000,
    })
      .createLine({
        text: getString("startup-finish"),
        type: "default",
        progress: 100,
      })
      .show();
  }

  // 背单词提醒：根据 reciteRemind 决定是否自动弹出背诵弹窗
  void import("./modules/reciteDialog").then((m) => m.maybeAutoOpenRecite());
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  if (noteLinkTimer) {
    try {
      clearInterval(noteLinkTimer);
    } catch {
      /* ignore */
    }
    noteLinkTimer = null;
  }
  if (retryTimer) {
    try {
      clearTimeout(retryTimer);
    } catch {
      /* ignore */
    }
    retryTimer = null;
  }
  hoverCleanupAll();
  cleanupHideNoteIcon();
  unregisterSelectionButton();
  unregisterServer();
  try {
    unregisterWordbookPanel();
  } catch { /* ignore */ }
  if (panelPrefObserver) {
    try {
      Zotero.Prefs.unregisterObserver(panelPrefObserver);
    } catch { /* ignore */ }
    panelPrefObserver = null;
  }
  if (notifierID) {
    try {
      Zotero.Notifier.unregisterObserver(notifierID);
    } catch {
      /* ignore */
    }
    notifierID = null;
  }
  // Remove addon object
  addon.data.alive = false;
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

/* ----------------------------- helpers ----------------------------- */

function registerPrefs() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title") || addon.data.config.addonName,
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

function registerNotifier() {
  const callback = {
    notify: async (
      event: string,
      type: string,
      ids: Array<string | number>,
      extraData: { [key: string]: any },
    ) => {
      if (!addon?.data.alive) {
        if (notifierID) {
          Zotero.Notifier.unregisterObserver(notifierID);
          notifierID = null;
        }
        return;
      }
      addon.hooks.onNotify(event, type, ids, extraData);
    },
  };
  notifierID = Zotero.Notifier.registerObserver(callback, ["tab"]);
}

/* ----------------------------- dispatchers ----------------------------- */

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  onTabNotify(event, type, ids, extraData);
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
