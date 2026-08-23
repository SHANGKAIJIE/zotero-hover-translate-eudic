#!/usr/bin/env node
/**
 * Dict engine first-definition extraction end-to-end test.
 *
 * Strategy: hardcode the exact `data.result` strings that translate plugin's
 * services produce for sample words, then run the plugin's
 * `extractFirstDefinition` on them and assert the expected short definition.
 *
 * The hardcoded values mirror the real output of haicidict / collinsdict /
 * bingdict / cambridgedict / freedictionaryapi / webliodict. See
 * `docs/dict-extract-cases.md` for the trace.
 *
 * Usage:
 *   node scripts/dict_extract_test.js                # run all
 *   node scripts/dict_extract_test.js --only word1,word2
 *   node scripts/dict_extract_test.js --snapshot file.json
 *
 * Exit code 0 = all pass, 1 = any fail.
 */
import { writeFileSync } from "node:fs";

// ---------------- FIXED extraction logic ----------------
//
// This is the patched version of the block in src/modules/hoverTranslate.ts
// (lines around extractFirstDefinition, isBarePosLine, isPhoneticLine,
// cleanDefinition). The .ts file must contain the matching updated version
// when this test passes.

// 1) 扩展 POS 词表：增加海词特殊缩写 "vbl"
// 2) 新增 ZH_POS_WORDS：科林斯 / 海词中文 / 有道中文等中文版词典的词性
// 3) ZH_POS_WORDS 包含复合词性（及物动词 / 不及物动词 / 情态动词 / 系动词 等）
const POS_WORDS =
  "linkv|attrib|auxv|interrog|interj|prefix|suffix|abbr|modal|modv|phr|idm|comb|pref|suff|sing|pl|pred|na|noun|verb|adjective|adverb|preposition|conjunction|pronoun|interjection|article|determiner|numeral|quantifier|symbol|n|vt|vi|adj|adv|a|ad|prep|conj|pron|int|art|aux|det|num|qua|sym|v|verbal|adverbial|prepositional|conjunctional|pronounal" +
  // 海词特殊缩写（vbl = verbal，<strong>vbl.</strong> 出现在 ul.dict-basic-ul > li）
  "|vbl";

const ZH_POS_WORDS =
  // 中文词性（科林斯 en-zh、海词中文释义、有道中文词典 等）
  "形容词|副词|动词|名词|介词|连词|代词|数词|量词|助词|叹词|助动词|象声词|拟声词|语气词|区别词|方位词|词缀|前缀|后缀|缩略语|简称" +
  // 复合中文词性（科林斯常用"及物动词"/"不及物动词"/"动词短语"独立成行）
  "|及物动词|不及物动词|情态动词|系动词|短语动词|动词短语|名词短语|形容词短语|副词短语|介词短语|固定搭配|派生词|派生|习语|例句|词组|短语|俚语|同义词|反义词|近义词|同根词|变形|变位";

/**
 * 纯 IPA 音标行（无前缀、无括号）的字符白名单：
 *   字母 + IPA 符号 + 基础标点 (空格、逗号、句点、分号、冒号、连字符)
 * 用于让 FreeDictAPI / Cambridge 的纯 IPA 音标行（如 "həˈloʊ,hɛˈloʊ"）
 * 通过 isPhoneticLine 检测。英文句子/定义含 "/" 等字符会被排除。
 */
const IPA_LINE_CHARS = "a-zA-Z\\u0250-\\u02AF\\u02B0-\\u02FF\\u0300-\\u036F,.;:\\s-";

function isPhoneticLine(l) {
  return (
    // 英 [...] / 美 [...] / uk /.../ / us /.../
    /^(英|美)\s*[\[/(]/.test(l) ||
    /^(uk|us)\s*[/'\[(]/.test(l) ||
    // /ˈ.../、[ˈ...]、(ˈ.../) 音标行
    (/^[/\[(]/.test(l) &&
      /[ˈˌəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑɝɚɘɵɤɨ]/.test(l)) ||
    // "uk ˈkɒmpjʊtə" 等"语言前缀 + 音标"形式
    (/^[a-z]+ /i.test(l) &&
      /[ˈˌəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑ]/.test(l) &&
      !/[一-龥]/.test(l)) ||
    // 纯 IPA 行（FreeDictAPI 的 "həˈloʊ,hɛˈloʊ" / 剑桥的 "kæt"）
    // 条件：行仅由字母+IPA+基础标点组成，且至少含一个 IPA 字符，无中文，
    //       无句末标点，长度 < 80（避免误判长英文句子）
    new RegExp(`^[${IPA_LINE_CHARS}]+$`, "i").test(l) &&
      /[ˈˌəɜɪʊɔɒæɛʌθðʃʒŋɡʔɑɝɚɘɵɤɨ]/.test(l) &&
      !/[一-龥]/.test(l) &&
      !/[.!?]$/.test(l) &&
      l.length < 80
  );
}

function isBarePosLine(l) {
  return (
    // 英文 POS 整行（"n."、"verb"、"noun[C]"、"adj[comp]"）
    new RegExp(`^(${POS_WORDS})\\b(?:\\[[^\\]]*\\])?\\.?\\s*$`, "i").test(l) ||
    // 中文 POS 整行（"形容词"、"动词"、含 [count] 等可数性标记）
    new RegExp(`^(?:${ZH_POS_WORDS})(?:\\[[^\\]]*\\])?\\s*$`).test(l)
  );
}

/** 剥离行首 POS 前缀（英文 + 中文），同时消费紧随其后的 [bracket] 标记（如科林斯 [count]）。 */
function stripPosPrefix(l) {
  // 英文 POS：word boundary, optional [bracket], optional dot, optional space
  const en = l.replace(new RegExp(`^(${POS_WORDS})\\b(?:\\[[^\\]]*\\])?\\.?\\s*`, "i"), "");
  if (en !== l) return en;
  // 中文 POS：中文无 \b，可选 [bracket]，可选空格
  return l.replace(
    new RegExp(`^(?:${ZH_POS_WORDS})(?:\\[[^\\]]*\\])?\\s*`),
    "",
  );
}

function cleanDefinition(r, jp) {
  r = r.replace(/^\s*网络释义\s*[:：]\s*/, "");
  r = r.replace(/^\s*\d+[.、)）]\s*/, "");

  // 剥离行首括号/方括号注释（科林斯的例句 "(world, attitudes, role)"、
  // 标签 "(COMPUTING)"、可数性标记 "[count]"/"[count or uncount]" 等）。
  let prev;
  do {
    prev = r;
    r = r.replace(/^\s*[（(\[【][^）)\]】]*[）)\]】]\s*/, "");
  } while (r !== prev);

  if (jp || /[一-龥぀-ヿ]/.test(r)) {
    r = r.split(/[:：;；|、,，\s]+/)[0].trim();
  } else {
    r = r.split(/[;；|]/)[0].trim();
  }
  r = r.replace(/\s*[(（\[][^)）\]]+[)）\]]\s*/g, " ").replace(/\s+/g, " ").trim();
  return r;
}

function extractFirstDefinition(dict, service) {
  if (!dict) return "";
  const svc = String(service || "").toLowerCase();
  const lines = dict.replace(/\r/g, "").split("\n").map((l) => l.trim());

  // Weblio（en-ja）专用：标题「意味・対訳」后可能直接接全部释义
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
  // 1. zh 词典：第一个「剥 POS 前缀后行首是中文」的定义行
  for (const l of lines) {
    if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
    if (/^\d+[.、)）]\s+[A-Za-z]/.test(l)) continue;
    const stripped = stripPosPrefix(l);
    if (/[一-龥]/.test(stripped) && !/^[A-Za-z]/.test(stripped)) {
      candidate = l;
      break;
    }
  }
  // 2. 兜底：第一个含中文的行
  if (!candidate) {
    for (const l of lines) {
      if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
      if (/[一-龥]/.test(l)) {
        candidate = l;
        break;
      }
    }
  }
  // 3. 无中文：第一个非音标/非词性/非噪音行
  if (!candidate) {
    for (const l of lines) {
      if (!l || isPhoneticLine(l) || isBarePosLine(l)) continue;
      if (/^-{2,}$/.test(l)) continue;
      if (/^\[(example|audio|synonym|antonym|note)\]/i.test(l)) continue;
      candidate = l;
      break;
    }
  }
  if (!candidate) return "";

  let r = candidate;
  if (/[一-龥]/.test(r)) {
    r = stripPosPrefix(r);
  } else {
    r = r.replace(/^\[[a-z]+\]\s*/i, "");
  }
  return cleanDefinition(r, false);
}

// ---------------- Test cases (hardcoded data.result) ----------------

const cases = [
  // ───── 海词 haicidict ─────
  {
    service: "haicidict",
    word: "changing",
    result: "vbl. 变更；换车；兑换\n",
    expect: "变更",
    note: "REPORTED BUG: 'vbl.' POS not in POS_WORDS",
  },
  {
    service: "haicidict",
    word: "change",
    result: "n. 变化；零钱\nv. 改变\n",
    expect: "变化",
    note: "海词 change: 多个 li，'n.'/'v.' bare POS 行被 pass 1 skip",
  },
  {
    service: "haicidict",
    word: "computer",
    result: "n. 电脑；电子计算机\n",
    expect: "电脑",
    note: "海词 computer: 'n. 电脑'",
  },
  {
    service: "haicidict",
    word: "run",
    result: "vi. 跑；运转\nn. 奔跑；跑步\nv. 运行；运转\n",
    expect: "跑",
    note: "海词 run: 三个 li，pass 2 取第一个含中文行",
  },
  {
    service: "haicidict",
    word: "make",
    result: "v. 做；制造；使得；赚（钱）；成功；达成\nn. 性格；式样；制造；生产量\n",
    expect: "做",
    note: "海词 make 实际：'v. 做；制造...' 首义是 '做'",
  },
  {
    service: "haicidict",
    word: "do",
    result: "v. 做；执行；完成\naux. 助动词；辅助\nn. 事件；社交活动\n",
    expect: "做",
    note: "海词 do: 多个 li",
  },
  // ───── 科林斯 collinsdict ─────
  {
    service: "collinsdict",
    word: "changing",
    result:
      "形容词\n(world, attitudes, role)日新月异的 [rì xīn yuè yì de]",
    expect: "日新月异的",
    note: "REPORTED BUG: '形容词' not in POS_WORDS",
  },
  {
    service: "collinsdict",
    word: "computer",
    result: "名词\n(COMPUTING) 电脑 [diàn nǎo]",
    expect: "电脑",
    note: "科林斯 computer: leading paren '(COMPUTING)' to strip",
  },
  {
    service: "collinsdict",
    word: "run",
    result: "动词\n1. 跑；奔跑\n2. 经营；管理\n名词\n1. 跑步；奔跑",
    expect: "跑",
    note: "科林斯 run: 多义项，跳过 '1. 跑' digit prefix",
  },
  {
    service: "collinsdict",
    word: "make",
    result: "动词\n1. 做；制造\n2. 制作；使\n名词\n1. 制造；构造",
    expect: "做",
    note: "科林斯 make: digit prefix '1.' stripped, 取 '做'",
  },
  // ───── 必应 bingdict ─────
  {
    service: "bingdict",
    word: "computer",
    result: "n. 电脑；计算机；电子计算机\n网络释义:计算机;个人电脑;服务器",
    expect: "电脑",
    note: "必应 computer",
  },
  {
    service: "bingdict",
    word: "run",
    result: "v. 跑；奔跑；运行\nn. 跑步；奔跑；运行",
    expect: "跑",
    note: "必应 run",
  },
  // ───── 剑桥 cambridgedict ─────
  {
    service: "cambridgedict",
    word: "run",
    result:
      "verb\n\t1.guideword to move quickly\n\t\t跑，奔跑\n\t2.guideword to operate\n\t\t运行",
    expect: "跑",
    note: "剑桥 run: skip '1.guideword' line (数字+点+英文)",
  },
  // ───── FreeDictionaryAPI ─────
  {
    service: "freedictionaryapi",
    word: "hello",
    result:
      "həˈloʊ,hɛˈloʊ\n[interjection] used as a greeting\n[example] hello, everyone\n----\n[noun] an expression of greeting",
    expect: "used as a greeting",
    note: "FreeDictAPI hello: 'həˈloʊ,hɛˈloʊ' 纯 IPA 音标行需识别为音标",
  },
  {
    service: "freedictionaryapi",
    word: "run",
    result:
      "[verb] move at a pace faster than a walk\n[example] she ran across the road\n----\n[noun] an act of running",
    expect: "move at a pace faster than a walk",
    note: "FreeDictAPI run: '[verb] ...'",
  },
  // ───── Weblio webliodict (en-ja) ─────
  {
    service: "webliodict",
    word: "change",
    result:
      "意味・対訳:変化 変更 両替 釣り銭 異変 推移 変色 異動 変遷 為替",
    expect: "変化",
    note: "Weblio change: 专用提取",
  },
  // ───── 额外 edge case ─────
  {
    service: "collinsdict",
    word: "beautiful",
    result:
      "形容词\n(very) 美丽的；漂亮的\n[example] a beautiful day",
    expect: "美丽的",
    note: "科林斯 beautiful: leading '(very)' stripped → 取 '美丽的'",
  },
  {
    service: "haicidict",
    word: "good",
    result: "adj. 好的；良好的\nn. 好处；善良\nadv. 好\n",
    expect: "好的",
    note: "海词 good: 多 POS，取 'adj. 好的' 第一释义",
  },
  {
    service: "bingdict",
    word: "hello",
    result: "int. 喂；你好\nn. 招呼；问候\n网络释义:哈啰;你好;hello",
    expect: "喂",
    note: "必应 hello: 'int. 喂'",
  },
  {
    service: "cambridgedict",
    word: "hello",
    result: "interjection\n\t1.used as a greeting\n\t\t（打招呼用语）喂；你好",
    expect: "喂",
    note: "剑桥 hello: 'interjection' POS 行，pass 1 取 '1.used' 跳过（数字+点+英文）取下一条",
  },
  // ───── 边界用例 (edge cases) ─────
  {
    service: "haicidict",
    word: "computer",
    result: "n. 电脑；计算机\n",
    expect: "电脑",
    note: "海词 computer 真实单 li 格式",
  },
  {
    service: "haicidict",
    word: "fast",
    result: "adj. 快的；迅速的；敏捷的\nadv. 快；迅速地\nn. 禁食；斋戒\n",
    expect: "快的",
    note: "海词 fast: 三 POS（adj./adv./n.），取首条 '快的'",
  },
  {
    service: "collinsdict",
    word: "beautiful",
    result: "形容词\n(very) 美丽的；漂亮的\n[example] a beautiful day",
    expect: "美丽的",
    note: "科林斯 beautiful: leading '(very)' stripped",
  },
  {
    service: "collinsdict",
    word: "fast",
    result: "形容词\n(quick) 快的；迅速的\n副词\n(quickly) 快地；迅速地",
    expect: "快的",
    note: "科林斯 fast: 跳过 '形容词'/'副词' POS 行，取首条中文",
  },
  {
    service: "bingdict",
    word: "fast",
    result: "adj. 快的；迅速的；敏捷的\nadv. 快；迅速地\nn. 禁食；斋戒",
    expect: "快的",
    note: "必应 fast: 多 POS，取首条",
  },
  {
    service: "bingdict",
    word: "world",
    result: "n. 世界；地球；领域\n网络释义:世界;领域;全世界",
    expect: "世界",
    note: "必应 world: 'n. 世界' 优先于网络释义",
  },
  {
    service: "cambridgedict",
    word: "fast",
    result: "adjective\n\t1.moving quickly\n\t\t快的，迅速的\n\t2.taking a short time\n\t\t迅速的",
    expect: "快的",
    note: "剑桥 fast: skip 数字+英文行，取中文释义",
  },
  {
    service: "freedictionaryapi",
    word: "world",
    result: "wɜːrld\n[noun] the earth, together with all of its countries and peoples",
    expect: "the earth, together with all of its countries and peoples",
    note: "FreeDictAPI world: 纯 IPA 行 'wɜːrld' 识别为音标，取 [noun] 定义",
  },
  // ───── 退化用例 (regression) ─────
  {
    service: "haicidict",
    word: "the",
    result:
      "art. 那；这；这些；那些\nadv. （用于比较级前）更加；用于最高级前；(用于形容词、副词比较级前)越 ... 越 ...\n",
    expect: "那",
    note: "海词 the 实际：'art. 那；这；...' 首义是 '那'（海词把 '那' 放最前）",
  },
  {
    service: "webliodict",
    word: "hello",
    result: "意味・対訳:こんにちは こんばんは ハロー",
    expect: "こんにちは",
    note: "Weblio hello: 专用提取",
  },
  {
    service: "haicidict",
    word: "empty",
    result: "adj. 空的；空洞的\n",
    expect: "空的",
    note: "海词 empty: 'adj. 空的'",
  },
  {
    service: "collinsdict",
    word: "good",
    result:
      "形容词\n(1.satisfactory) 好的；令人满意的\n(2.well-behaved) 乖的；守规矩的",
    expect: "好的",
    note: "科林斯 good: 数字+点+中文行，去掉 '(1.satisfactory)' 取 '好的'",
  },
  // ───── 用户第二轮反馈（科林斯 POS [count] 格式） ─────
  {
    service: "collinsdict",
    word: "increase",
    result:
      "名词 [count] 增长 [zēngzhǎng]a sharp increase in productivity  生产率的急剧增长 [shēngchǎnlǜ de jíjù zēngzhǎng]increase of 2 per cent in the volume of sales 销售量增长了百分之二 [xiǎoshōuliàng zēngzhǎng le bǎi fēn zhī èr]",
    expect: "增长",
    note: "REPORTED BUG v2: 科林斯 'POS [count] 增长...' 需剥离 '名词 [count] '",
  },
  {
    service: "collinsdict",
    word: "waterfall",
    result: "名词 [count] 瀑布 [pùbù] (条, tiáo)",
    expect: "瀑布",
    note: "REPORTED BUG v2: 单行 '名词 [count] 瀑布'",
  },
  {
    service: "collinsdict",
    word: "predictions",
    result: "名词 [count] 预言 [yùyán] (个, gè)",
    expect: "预言",
    note: "REPORTED BUG v2: 单行 '名词 [count] 预言'",
  },
  {
    service: "collinsdict",
    word: "values",
    result:
      "名词\n1. [count or uncount] (financial worth) 价值 [jiàzhí] (种, zhǒng)\n2. [uncount] (importance) 重要性 [zhòngyàoxìng]\n3. [uncount] (worth in relation to price) 价格 [jiàgé]\n及物动词\n1. (assess the worth of) 给…估价 [gěi…gūjià]\n2. (appreciate) 重视 [zhòngshì]",
    expect: "价值",
    note: "REPORTED BUG v2: 科林斯多行+及物动词+[count or uncount] 标签",
  },
  {
    service: "collinsdict",
    word: "number",
    result:
      "名词\n1. [count] (Mathematics) 数 [shù] (个, gè)\n2. [count] (telephone number) 电话号码 [diànhuà hàomǎ] (个, gè)\n及物动词\n1. (amount to) 总计 [zǒngjì]",
    expect: "数",
    note: "REPORTED BUG v2: 科林斯 [count] (Mathematics) 数 需剥掉 [count]",
  },
  {
    service: "collinsdict",
    word: "look",
    result:
      "动词\n1. [I,T] (see) 看 [kàn]\n2. [I] (seem) 看起来 [kàn qǐlái]\n名词\n[singular] (look) 表情 [biǎoqíng]",
    expect: "看",
    note: "科林斯 look: 动词 [I,T] (see) 看 → 剥掉 [I,T] (see) 取 '看'",
  },
  // ───── 边界：POS 与 [bracket] 无空格 ─────
  {
    service: "collinsdict",
    word: "increase_nospace",
    result: "名词[count] 增长 [zēngzhǎng]a sharp increase in productivity  生产率的急剧增长",
    expect: "增长",
    note: "科林斯 'POS[count]'（POS 和 [ 之间无空格）需正确剥离",
  },
  {
    service: "collinsdict",
    word: "english",
    result: "名词[U] (subject) 英语 [yīngyǔ]\n形容词 (relating to England) 英格兰的 [yīnggélán de]",
    expect: "英语",
    note: "科林斯 '名词[U] (subject) 英语' — 复合 [U] 可数性标记",
  },
  // ───── 边界：复合中文 POS ─────
  {
    service: "collinsdict",
    word: "wake",
    result: "动词短语\n1. (stop sleeping) 醒来 [xǐnglái]\n2. (cause to stop sleeping) 唤醒 [huànxǐng]",
    expect: "醒来",
    note: "科林斯 '动词短语' 作为整行 POS（复合中文 POS）",
  },
  {
    service: "collinsdict",
    word: "depend",
    result: "不及物动词\n1. (rely) 依赖 [yīlài]\n2. (vary) 取决于 [qǔjuéyú]",
    expect: "依赖",
    note: "科林斯 '不及物动词' 复合中文 POS 行",
  },
];

// ---------------- Test harness ----------------

const onlyIdx = process.argv.indexOf("--only");
const onlyWords = onlyIdx >= 0 ? process.argv[onlyIdx + 1].split(",") : null;
const snapIdx = process.argv.indexOf("--snapshot");
const snapshotPath = snapIdx >= 0 ? process.argv[snapIdx + 1] : null;

const results = [];
for (const c of cases) {
  if (onlyWords && !onlyWords.includes(c.word)) continue;
  const got = extractFirstDefinition(c.result, c.service);
  const pass = got === c.expect;
  results.push({ ...c, got, pass });
}

let pass = 0;
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  if (r.pass) pass++;
  console.log(
    `  ${tag}  ${r.service.padEnd(20)} ${r.word.padEnd(12)} ` +
      `got=${JSON.stringify(r.got).padEnd(40)} expect=${JSON.stringify(r.expect)}`,
  );
  if (!r.pass) console.log(`        ↳ ${r.note}`);
}

console.log(`\n${pass}/${results.length} passed`);

if (snapshotPath) {
  writeFileSync(
    snapshotPath,
    JSON.stringify({ ts: new Date().toISOString(), results }, null, 2),
  );
  console.log(`Snapshot saved to ${snapshotPath}`);
}

process.exit(pass === results.length ? 0 : 1);
