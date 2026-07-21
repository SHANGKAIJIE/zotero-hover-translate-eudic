/**
 * HTTP endpoint registration for Shanbay & Maimemo integration.
 *
 * Uses Zotero.Server.Endpoints — the standard Zotero plugin API for
 * registering custom endpoints on the built-in HTTP server (port 23119).
 *
 * The HTE Bridge browser extension must send the `Zotero-Allowed-Request: true`
 * header with every request to bypass CORS restrictions.
 *
 * Endpoints:
 *   GET  /shanbay-token/ping   — health check (HTE Bridge port discovery)
 *   POST /shanbay-token/token  — receive shanbay auth_token from HTE Bridge
 *   GET  /maimemo-token/ping   — health check (HTE Bridge port discovery)
 *   POST /maimemo-token/token  — receive maimemo access token from HTE Bridge
 */

import { setPref } from "../utils/prefs";

class ShanbayPingEndpoint {
  supportedMethods = ["GET"];
  supportedDataTypes = ["*"];
  permitBookmarklet = false;

  init(_urlObj: any, _data: any, sendResponse: Function) {
    sendResponse(200, "application/json", JSON.stringify({
      plugin: "hover-translate-eudic",
      version: __env__,
      alive: true,
    }));
  }
}

class ShanbayTokenEndpoint {
  supportedMethods = ["POST", "OPTIONS"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  init(data: any, sendResponse: Function) {
    let body: any;
    if (typeof data === "string") {
      try { body = JSON.parse(data); } catch {
        sendResponse(400, "application/json", JSON.stringify({ status: "error", message: "invalid JSON" }));
        return;
      }
    } else {
      body = data;
    }
    const token = body?.auth_token;
    if (token) {
      setPref("shanbayToken", token);
      sendResponse(200, "application/json", JSON.stringify({ status: "ok" }));
    } else {
      sendResponse(400, "application/json", JSON.stringify({ status: "error", message: "missing auth_token" }));
    }
  }
}

class MaimemoPingEndpoint {
  supportedMethods = ["GET"];
  supportedDataTypes = ["*"];
  permitBookmarklet = false;

  init(_urlObj: any, _data: any, sendResponse: Function) {
    sendResponse(200, "application/json", JSON.stringify({
      plugin: "hover-translate-eudic",
      version: __env__,
      alive: true,
    }));
  }
}

class MaimemoTokenEndpoint {
  supportedMethods = ["POST", "OPTIONS"];
  supportedDataTypes = ["application/json"];
  permitBookmarklet = false;

  init(data: any, sendResponse: Function) {
    let body: any;
    if (typeof data === "string") {
      try { body = JSON.parse(data); } catch {
        sendResponse(400, "application/json", JSON.stringify({ status: "error", message: "invalid JSON" }));
        return;
      }
    } else {
      body = data;
    }
    const token = body?.auth_token;
    if (token) {
      setPref("maimemoToken", token);
      sendResponse(200, "application/json", JSON.stringify({ status: "ok" }));
    } else {
      sendResponse(400, "application/json", JSON.stringify({ status: "error", message: "missing auth_token" }));
    }
  }
}

export function registerServer(): void {
  Zotero.Server.Endpoints["/shanbay-token/ping"] = ShanbayPingEndpoint;
  Zotero.Server.Endpoints["/shanbay-token/token"] = ShanbayTokenEndpoint;
  Zotero.Server.Endpoints["/maimemo-token/ping"] = MaimemoPingEndpoint;
  Zotero.Server.Endpoints["/maimemo-token/token"] = MaimemoTokenEndpoint;
  try {
    Zotero.debug("[hovertranslateeudic/server] /shanbay-token/* + /maimemo-token/* registered");
  } catch { /* ignore */ }
}

export function unregisterServer(): void {
  delete Zotero.Server.Endpoints["/shanbay-token/ping"];
  delete Zotero.Server.Endpoints["/shanbay-token/token"];
  delete Zotero.Server.Endpoints["/maimemo-token/ping"];
  delete Zotero.Server.Endpoints["/maimemo-token/token"];
  try {
    Zotero.debug("[hovertranslateeudic/server] /shanbay-token/* + /maimemo-token/* unregistered");
  } catch { /* ignore */ }
}
