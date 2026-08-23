#!/usr/bin/env node
/**
 * 端到端验证：使用 jina reader 拉取海词桌面版真实 HTML，
 * 按 haicidict.ts 的解析逻辑生成 data.result，
 * 然后跑修复后的 extractFirstDefinition。
 *
 * 用法：node scripts/dict_e2e_haici.js
 */
import { setTimeout as sleep } from "node:timers/promises";

const POS_WORDS =
  "linkv|attrib|auxv|interrog|interj|prefix|suffix|abbr|modal|modv|phr|idm|comb|pref|suff|sing|pl|pred|na|noun|verb|adjective|adverb|preposition|conjunction|pronoun|interjection|article|determiner|numeral|quantifier|symbol|n|vt|vi|adj|adv|a|ad|prep|conj|pron|int|art|aux|det|num|qua|sym|v|verbal|adverbial|prepositional|conjunctional|pronounal|vbl";
const ZH_POS_WORDS =
  "形容词|副词|动词|名词|介词|连词|代词|数词|量词|助词|叹词|助动词|象声词|拟声词|语气词|区别词|方位词|词缀|前缀|后缀|缩略语|简称";
const IPA_LINE_CHARS =
  "a-zA-Z\\u0250-\\u02AF\\u02B0-\\u02FF\\u0300-\\u036F,.;:\\s-";

function isPhoneticLine(l) {
  return (
    /^(英|美)\s*[\[/(]/.test(l) ||
    /^(uk|us)\s*[/'\[(]/.test(l) ||
    (/^[/\[(]/.test(l) && /[ˈˌəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑɝɚɘɵɤɨ]/.test(l)) ||
    (/^[a-z]+ /i.test(l) && /[ˈˌəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑ]/.test(l) && !/[一-龥]/.test(l)) ||
    (new RegExp(`^[${IPA_LINE_CHARS}]+$`, "i").test(l) &&
      /[ˈˌəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑɝɚɘɵɤɨ]/.test(l) &&
      !/[一-龥]/.test(l) &&
      !/[.!?]$/.test(l) &&
      l.length < 80)
  );
}
function isBarePosLine(l) {
  return (
    new RegExp(`^(${POS_WORDS})\\b(?:\\[[^\\]]*\\])?\\.?\\s*$`, "i").test(l) ||
    new RegExp(`^(?:${ZH_POS_WORDS})$`).test(l)
  );
}
function stripPosPrefix(l) {
  const en = l.replace(new RegExp(`^(${POS_WORDS})\\b\\.?\\s*`, "i"), "");
  if (en !== l) return en;
  return l.replace(
    new RegExp(`^(?:${ZH_POS_WORDS})(?=[^\\u4e00-\\u9fff]|$)`),
    "",
  );
}
function cleanDefinition(r, jp) {
  r = r.replace(/^\s*网络释义\s*[:：]\s*/, "");
  r = r.replace(/^\s*\d+[.、)）]\s*/, "");
  let prev;
  do {
    prev = r;
    r = r.replace(/^\s*[（(][^）)]*[）)]\s*/, "");
  } while (r !== prev);
  if (jp || /[一-龥぀-ヿ]/.test(r)) {
    r = r.split(/[:：;；|、,，\s]+/)[0].trim();
  } else {
    r = r.split(/[;；|]/)[0].trim();
  }
  r = r.replace(/\s*[(（][^)）]+[)）]\s*/g, " ").replace(/\s+/g, " ").trim();
  return r;
}
function extractFirstDefinition(dict, service) {
  if (!dict) return "";
  const svc = String(service || "").toLowerCase();
  const lines = dict.replace(/\r/g, "").split("\n").map((l) => l.trim());
  if (svc.includes("weblio")) {
    for (const l of lines) {
      if (!l) continue;
      const m = l.match(/^意味[・·]対訳\s*(.*)$/);
      if (m) {
        const rest = m[1].replace(/^[:：;；|、,，\s]+/, "").trim();
        if (rest) return cleanDefinition(rest, true);
        continue;
      }
      if (l === "コア" || /^項目/.test(l) || /^[a-z]+\//i.test(l)) continue;
      if (/[ぁ-んァ-ヶ]/.test(l)) return cleanDefinition(l, true);
    }
    return "";
  }
  let candidate = "";
  for (const l of lines) {
    if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
    if (/^\d+[.、)）]\s+[A-Za-z]/.test(l)) continue;
    const stripped = stripPosPrefix(l);
    if (/[一-龥]/.test(stripped) && !/^[A-Za-z]/.test(stripped)) {
      candidate = l;
      break;
    }
  }
  if (!candidate) {
    for (const l of lines) {
      if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
      if (/[一-龥]/.test(l)) { candidate = l; break; }
    }
  }
  if (!candidate) {
    for (const l of lines) {
      if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
      if (/^-{2,}$/.test(l)) continue;
      if (/^\[(example|audio|synonym|antonym|note)\]/i.test(l)) continue;
      candidate = l; break;
    }
  }
  if (!candidate) return "";
  let r = candidate;
  if (/[一-龥]/.test(r)) r = stripPosPrefix(r);
  else r = r.replace(/^\[[a-z]+\]\s*/i, "");
  return cleanDefinition(r, false);
}

// ── Replicate haicidict.ts HTML → data.result ──
//
// 桌面版 dict.cn HTML 结构（从 curl + UA=Firefox 实际抓取确认）：
//   <ul class="dict-basic-ul">
//     <li>
//       <strong>vbl.</strong>
//       <strong>变更；换车；兑换</strong>
//     </li>
//     <li style="padding-top: 25px;">  // 广告
//     </li>
//   </ul>
//
// haicidict.ts 逻辑：
//   querySelectorAll("ul.dict-basic-ul > li")
//   .filter(!script)
//   .map(innerText.replace(/\s+/g, " ").trim())
//   .join("\n") + "\n"
//
// jina reader 返回 markdown，HTML 结构已被转换。下面用一种更直接的
// 方式：把 jina 的 markdown 当作 HTML 源再 parse 一次（jina 的输出中
// 保留 <strong> 标签作为 **text**）—— 不，更稳的方式是直接调 fetch
// 拿 HTML。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0";

function parseHaiciHtml(html) {
  // Replicate haicidict.ts: querySelectorAll("ul.dict-basic-ul > li")
  const ulMatch = html.match(/<ul class="dict-basic-ul"[^>]*>([\s\S]*?)<\/ul>/i);
  if (!ulMatch) return null;
  const block = ulMatch[1];
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
  const items = [];
  let m;
  while ((m = liRe.exec(block))) {
    const inner = m[1];
    if (/<script\b/i.test(inner)) continue;
    // Replicate innerText: collapse whitespace, trim.
    // innerText of <strong>text</strong> = "text".
    // Combined: collapse all tags to nothing, collapse whitespace.
    const text = inner
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) items.push(text);
  }
  return items.join("\n") + "\n";
}

const tests = [
  { word: "changing", expect: "变更" },
  { word: "change", expect: "变化" },
  { word: "computer", expect: "电脑" },
  { word: "run", expect: "跑" },
  { word: "make", expect: "做" },
  { word: "fast", expect: "快的" },
  { word: "the", expect: "那" },
];

let pass = 0;
for (const t of tests) {
  const url = `https://dict.cn/${encodeURIComponent(t.word)}`;
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    if (!res.ok) {
      console.log(`  SKIP  haicidict ${t.word.padEnd(12)} HTTP ${res.status}`);
      continue;
    }
    html = await res.text();
  } catch (e) {
    console.log(`  SKIP  haicidict ${t.word.padEnd(12)} fetch err: ${e?.message || e}`);
    continue;
  }

  const dataResult = parseHaiciHtml(html);
  if (!dataResult) {
    console.log(`  SKIP  haicidict ${t.word.padEnd(12)} dict-basic-ul not in HTML`);
    continue;
  }
  const got = extractFirstDefinition(dataResult, "haicidict");
  const ok = got === t.expect;
  if (ok) pass++;
  const tag = ok ? "PASS" : "FAIL";
  console.log(
    `  ${tag}  haicidict ${t.word.padEnd(12)} ` +
      `got=${JSON.stringify(got).padEnd(30)} expect=${JSON.stringify(t.expect)}`,
  );
  if (!ok) console.log(`        ↳ data.result=${JSON.stringify(dataResult).slice(0, 120)}`);
  await sleep(300);
}
console.log(`\n${pass} passed (real haici data)`);
process.exit(pass === tests.length ? 0 : 1);
