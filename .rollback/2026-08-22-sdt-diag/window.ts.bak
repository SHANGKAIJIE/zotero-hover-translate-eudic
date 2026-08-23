import { config } from "../../package.json";

/**
 * Get all currently open reader instances.
 * Defensive: tries several Zotero reader access paths across versions.
 */
export function getAllReaders(): _ZoteroTypes.ReaderInstance[] {
  const R: any = (Zotero as any).Reader;
  if (!R) return [];
  if (typeof R.getReaders === "function") {
    try {
      return R.getReaders() || [];
    } catch {
      /* fall through */
    }
  }
  if (Array.isArray(R._readers)) {
    return R._readers;
  }
  return [];
}

/**
 * Get a reader instance by tab id (defensive).
 */
export function getReaderByTabID(
  tabID: string | number,
): _ZoteroTypes.ReaderInstance | undefined {
  const R: any = (Zotero as any).Reader;
  if (!R) return undefined;
  if (typeof R.getByTabID === "function") {
    try {
      return R.getByTabID(tabID);
    } catch {
      /* fall through */
    }
  }
  return getAllReaders().find(
    (r: any) => r.tabID === tabID || r._tabID === tabID,
  );
}

/**
 * Get the internal iframe window of a reader (the pdf.js viewer document).
 *
 * Zotero 7 reader instances expose `_iframeWindow` directly (the preferred,
 * ready-to-use inner Window). We fall back to `_iframe.contentWindow` for
 * older builds. See zotero-types `ReaderInstance`.
 */
export function getReaderInnerWindow(
  reader: _ZoteroTypes.ReaderInstance,
): Window | undefined {
  const r = reader as any;
  if (r._iframeWindow && r._iframeWindow.document) {
    return r._iframeWindow;
  }
  const iframe = r._iframe as HTMLIFrameElement | undefined;
  return iframe?.contentWindow || undefined;
}

/**
 * Build the chrome URL for an addon asset.
 */
export function getChromeURL(relPath: string): string {
  return `chrome://${config.addonRef}/content/${relPath}`;
}
