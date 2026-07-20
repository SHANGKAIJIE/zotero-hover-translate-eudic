/**
 * 扇贝自定义 Trie 编码解码器。
 *
 * 扇贝的导出 API（learning_items / unlearned_items）返回的数据经过
 * 自定义 Trie + Base32 编码后再套一层 Base64，必须用此解码器还原。
 *
 * 移植自 shanbay-ext-main: src/entrypoints/decodes.js
 * 原始算法由扇贝实现，此处仅做 TypeScript 移植。
 */

const B32_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B64_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MIN_LOOP = 8;
const PRE_LOOP = 8;
const BAY_SH0 = 1;
const BAY_SH1 = 10;
const BAY_SH8 = 8;
const BAY_MASK = 0x7fffffff;
const CNT = [1, 2, 2, 2, 2, 2];

/* ---- 32-bit unsigned integer helpers ---- */

function u32(v: number): number {
  return v >>> 0;
}

function xor(a: number, b: number): number {
  return u32(u32(a) ^ u32(b));
}

function and(a: number, b: number): number {
  return u32(u32(a) & u32(b));
}

function mul(a: number, b: number): number {
  const high16 = ((a & 0xffff0000) >>> 0) * b;
  const low16 = (a & 0x0000ffff) * b;
  return u32(u32(high16) + u32(low16));
}

function or(a: number, b: number): number {
  return u32(u32(a) | u32(b));
}

function not(a: number): number {
  return u32(~u32(a));
}

function shiftLeft(a: number, b: number): number {
  return u32(u32(a) << b);
}

function shiftRight(a: number, b: number): number {
  return u32(a) >>> b;
}

function mod(a: number, b: number): number {
  return u32(u32(a) % b);
}

/* ---- PRNG (Mersenne Twister-like, 4-word state) ---- */

class Random {
  status: number[] = [];
  mat1 = 0;
  mat2 = 0;
  tmat = 0;

  seed(seeds: number[]): void {
    for (let i = 0; i < 4; i++) {
      this.status[i] = seeds.length > i ? u32(seeds[i]) : u32(110);
    }
    [, this.mat1, this.mat2, this.tmat] = this.status;
    this.init();
  }

  private init(): void {
    for (let i = 0; i < MIN_LOOP - 1; i++) {
      this.status[(i + 1) & 3] = xor(
        this.status[(i + 1) & 3],
        i + 1 + mul(1812433253, xor(this.status[i & 3], shiftRight(this.status[i & 3], 30))),
      );
    }
    if (
      (this.status[0] & BAY_MASK) === 0 &&
      this.status[1] === 0 &&
      this.status[2] === 0 &&
      this.status[3] === 0
    ) {
      this.status[0] = 66;
      this.status[1] = 65;
      this.status[2] = 89;
      this.status[3] = 83;
    }
    for (let i = 0; i < PRE_LOOP; i++) this.nextState();
  }

  private nextState(): void {
    let x: number;
    let y: number;
    [, , , y] = this.status;
    x = xor(and(this.status[0], BAY_MASK), xor(this.status[1], this.status[2]));
    x = xor(x, shiftLeft(x, BAY_SH0));
    y = xor(y, xor(shiftRight(y, BAY_SH0), x));
    [, this.status[0], this.status[1]] = this.status;
    this.status[2] = xor(x, shiftLeft(y, BAY_SH1));
    this.status[3] = y;
    this.status[1] = xor(this.status[1], and(-and(y, 1), this.mat1));
    this.status[2] = xor(this.status[2], and(-and(y, 1), this.mat2));
  }

  generate(max: number): number {
    this.nextState();
    let t0: number;
    [, , , t0] = this.status;
    const t1 = xor(this.status[0], shiftRight(this.status[2], BAY_SH8));
    t0 = xor(t0, t1);
    t0 = xor(and(-and(t1, 1), this.tmat), t0);
    return t0 % max;
  }
}

/* ---- Trie Node ---- */

class Node {
  char = ".";
  children: Record<string, Node> = {};

  getChar(): string {
    return this.char;
  }

  setChar(char: string): void {
    this.char = char;
  }
}

/* ---- Trie Tree ---- */

class Tree {
  private random = new Random();
  sign = "";
  head = new Node();

  init(sign: string): void {
    const seeds: number[] = [];
    for (let i = 0; i < 4; i++) {
      seeds.push(sign.charCodeAt(i) || 0);
    }
    this.random.seed(seeds);
    this.sign = sign;
    for (let i = 0; i < 64; i++) {
      this.addSymbol(B64_CODE[i], CNT[Math.floor((i + 1) / 11)]);
    }
  }

  private addSymbol(ch: string, len: number): void {
    let ptr = this.head;
    for (let i = 0; i < len; i++) {
      let innerChar = B32_CODE[this.random.generate(32)];
      while (
        innerChar in ptr.children &&
        ptr.children[innerChar].getChar() !== "."
      ) {
        innerChar = B32_CODE[this.random.generate(32)];
      }
      if (!(innerChar in ptr.children)) {
        ptr.children[innerChar] = new Node();
      }
      ptr = ptr.children[innerChar];
    }
    ptr.setChar(ch);
  }

  decode(enc: string): string {
    let dec = "";
    for (let i = 4; i < enc.length; ) {
      if (enc[i] === "=") {
        dec += "=";
        i++;
        continue;
      }
      let ptr = this.head;
      while (enc[i] in ptr.children) {
        ptr = ptr.children[enc[i]];
        i++;
      }
      dec += ptr.getChar();
    }
    return dec;
  }
}

/* ---- Helpers ---- */

function getIdx(c: string): number {
  const x = c.charCodeAt(0);
  if (x >= 65) return x - 65;
  return x - 65 + 41;
}

const VERSION = 1;

function checkVersion(s: string): boolean {
  const wi = getIdx(s[0]) * 32 + getIdx(s[1]);
  const x = getIdx(s[2]);
  const check = getIdx(s[3]);
  return VERSION >= (wi * x + check) % 32;
}

/* ---- Base64 decode without Node.js Buffer ---- */

function base64Decode(str: string): string {
  // atob() is available in Zotero 7 (Electron/Chrome)
  const binaryStr = atob(str);
  // Convert binary string to UTF-8 using TextDecoder (also available in Zotero 7)
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/* ---- Public API ---- */

export function shanbayDecode(enc: string): string {
  if (!enc || enc.length < 4) return "";
  enc = enc.trim();
  if (!checkVersion(enc)) return "";
  const tree = new Tree();
  tree.init(enc.substring(0, 4));
  const trieDecoded = tree.decode(enc);
  return base64Decode(trieDecoded);
}

/**
 * Parse decoded export response into word entries.
 *
 * Actual API response format:
 *   {"ipp":20,"objects":[{"type_of":"NEW","vocabulary":{"id":"...","content":"word1",...}}, ...]}
 *
 * Also handles:
 *   [{"content":"word1"}, ...]  — plain array
 *   {"items":[{...}], "total": ...}  — nested items
 */
export function parseExportResponse(decoded: string): { content: string }[] {
  if (!decoded) return [];
  try {
    const data = JSON.parse(decoded);
    // Format: {objects:[{vocabulary:{content:"..."}}]}
    if (data.objects && Array.isArray(data.objects)) {
      return data.objects
        .map((obj: any) => {
          const vocab = obj.vocabulary || obj;
          return { content: vocab.content || vocab.word || "" };
        })
        .filter((item: { content: string }) => item.content);
    }
    // Plain array
    if (Array.isArray(data)) return data;
    // Nested items/words/data
    const items = data.items || data.words || data.data || [];
    if (Array.isArray(items)) return items;
    // Single item
    if (data.content || data.word) return [data];
    return [];
  } catch {
    return [];
  }
}
