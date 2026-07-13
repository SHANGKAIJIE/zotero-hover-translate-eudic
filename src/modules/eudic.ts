/**
 * Eudic (欧路词典) OpenAPI client.
 *
 * Docs: https://my.eudic.net/OpenAPI/doc_api_study
 * Base URL: https://api.frdic.com
 * Auth: HTTP header `Authorization: NIS <token>`
 *
 * All requests go directly to the official Eudic endpoints. The token is
 * stored only in Zotero local prefs and is never sent to any third party.
 */

const EUDIC_BASE = "https://api.frdic.com";

import { getPref } from "../utils/prefs";

export interface EudicCategory {
  id: string;
  language: string;
  name: string;
}

export interface EudicAddWordResult {
  success: boolean;
  message: string;
}

export class EudicClient {
  private token: string;
  private language: string;

  constructor(token: string, language: string = "en") {
    // Accept token with or without the "NIS " prefix; normalize to bare token.
    const t = (token || "").trim();
    this.token = t.startsWith("NIS ") ? t.slice(4).trim() : t;
    this.language = language;
  }

  setToken(token: string) {
    this.token = token;
  }

  setLanguage(language: string) {
    this.language = language;
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `NIS ${this.token}`,
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/json",
    };
  }

  private async request(
    method: string,
    path: string,
    body?: object,
    query?: Record<string, string>,
  ): Promise<any> {
    let url = `${EUDIC_BASE}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      url += `?${qs}`;
    }
    const options: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    } = {
      method,
      headers: this.getHeaders(),
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    let resp: any;
    try {
      resp = await Zotero.HTTP.request(method as any, url, options as any);
    } catch (e: any) {
      const err = new Error(
        `Network error: ${e?.message || e}`,
      ) as Error & { status?: number };
      err.status = 0;
      throw err;
    }
    const status = resp.status;
    // 204 = delete success, no body
    if (status === 204) {
      return { message: "" };
    }
    // Parse JSON from responseText (most reliable across Zotero versions).
    let data: any;
    const txt: string =
      resp.responseText ??
      (typeof resp.response === "string" ? resp.response : "");
    try {
      Zotero.debug(`[hover-translate-eudic/eudic] ${method} ${path} status=${status} bodyLen=${txt.length} body=${txt.slice(0, 300)}`);
    } catch { /* ignore */ }
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = { message: txt || `HTTP ${status}` };
    }
    if (status >= 200 && status < 300) {
      return data;
    }
    const msg =
      data?.message ||
      (status === 401
        ? "Token invalid or expired"
        : status === 403
          ? "Rate limited"
          : `HTTP ${status}`);
    const err = new Error(msg) as Error & { status?: number };
    err.status = status;
    throw err;
  }

  /**
   * 1.1 Get all wordbook categories.
   */
  async getCategories(): Promise<EudicCategory[]> {
    const data = await this.request(
      "GET",
      "/api/open/v1/studylist/category",
      undefined,
      { language: this.language },
    );
    // Log raw response for debugging.
    try {
      Zotero.debug(`[hover-translate-eudic/eudic] getCategories raw: ${JSON.stringify(data).slice(0, 500)}`);
    } catch { /* ignore */ }
    // API may return { data: [...] } or an array directly.
    const list = Array.isArray(data) ? data : (data.data || []);
    return list.map((c: any) => ({
      id: String(c.id ?? c.category_id ?? ""),
      name: c.name ?? c.title ?? c.category_name ?? String(c.id ?? ""),
      language: c.language ?? this.language,
    }));
  }

  /**
   * 1.8 Add a single word to a wordbook.
   * @param word the word to add
   * @param categoryId target category id; "0" / undefined => default category
   * @param contextLine optional context sentence
   */
  async addWord(
    word: string,
    categoryId?: string,
    contextLine?: string,
  ): Promise<EudicAddWordResult> {
    const body: any = {
      language: this.language,
      word,
    };
    if (categoryId && categoryId !== "0") {
      body.category_ids = [categoryId];
    } else {
      body.category_ids = [0];
    }
    if (contextLine) {
      body.context_line = contextLine;
    }
    try {
      const data = await this.request(
        "POST",
        "/api/open/v1/studylist/word",
        body,
      );
      return { success: true, message: data.message || "ok" };
    } catch (e: any) {
      return { success: false, message: e?.message || "failed" };
    }
  }
}

/**
 * Build a client from current prefs (or null if token missing).
 */
export function createEudicClientFromPrefs(): EudicClient | null {
  const token = getPref("eudicToken") as string;
  if (!token) {
    return null;
  }
  const language = getPref("eudicLanguage") as string;
  return new EudicClient(token, language);
}
