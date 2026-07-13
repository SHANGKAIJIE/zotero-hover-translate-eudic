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

let notifierID: string | null = null;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

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
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  hoverCleanupAll();
  unregisterSelectionButton();
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
