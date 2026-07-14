/**
 * Maimemo (墨墨背单词) OpenAPI client.
 *
 * Docs: https://open.maimemo.com/
 * Base URL: https://open.maimemo.com
 * Auth: HTTP header `Authorization: Bearer <token>`
 * Rate limits: 20/10s, 40/60s, 2000/5h
 *
 * Reference: https://github.com/bulletproof-system/zotero-maimemo-sync
 */

import { getPref } from "../utils/prefs";
import type { EudicWordEntry } from "./eudic";

const MAIMEMO_BASE = "https://open.maimemo.com";

/** Rate limit windows (from Maimemo docs). */
const RATE_LIMITS: { windowMs: number; max: number }[] = [
  { windowMs: 10_000, max: 20 },
  { windowMs: 60_000, max: 40 },
  { windowMs: 5 * 3600_000, max: 2000 },
];

export interface MaimemoNotepad {
  id: string;
  name: string;
  language: string;
  /** Original notepad title from Maimemo. */
  title?: string;
  brief?: string;
  tags?: string[];
  content?: string;
}

interface MaimemoResponse<T = any> {
  data?: T;
  errors?: { code: string; msg: string; info: string }[];
  success: boolean;
}

/** Shared rate-limit tracker across all MaimemoClient instances. */
let _requestTimestamps: number[] = [];

/** Content cache to avoid extra GET before each addWord. */
const _notepadCache = new Map<string, {
  content: string;
  status: string;
  title: string;
  brief: string;
  tags: string[];
}>();

export class MaimemoClient {
  private token: string;

  constructor(token: string) {
    this.token = (token || "").trim();
  }

  setToken(token: string) {
    this.token = token;
  }

  /** Wait if any rate limit window would be exceeded. */
  private async _rateLimitWait(): Promise<void> {
    const now = Date.now();
    for (const { windowMs, max } of RATE_LIMITS) {
      const cutoff = now - windowMs;
      // Prune old timestamps
      _requestTimestamps = _requestTimestamps.filter((t) => t > cutoff);
      const count = _requestTimestamps.length;
      if (count >= max) {
        // Find when the oldest request in this window expires
        const sorted = [..._requestTimestamps].sort((a, b) => a - b);
        const waitMs = sorted[0] + windowMs - now + 100; // +100ms buffer
        // Only wait if wait is reasonable (<5 min)
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

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async request(
    method: string,
    path: string,
    body?: object,
    query?: Record<string, string>,
  ): Promise<any> {
    await this._rateLimitWait();
    let url = `${MAIMEMO_BASE}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      url += `?${qs}`;
    }
    const options: any = {
      method,
      headers: this.getHeaders(),
      successCodes: false,
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    let resp: any;
    try {
      resp = await Zotero.HTTP.request(method as any, url, options);
    } catch (e: any) {
      const err = new Error(
        `Network error: ${e?.message || e}`,
      ) as Error & { status?: number };
      err.status = 0;
      throw err;
    }
    const status = resp.status;
    if (status === 204) {
      return { success: true };
    }
    const txt: string =
      resp.responseText ??
      (typeof resp.response === "string" ? resp.response : "");
    try {
      Zotero.debug(`[hover-translate-eudic/maimemo] ${method} ${path} status=${status} bodyLen=${txt.length}`);
    } catch { /* ignore */ }
    let data: any;
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = { message: txt || `HTTP ${status}` };
    }
    // Maimemo wraps responses in { data, errors, success }
    if (data.success === true) {
      return data;
    }
    // Check for Maimemo error format
    const errors = data?.errors;
    if (errors && errors.length > 0) {
      const msg = errors.map((e: any) => e.msg || e.code).join("; ");
      const err = new Error(msg) as Error & { status?: number };
      err.status = status;
      throw err;
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
   * List all notepads (paginated, auto-fetches all pages).
   * Returns normalized format compatible with existing code.
   */
  async getCategories(): Promise<MaimemoNotepad[]> {
    const all: any[] = [];
    let offset = 0;
    const limit = 10;
    while (true) {
      const data = await this.request(
        "GET",
        "/open/api/v1/notepads",
        undefined,
        { limit: String(limit), offset: String(offset) },
      );
      const notepads: any[] =
        data?.data?.notepads || data?.notepads || [];
      all.push(...notepads);
      if (notepads.length < limit) break;
      offset += limit;
    }
    return all.map((n: any) => ({
      id: n.id ?? "",
      name: n.title ?? n.name ?? String(n.id ?? ""),
      language: "",
      title: n.title,
      brief: n.brief,
      tags: n.tags,
    }));
  }

  /**
   * Create a new notepad.
   * POST /open/api/v1/notepads
   */
  async createCategory(name: string): Promise<MaimemoNotepad> {
    const data = await this.request("POST", "/open/api/v1/notepads", {
      notepad: {
        title: name,
        status: "PUBLISHED",
      },
    });
    const n = data?.data?.notepad || data?.notepad || {};
    return {
      id: n.id ?? "",
      name: n.title ?? name,
      language: "",
    };
  }

  /**
   * Rename a notepad (update title via POST /open/api/v1/notepads/{id}).
   */
  async renameCategory(
    notepadId: string,
    _currentName: string,
    newName: string,
  ): Promise<void> {
    // First fetch the notepad to get all fields
    const resp = await this.request(
      "GET",
      `/open/api/v1/notepads/${notepadId}`,
    );
    const notepad = resp?.data?.notepad || resp?.notepad || {};
    await this.request("POST", `/open/api/v1/notepads/${notepadId}`, {
      notepad: {
        status: notepad.status || "PUBLISHED",
        content: notepad.content || "//",
        title: newName,
        brief: notepad.brief || "",
        tags: notepad.tags || [],
      },
    });
    _notepadCache.delete(notepadId);
  }

  /**
   * Delete a notepad.
   * DELETE /open/api/v1/notepads/{id}
   */
  async deleteCategory(notepadId: string, _name: string): Promise<void> {
    await this.request("DELETE", `/open/api/v1/notepads/${notepadId}`);
    _notepadCache.delete(notepadId);
  }

  /**
   * Add a word to a notepad by appending to its content.
   */
  async addWord(
    word: string,
    notepadId?: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      if (!notepadId) {
        throw new Error("No notepad selected");
      }
      // Use cache if available, otherwise fetch from API
      let cached = _notepadCache.get(notepadId);
      if (!cached) {
        const resp = await this.request(
          "GET",
          `/open/api/v1/notepads/${notepadId}`,
        );
        const n = resp?.data?.notepad || resp?.notepad || {};
        cached = {
          content: n.content || "//",
          status: n.status || "PUBLISHED",
          title: n.title || "",
          brief: n.brief || "",
          tags: n.tags || [],
        };
        _notepadCache.set(notepadId, cached);
      }
      // Parse existing words
      const existingWords = cached.content
        .split("\n")
        .map((line: string) => line.trim())
        .filter((line: string) => line !== "" && line !== "//");
      if (existingWords.includes(word)) {
        return { success: true, message: "Word already exists" };
      }
      // Append and update
      cached.content = cached.content + "\n" + word;
      await this.request("POST", `/open/api/v1/notepads/${notepadId}`, {
        notepad: {
          status: cached.status,
          content: cached.content,
          title: cached.title,
          brief: cached.brief,
          tags: cached.tags,
        },
      });
      return { success: true, message: "ok" };
    } catch (e: any) {
      return { success: false, message: e?.message || "failed" };
    }
  }

  /**
   * Get all words from a notepad (parse content text).
   * Maimemo stores notepad content as `//\nword1\nword2\n...`
   * Note: Maimemo API does not expose system-level word definitions;
   * only self-created interpretations are available (and return 403 for
   * words the user hasn't created custom interpretations for).
   */
  async getWords(notepadId: string): Promise<EudicWordEntry[]> {
    const resp = await this.request(
      "GET",
      `/open/api/v1/notepads/${notepadId}`,
    );
    const notepad = resp?.data?.notepad || resp?.notepad || {};
    const content: string = notepad.content || "";
    const words = content
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line !== "" && line !== "//");

    return words.map((w: string) => ({
      word: w,
      phon: "",
      exp: "",
      context_line: "",
      add_time: "",
      star: 0,
    }));
  }
}

/**
 * Build a client from current prefs (or null if token missing).
 */
export function createMaimemoClientFromPrefs(): MaimemoClient | null {
  const token = getPref("maimemoToken") as string;
  if (!token) {
    return null;
  }
  return new MaimemoClient(token);
}
