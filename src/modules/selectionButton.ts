/**
 * Selection-button module.
 *
 * Registers a `renderTextSelectionPopup` listener — but ONLY when the user
 * has enabled Eudic sync. When disabled (the default), this module is
 * completely inert and does NOT touch the reader event chain, so it cannot
 * interfere with Translate for Zotero or other plugins' popups.
 *
 * When enabled, it appends a "+生词本" button to the native selection popup,
 * but ONLY when the selected text is a single pure English word.
 */
import { config } from "../../package.json";
import { getPref, registerPrefObserver } from "../utils/prefs";
import { getString } from "../utils/locale";
import { isSingleEnglishWord } from "./util";
import { toLemma } from "./lemmatize";
import { createEudicClientFromPrefs } from "./eudic";
import { createMaimemoClientFromPrefs } from "./maimemo";

let registered = false;
let listener: ((event: any) => void) | null = null;
let prefObserverSymbol: symbol | null = null;

export function registerSelectionButton() {
  // Watch the enableEudicSync pref and register/unregister accordingly.
  prefObserverSymbol = registerPrefObserver("enableEudicSync", () => {
    syncRegistration();
  });
  syncRegistration();
}

export function unregisterSelectionButton() {
  doUnregister();
}

function syncRegistration() {
  const platform = getPref("wordbookPlatform") as string;
  const hasToken = platform === "maimemo"
    ? !!getPref("maimemoToken")
    : !!getPref("eudicToken");
  const shouldEnable =
    getPref("enableEudicSync") && hasToken;
  if (shouldEnable && !registered) {
    doRegister();
  } else if (!shouldEnable && registered) {
    doUnregister();
  }
}

function doRegister() {
  if (registered) return;
  const R: any = (Zotero as any).Reader;
  if (!R || typeof R.registerEventListener !== "function") return;

  listener = (event: any) => {
    try {
      onRenderTextSelectionPopup(event);
    } catch (e) {
      // Never let an error here break the event chain for other plugins.
      ztoolkit.log("selectionButton: error (suppressed)", e);
    }
  };

  try {
    R.registerEventListener(
      "renderTextSelectionPopup",
      listener,
      config.addonID,
    );
    registered = true;
  } catch (e) {
    ztoolkit.log("selectionButton: register failed", e);
  }
}

function doUnregister() {
  if (!registered || !listener) return;
  const R: any = (Zotero as any).Reader;
  if (R && typeof R.unregisterEventListener === "function") {
    try {
      R.unregisterEventListener("renderTextSelectionPopup", listener);
    } catch {
      /* ignore */
    }
  }
  registered = false;
  listener = null;
}

function onRenderTextSelectionPopup(event: any) {
  const { doc, append } = event;
  const selectedText: string = (event?.params?.annotation?.text || "").trim();

  if (!getPref("enableEudicSync")) return;
  const scenePref = getPref("buttonShowScene");
  if (scenePref !== "both" && scenePref !== "selection") return;
  if (!isSingleEnglishWord(selectedText)) return;
  const platform = getPref("wordbookPlatform") as string;
  const hasToken = platform === "maimemo"
    ? !!getPref("maimemoToken")
    : !!getPref("eudicToken");
  if (!hasToken) return;

  // Build a full-width button styled like llm-for-zotero's "Add Text" button.
  const btn = doc.createElement("button");
  btn.textContent = getString("wordbtn-add");
  btn.style.cssText = [
    "display:block",
    "width:100%",
    "margin:0",
    "padding:6px 8px",
    "box-sizing:border-box",
    "border:1px solid rgba(130,130,130,0.38)",
    "border-radius:6px",
    "background:rgba(255,255,255,0.04)",
    "color:inherit",
    "font-size:12px",
    "line-height:1.25",
    "text-align:center",
    "cursor:pointer",
  ].join(";");

  btn.addEventListener("click", async () => {
    btn.textContent = getString("wordbtn-adding");
    btn.setAttribute("disabled", "true");
    const ok = await addWordToEudic(selectedText);
    btn.textContent = ok
      ? getString("wordbtn-added")
      : getString("wordbtn-failed");
    setTimeout(() => {
      btn.textContent = getString("wordbtn-add");
      btn.removeAttribute("disabled");
    }, 1000);
  });

  append(btn);

  // Place the button right after Translate for Zotero's translation textarea
  // (class "zoteropdftranslate-popup-textarea"). The textarea may be created
  // by Translate's listener after ours runs, so retry on the next tick.
  const placeAfterTextarea = () => {
    try {
      const ta = doc.querySelector(
        ".zoteropdftranslate-popup-textarea, .selection-popup textarea",
      ) as HTMLElement | null;
      if (ta && ta.parentNode && ta.parentNode !== btn.parentNode) {
        ta.parentNode.insertBefore(btn, ta.nextSibling);
        return true;
      }
      if (ta && ta.parentNode) {
        ta.parentNode.insertBefore(btn, ta.nextSibling);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  };
  if (!placeAfterTextarea()) {
    setTimeout(placeAfterTextarea, 0);
    setTimeout(placeAfterTextarea, 50);
  }

  // Auto-add mode: add immediately after the popup is shown.
  if (getPref("addWordMode") === "auto") {
    void addWordToEudic(selectedText);
  }
}

async function addWordToEudic(word: string): Promise<boolean> {
  // Lemmatise inflected forms to dictionary headwords before API call.
  const lemma = toLemma(word);
  if (lemma !== word) {
    try {
      Zotero.debug(
        `[hover-translate-eudic] lemmatise: "${word}" → "${lemma}"`
      );
    } catch { /* ignore */ }
  }
  const platform = getPref("wordbookPlatform") as string;
  if (platform === "maimemo") {
    const client = createMaimemoClientFromPrefs();
    if (!client) return false;
    const categoryId = getPref("maimemoCategoryId") as string;
    const res = await client.addWord(lemma, categoryId);
    return res.success;
  }
  const client = createEudicClientFromPrefs();
  if (!client) return false;
  const categoryId = getPref("eudicCategoryId");
  const res = await client.addWord(lemma, categoryId);
  return res.success;
}
