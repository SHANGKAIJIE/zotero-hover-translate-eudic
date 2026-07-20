/**
 * Shanbay (扇贝单词) API client.
 *
 * Based on investigation of shanbay-ext, Saladict, and WordsOut projects.
 *
 * Base URL: https://apiv3.shanbay.com
 * Auth: Cookie header `auth_token=<token>` (NOT Authorization header)
 *
 * Key limitations:
 *   - No multi-notebook support (only default wordbook)
 *   - Word must exist in Shanbay database (404 if not found)
 *   - Export returns word-only, no phonetics/definitions
 *
 * Rate limits: 500ms/word (from Saladict reference)
 */

import { getPref } from "../utils/prefs";
import type { EudicWordEntry } from "./eudic";
import { shanbayDecode, parseExportResponse } from "./shanbayDecode";

const SHANBAY_BASE = "https://apiv3.shanbay.com";

/** Prevent repeated token-expiry alerts within a short window. */
let _tokenExpiredAlerted = false;
let _lastExpiredAlert = 0;

export interface ShanbayCategory {
  id: string;
  name: string;
  language: string;
}

export class ShanbayClient {
  private token: string;

  constructor(token: string) {
    this.token = (token || "").trim();
  }

  setToken(token: string) {
    this.token = token;
  }

  // ---- Auth ----

  /** Returns the Cookie header value for API authentication. */
  private getCookie(): string {
    return `auth_token=${this.token}`;
  }

  // ---- HTTP helper ----

  private async request(method: string, path: string, body?: object): Promise<any> {
    const url = `${SHANBAY_BASE}${path}`;
    const options: Record<string, any> = {
      method,
      headers: {
        Cookie: this.getCookie(),
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    let resp: any;
    try {
      resp = await Zotero.HTTP.request(method as any, url, options as any);
    } catch (e: any) {
      const err = new Error(
        `Network error: ${e?.message || e}`
      ) as Error & { status?: number };
      err.status = 0;
      throw err;
    }
    const status = resp.status;
    const txt: string =
      resp.responseText ??
      (typeof resp.response === "string" ? resp.response : "");

    try {
      Zotero.debug(
        `[hovertranslateeudic/shanbay] ${method} ${path} status=${status} body=${txt.slice(0, 200)}`
      );
    } catch { /* ignore */ }

    let data: any;
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = { msg: txt || `HTTP ${status}` };
    }

    // 401 = token expired
    if (status === 401) {
      this._handleTokenExpired();
      const err = new Error("Shanbay token expired, please re-login") as Error & { status?: number };
      err.status = 401;
      throw err;
    }

    // 404 = word not found
    if (status === 404) {
      return null;
    }

    if (status >= 200 && status < 300) {
      return data;
    }

    const msg = data?.msg || `HTTP ${status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = status;
    throw err;
  }

  private _handleTokenExpired() {
    const now = Date.now();
    if (_tokenExpiredAlerted && now - _lastExpiredAlert < 60_000) return;
    _tokenExpiredAlerted = true;
    _lastExpiredAlert = now;
    try {
      const win = Zotero.getMainWindow();
      if (win) {
        win.alert(
          "扇贝 auth_token 已过期，请在浏览器中重新登录扇贝，然后通过 HTE Bridge 刷新 Token，或手动粘贴新 Token。"
        );
      }
    } catch { /* ignore */ }
  }

  // ---- Lookup: get vocab_id from word ----

  async lookupWord(word: string): Promise<string | null> {
    const url = `/abc/words/senses?vocabulary_content=${encodeURIComponent(word)}`;
    const data = await this.request("GET", url);
    if (!data || !data.id) return null;
    return String(data.id);
  }

  // ---- Add word ----

  async addWord(word: string): Promise<{ success: boolean; message: string }> {
    try {
      // Step 1: lookup vocab_id
      const vocabId = await this.lookupWord(word);
      if (!vocabId) {
        return { success: false, message: `"${word}" is not in Shanbay database` };
      }

      // Step 2: add to wordbook
      const body = { vocab_id: vocabId, business_id: 6 };
      const data = await this.request("POST", "/wordscollection/words", body);
      if (data && data.created_at) {
        return { success: true, message: "" };
      }
      return { success: false, message: "Shanbay response missing created_at" };
    } catch (e: any) {
      return { success: false, message: e?.message || "Unknown error" };
    }
  }

  // ---- Categories (Shanbay only supports default wordbook) ----

  async getCategories(): Promise<ShanbayCategory[]> {
    return [{ id: "default", name: "默认生词本", language: "en" }];
  }

  async createCategory(_name: string): Promise<any> {
    return null; // Shanbay does not support custom wordbooks
  }

  async renameCategory(
    _categoryId: string,
    _currentName: string,
    _newName: string
  ): Promise<void> {
    // Shanbay does not support renaming
  }

  async deleteCategory(_categoryId: string, _name: string): Promise<void> {
    // Shanbay does not support deleting
  }

  // ---- Export ----

  async getWords(_categoryId?: string): Promise<EudicWordEntry[]> {
    const words: EudicWordEntry[] = [];
    const pageSize = 20;

    // Try multiple endpoints to fetch all words
    // Reference: shanbay-ext uses today_learning_items with type_of=REVIEW
    const endpoints = [
      "/wordscollection/learning/words/today_learning_items?type_of=REVIEW",
      "/wordscollection/learning/words/today_learning_items?type_of=NEW",
      "/wordscollection/learning/words/unlearned_items",
      "/wordscollection/learning/words/learning_items",
    ];

    for (const ep of endpoints) {
      if (words.length > 0) break; // already got words
      await this._fetchPages(ep, pageSize, words, /*maxPages*/ 5);
    }

    return words;
  }

  private async _fetchPages(
    path: string,
    pageSize: number,
    words: EudicWordEntry[],
    maxPages: number = 5,
  ): Promise<void> {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `${path}${path.includes("?") ? "&" : "?"}ipp=${pageSize}&page=${page}`;
        const data = await this.request("GET", url);
        if (!data) break;

        const items = this._decodeExportResponse(data);
        if (items.length === 0) break;

        for (const item of items) {
          if (item.word && !words.find((w) => w.word === item.word)) {
            words.push(item);
          }
        }

        // If fewer items than pageSize, we've reached the end
        if (items.length < pageSize) break;

        // Rate limit between pages: 500ms
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        break;
      }
    }
  }

  /** Decode shanbay export response. */
  private _decodeExportResponse(data: any): EudicWordEntry[] {
    if (!data) return [];
    try {
      // The API may return encoded data in `data.data` or directly as a string
      const enc = data.data || data;
      if (!enc) return [];

      if (typeof enc === "string") {
        // Encoded response — decode via Trie decoder
        const decoded = shanbayDecode(enc);
        if (!decoded) {
          try {
            Zotero.debug(`[hovertranslateeudic/shanbay] decode returned empty, raw enc length=${enc.length}`);
          } catch { /* ignore */ }
          return [];
        }
        try {
          Zotero.debug(`[hovertranslateeudic/shanbay] decoded ${decoded.length} chars, preview=${decoded.slice(0, 200)}`);
        } catch { /* ignore */ }
        const items = parseExportResponse(decoded);
        try {
          Zotero.debug(`[hovertranslateeudic/shanbay] parseExportResponse returned ${items.length} items`);
        } catch { /* ignore */ }
        return items.map((item: any) => ({
          word: item.content || item.word || "",
          phon: "",
          exp: item.definition || "",
        })).filter((e: EudicWordEntry) => e.word);
      }

      // Already parsed JSON — check for word arrays
      if (Array.isArray(enc)) {
        return enc.map((item: any) => ({
          word: item.content || item.word || "",
          phon: "",
          exp: item.definition || "",
        })).filter((e: EudicWordEntry) => e.word);
      }

      // Nested data
      const items = enc.items || enc.words || enc.data || [];
      if (Array.isArray(items)) {
        return items.map((item: any) => ({
          word: item.content || item.word || "",
          phon: "",
          exp: item.definition || "",
        })).filter((e: EudicWordEntry) => e.word);
      }
    } catch (e: any) {
      try {
        Zotero.debug(`[hovertranslateeudic/shanbay] decode error: ${e?.message}`);
      } catch { /* ignore */ }
    }
    return [];
  }
}

// ---- Factory function ----

export function createShanbayClientFromPrefs(): ShanbayClient | null {
  const token = getPref("shanbayToken") as string;
  if (!token) return null;
  return new ShanbayClient(token);
}
