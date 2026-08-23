#!/usr/bin/env node
/**
 * 端到端验证：使用 jina reader 拉取科林斯 en-zh 真实页面，
 * 模拟 collinsdict.ts 的 .hom innerText 解析，
 * 跑修复后的 extractFirstDefinition。
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
      candidate = l; break;
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

// ── Replicate collinsdict.ts ──
//
// collinsdict.ts: `Array.prototype.map.call(doc.querySelectorAll(".hom"),
//   e => e.innerText.replace(/&nbsp;/g, " ").replace(/[0-9]\./g, "\n$&"))`
// .join("") → data.result
//
// jina reader 返回 markdown。需要用一种稳定方式把 markdown 反向解析为
// collins 的 result 格式：先识别"形容词/名词/动词"行作为 POS 行，识别
// "(...)日新月异的 [rì xīn yuè yì de]" 作为定义行，识别"1./2."作为义项序号。

function parseCollinsJinaMd(md) {
  // Split the relevant "translation block" — jina 把它渲染为：
  //   [tʃeɪndʒɪŋ](link)  ← 音标行
  //   形容词               ← POS 行
  //   (world, attitudes, role)日新月异的 [rì xīn yuè yì de]  ← 定义行
  //   包括 的例句          ← 标题
  //   ...
  // Strategy: extract the POS line and the definition line that follows
  // until "包括 的例句" or end.
  const lines = md.split("\n").map((l) => l.trim()).filter(Boolean);
  // Find first POS line
  const posRe = /^(形容词|副词|动词|名词|介词|连词|代词|数词|量词|助词|叹词|助动词|象声词|拟声词|语气词|区别词|方位词|词缀|前缀|后缀|缩略语|简称)$/;
  let pos = null;
  for (let i = 0; i < lines.length; i++) {
    if (posRe.test(lines[i])) { pos = lines[i]; break; }
  }
  if (!pos) return null;
  // Find definition lines after POS until "包括" or "例句"
  const defs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === pos) {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^(包括|例句|Copyright|Example|Definition)/.test(lines[j])) break;
        if (posRe.test(lines[j])) break;
        // Skip pure IPA lines (no Chinese, no English word)
        if (!/[一-龥]/.test(lines[j]) && !/[a-zA-Z]/.test(lines[j])) continue;
        defs.push(lines[j]);
      }
      break;
    }
  }
  if (defs.length === 0) return null;
  // Mirror collinsdict.ts formatting: replace [0-9]. with \n
  return pos + "\n" + defs.join("").replace(/(\d+\.)/g, "\n$1");
}

async function fetchCollinsJina(word) {
  const jinaUrl = `https://r.jina.ai/https://www.collinsdictionary.com/zh/dictionary/english-chinese/${encodeURIComponent(word)}`;
  const res = await fetch(jinaUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  return await res.text();
}

const tests = [
  { word: "changing", expect: "日新月异的" },
  { word: "computer", expect: "电脑" },
  { word: "run", expect: "跑" },
  { word: "make", expect: "做" },
  { word: "hello", expect: "你好" },
  { word: "beautiful", expect: "美丽的" },
  { word: "fast", expect: "快的" },
];

let pass = 0;
for (const t of tests) {
  const md = await fetchCollinsJina(t.word);
  if (!md) {
    console.log(`  SKIP  collinsdict ${t.word.padEnd(12)} jina fetch failed`);
    continue;
  }
  const dataResult = parseCollinsJinaMd(md);
  if (!dataResult) {
    console.log(`  SKIP  collinsdict ${t.word.padEnd(12)} parse failed`);
    continue;
  }
  const got = extractFirstDefinition(dataResult, "collinsdict");
  const ok = got === t.expect;
  if (ok) pass++;
  const tag = ok ? "PASS" : "FAIL";
  console.log(
    `  ${tag}  collinsdict ${t.word.padEnd(12)} ` +
      `got=${JSON.stringify(got).padEnd(30)} expect=${JSON.stringify(t.expect)}`,
  );
  if (!ok) {
    console.log(`        ↳ data.result=${JSON.stringify(dataResult).slice(0, 200)}`);
  }
  await sleep(800);
}
console.log(`\n${pass} passed (real collins data via jina reader)`);
process.exit(pass === tests.length ? 0 : 1);
