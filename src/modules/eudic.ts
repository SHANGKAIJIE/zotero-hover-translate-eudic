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

/** Rate limit windows (from Eudic OpenAPI docs §7).
 *  30 / 1 min → 1 h ban,  500 / 30 min → 24 h ban */
const RATE_LIMITS: { windowMs: number; max: number }[] = [
  { windowMs: 60_000, max: 30 },
  { windowMs: 30 * 60_000, max: 500 },
];

/** Shared rate-limit tracker across all EudicClient instances. */
let _requestTimestamps: number[] = [];

export interface EudicCategory {
  id: string;
  language: string;
  name: string;
}

export interface EudicAddWordResult {
  success: boolean;
  message: string;
}

export interface EudicWordEntry {
  word: string;
  phon?: string;
  exp?: string;
  add_time?: string;
  star?: number;
  context_line?: string;
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

  /** Wait if any rate limit window would be exceeded. */
  private async _rateLimitWait(): Promise<void> {
    const now = Date.now();
    for (const { windowMs, max } of RATE_LIMITS) {
      const cutoff = now - windowMs;
      _requestTimestamps = _requestTimestamps.filter((t) => t > cutoff);
      const count = _requestTimestamps.length;
      if (count >= max) {
        const sorted = [..._requestTimestamps].sort((a, b) => a - b);
        const waitMs = sorted[0] + windowMs - now + 100; // +100ms buffer
        if (waitMs > 0 && waitMs < 300_000) {
          await new Promise((r) => setTimeout(r, waitMs));
          return this._rateLimitWait(); // Re-check after waiting
        }
        if (waitMs >= 300_000) {
          throw new Error("Rate limit exhausted: too many requests");
        }
      }
    }
    _requestTimestamps.push(Date.now());
  }

  private async request(
    method: string,
    path: string,
    body?: object,
    query?: Record<string, string>,
  ): Promise<any> {
    await this._rateLimitWait();
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
   * 1.4 Create a new wordbook.
   * POST /studylist/category
   */
  async createCategory(name: string): Promise<EudicCategory> {
    const data = await this.request(
      "POST",
      "/api/open/v1/studylist/category",
      { language: this.language, name },
    );
    const c = data?.data || {};
    return {
      id: String(c.id ?? ""),
      name: c.name ?? name,
      language: c.language ?? this.language,
    };
  }

  /**
   * 1.5 Rename a wordbook.
   * PATCH /studylist/category
   */
  async renameCategory(categoryId: string, currentName: string, newName: string): Promise<void> {
    await this.request("PATCH", "/api/open/v1/studylist/category", {
      id: categoryId,
      language: this.language,
      name: newName,
    });
  }

  /**
   * 1.6 Delete a wordbook.
   * DELETE /studylist/category
   */
  async deleteCategory(categoryId: string, name: string): Promise<void> {
    await this.request("DELETE", "/api/open/v1/studylist/category", {
      id: categoryId,
      language: this.language,
      name,
    });
  }

  /**
   * 1.? Get all words from a wordbook (paginated).
   * @param categoryId target wordbook id
   * @param maxPages max pages to fetch (default 50 → up to 5000 words)
   */
  async getWords(
    categoryId: string,
    maxPages: number = 50,
  ): Promise<EudicWordEntry[]> {
    const all: EudicWordEntry[] = [];
    for (let page = 0; page < maxPages; page++) {
      const data = await this.request(
        "GET",
        "/api/open/v1/studylist/words",
        undefined,
        {
          language: this.language,
          category_id: categoryId,
          page: String(page),
          page_size: "100",
        },
      );
      const list: any[] = Array.isArray(data) ? data : (data.data || []);
      for (const item of list) {
        all.push({
          word: item.word ?? "",
          phon: item.phon,
          exp: item.exp,
          add_time: item.add_time,
          star: item.star,
          context_line: item.context_line,
        });
      }
      // If less than 100 returned, we've reached the last page.
      if (list.length < 100) break;
    }
    return all;
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
