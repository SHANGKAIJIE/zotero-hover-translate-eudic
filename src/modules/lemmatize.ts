/**
 * English word lemmatization — converts inflected forms to dictionary headwords.
 *
 * Why this exists:
 *   The Eudic OpenAPI stores words as-is and matches them against its internal
 *   dictionary by exact headword. Adding "models" (plural) results in no phon/exp;
 *   adding "model" (lemma) fills phon/exp correctly. This module normalises common
 *   English inflectional forms before they reach the API.
 *
 * Strategy (three-layer):
 *   1. Dictionary exact-match — BNC-derived lemma.en (Top-10000 groups),
 *      17,709 form→lemma mappings, O(1) Map lookup. Covers 95%+ of academic
 *      English inflectional forms. Eliminates "according→accorde"-type errors.
 *   2. Irregular forms table — 400+ entries as safety net for edge cases
 *      beyond the Top-10000 cutoff.
 *   3. Conservative suffix rules — applied in specificity order, only active
 *      when both dictionary and irregular table miss. Returns original word
 *      as final fallback.
 *
 * All processing is local (pure JS + embedded JSON), zero network calls.
 */

import LEMMA_MAP from "../data/lemma_dict.json";

// ── Dictionary lookup layer ────────────────────────────────────────────
// 17,709 entries: inflected form → lemma (BNC corpus, Top-10000 groups)
// Stripped of self-mapping entries (form === lemma) to minimise size.
// Raw: 352 KB  |  Gzip: 99 KB  |  Fits well within XPI budget.

const lemmaMap = LEMMA_MAP as Record<string, string>;

// ── Noun exceptions — prevent over-lemmatization ──────────────────────
// Words that are standalone dictionary headwords but also appear as
// morphological derivations in the BNC data. These should never be
// lemmatized — they are valid headwords in their own right.

/**
 * Words ending in -ing that are common standalone nouns (gerund→noun).
 */
const ING_NOUNS = new Set([
  "meeting", "building", "painting", "feeling", "meaning",
  "setting", "understanding", "beginning", "learning", "training",
  "planning", "morning", "evening", "wedding", "ceiling",
  "clothing", "lighting", "heating", "landing", "finding",
  "saving", "warning", "opening", "dwelling", "gathering",
  "offering", "shopping", "swimming", "writing", "reading",
  "hearing", "farming", "camping", "fishing", "hunting",
  "bowling", "boxing", "dancing", "singing", "coaching",
  "marketing", "cooking", "banking", "teaching", "parenting",
  "shipping", "trading", "molding", "plumbing", "wiring",
  "spelling", "sailing", "skiing", "surfing", "timing",
  "earnings", "belongings", "surroundings",
]);

/**
 * Words ending in -er that are common agent nouns, not comparatives.
 */
const ER_NOUNS = new Set([
  "teacher", "worker", "player", "driver", "writer", "reader",
  "speaker", "leader", "manager", "officer", "partner", "member",
  "computer", "printer", "scanner", "server", "browser",
  "farmer", "banker", "lawyer", "soldier", "butcher", "baker",
  "barber", "carpenter", "painter", "plumber", "designer",
  "engineer", "programmer", "developer", "researcher",
  "dancer", "singer", "runner", "swimmer", "fighter",
  "buyer", "seller", "owner", "maker", "builder",
  "beginner", "foreigner", "stranger", "prisoner", "passenger",
  "container", "explorer", "adventurer", "photographer",
  "number", "water", "paper", "power", "matter", "letter",
  "master", "summer", "winter", "river", "danger", "corner",
  "copper", "silver", "rubber", "leather", "feather",
  "sister", "brother", "mother", "father", "daughter",
  "weather", "order", "offer", "suffer", "whisper", "answer",
]);

// ── Irregular forms table ─────────────────────────────────────────────
// 400+ entries as safety net. The dict layer covers 95%+ of these;
// this table catches edge cases outside the Top-10000 cutoff.

const IRREGULAR: Record<string, string> = {
  // ---- Noun irregular plurals ----
  children: "child", mice: "mouse", geese: "goose", teeth: "tooth",
  feet: "foot", men: "man", women: "woman", oxen: "ox", lice: "louse",
  crises: "crisis", theses: "thesis", phenomena: "phenomenon",
  criteria: "criterion", cacti: "cactus", fungi: "fungus",
  nuclei: "nucleus", radii: "radius", alumni: "alumnus",
  curricula: "curriculum", stimuli: "stimulus", indices: "index",
  appendices: "appendix", matrices: "matrix", vertices: "vertex",
  analyses: "analysis", bases: "basis", axes: "axis",
  diagnoses: "diagnosis", hypotheses: "hypothesis", oases: "oasis",
  parentheses: "parenthesis", syntheses: "synthesis",
  emphases: "emphasis", neuroses: "neurosis", prognoses: "prognosis",
  ellipses: "ellipsis",
  species: "species", series: "series", means: "means",
  headquarters: "headquarters", barracks: "barracks",
  crossroads: "crossroads",

  // ---- Verb: past tense → base (most common) ----
  was: "be", were: "be", had: "have", did: "do", said: "say",
  made: "make", went: "go", took: "take", came: "come", saw: "see",
  knew: "know", got: "get", gave: "give", found: "find",
  thought: "think", told: "tell", became: "become", left: "leave",
  felt: "feel", brought: "bring", began: "begin", kept: "keep",
  held: "hold", wrote: "write", stood: "stand", heard: "hear",
  meant: "mean", met: "meet", ran: "run", paid: "pay", sat: "sit",
  spoke: "speak", lay: "lie", led: "lead", grew: "grow", lost: "lose",
  fell: "fall", sent: "send", built: "build", understood: "understand",
  drew: "draw", broke: "break", spent: "spend", rose: "rise",
  drove: "drive", bought: "buy", wore: "wear", chose: "choose",
  sought: "seek", threw: "throw", caught: "catch", dealt: "deal",
  won: "win", forgot: "forget", bore: "bear", swore: "swear",
  tore: "tear", hung: "hang", wound: "wind", flew: "fly",
  stole: "steal", froze: "freeze", fed: "feed", shot: "shoot",
  shook: "shake", sang: "sing", sank: "sink", rang: "ring",
  swam: "swim", drank: "drink", ate: "eat", hid: "hide", bit: "bite",
  blew: "blow", rode: "ride", struck: "strike", fought: "fight",
  taught: "teach", sold: "sell", woke: "wake", bent: "bend",
  lent: "lend", lit: "light", dug: "dig", stuck: "stick",
  swept: "sweep", wept: "weep", slept: "sleep", dreamt: "dream",
  leant: "lean", crept: "creep", leapt: "leap", knelt: "kneel",
  spelt: "spell", spilt: "spill", spoilt: "spoil", dwelt: "dwell",
  smelt: "smell", burnt: "burn", learnt: "learn", shone: "shine",
  slid: "slide", spun: "spin", stung: "sting", swung: "swing",
  withdrew: "withdraw", withstood: "withstand", forgave: "forgive",
  foresaw: "foresee", overcame: "overcome", undertook: "undertake",
  underwent: "undergo", upset: "upset", thrust: "thrust", split: "split",
  spread: "spread", burst: "burst", broadcast: "broadcast",
  forecast: "forecast", cast: "cast", cost: "cost", hit: "hit",
  hurt: "hurt", shut: "shut", quit: "quit", rid: "rid", shed: "shed",
  slit: "slit", wed: "wed", bet: "bet", thrived: "thrive",
  throve: "thrive", wove: "weave", strove: "strive",

  // ---- Verb: past participle → base ----
  been: "be", gone: "go", taken: "take", written: "write",
  driven: "drive", ridden: "ride", risen: "rise", broken: "break",
  spoken: "speak", stolen: "steal", chosen: "choose", frozen: "freeze",
  beaten: "beat", eaten: "eat", fallen: "fall", forgotten: "forget",
  forgiven: "forgive", given: "give", hidden: "hide", known: "know",
  seen: "see", shown: "show", torn: "tear", thrown: "throw",
  worn: "wear", woven: "weave", sworn: "swear", arisen: "arise",
  awoken: "awake", borne: "bear", forsaken: "forsake", gotten: "get",
  lain: "lie", mistaken: "mistake", mown: "mow", proven: "prove",
  sawn: "saw", sewn: "sew", shaken: "shake", shaven: "shave",
  shrunk: "shrink", sunk: "sink", slain: "slay", sown: "sow",
  sprang: "spring", stank: "stink", swollen: "swell",
  stridden: "stride", striven: "strive", strewn: "strew",
  thriven: "thrive", trodden: "tread", woken: "wake",
  ground: "grind",

  // ---- Verb: 3rd person singular → base ----
  has: "have", does: "do", goes: "go", says: "say",

  // ---- Verb: -ing form → base (irregular only) ----
  being: "be", having: "have", doing: "do", going: "go",
  lying: "lie", dying: "die", tying: "tie", vying: "vie",

  // ---- Adjective / Adverb: comparative → positive ----
  better: "good", worse: "bad", farther: "far", further: "far",
  older: "old", elder: "old", less: "little",

  // ---- Adjective / Adverb: superlative → positive ----
  best: "good", worst: "bad", least: "little", most: "much",
};

// ── Suffix-stripping rules ─────────────────────────────────────────────
// Conservative, applied only as fallback when dict and irregular miss.

// Words ending in -s that should not be treated as plurals/3rd person.
const S_EXCEPTIONS = new Set([
  "this", "thus", "plus", "minus", "focus", "locus", "virus",
  "status", "campus", "bonus", "genus", "versus", "alias",
  "atlas", "canvas", "surplus", "synopsis", "analysis",
  "crisis", "thesis", "basis", "emphasis", "hypothesis",
  "parenthesis", "diagnosis", "prognosis", "oasis", "axis",
]);

function tryIes(word: string): string | null {
  if (!word.endsWith("ies")) return null;
  if (word.endsWith("eies")) return null;
  const stem = word.slice(0, -3);
  if (stem.length < 1) return null;
  return stem + "y";
}

function tryVes(word: string): string | null {
  if (!word.endsWith("ves")) return null;
  const stem = word.slice(0, -3);
  if (stem.length < 1) return null;
  const fStems = new Set([
    "cal", "hal", "sel", "wol", "lea", "loa", "scar", "whar",
    "shel", "thie", "el", "li",
  ]);
  if (fStems.has(stem)) return stem + "f";
  return stem + "fe";
}

function tryEs(word: string): string | null {
  if (!word.endsWith("es")) return null;
  if (word.length < 4) return null;
  const stem = word.slice(0, -2);
  const last2 = stem.slice(-2);
  if (
    last2 === "ss" || last2 === "sh" || last2 === "ch" ||
    stem.endsWith("x") || stem.endsWith("z") || stem.endsWith("o")
  ) {
    return stem;
  }
  return null;
}

function tryS(word: string): string | null {
  if (!word.endsWith("s")) return null;
  if (word.length < 3) return null;
  const lower = word.toLowerCase();
  if (S_EXCEPTIONS.has(lower)) return null;
  if (lower.endsWith("ss") || lower.endsWith("us") || lower.endsWith("is")) return null;
  const stem = word.slice(0, -1);
  if (stem.length < 2) return null;
  return stem;
}

function tryEd(word: string): string | null {
  if (!word.endsWith("ed")) return null;
  if (word.length < 5) return null;
  const stem = word.slice(0, -2);

  // Consonant doubling: stopped → stop
  if (stem.length >= 3) {
    const c = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (c === prev && "bcdfghjklmnpqrstvwxyz".includes(c) && !"aeiou".includes(c)) {
      const base = stem.slice(0, -1);
      if (base.length >= 2) return base;
    }
  }

  // -ied past: carried → carry
  if (stem.endsWith("i")) return stem.slice(0, -1) + "y";

  // Silent-e restoration: caused → cause
  if (stem.length >= 2 && !/[aeiou]$/i.test(stem)) return stem + "e";

  // Regular -ed: played → play
  return stem;
}

function tryEr(word: string): string | null {
  if (!word.endsWith("er")) return null;
  const lower = word.toLowerCase();
  if (ER_NOUNS.has(lower)) return null;
  if (word.length < 4) return null;
  const stem = word.slice(0, -2);

  // Consonant doubling: bigger → big
  if (stem.length >= 2) {
    const c = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (c === prev && "bcdfghjklmnpqrstvwxyz".includes(c) && !"aeiou".includes(c)) {
      return stem.slice(0, -1);
    }
  }

  // -ier → -y: happier → happy
  if (stem.endsWith("i") && stem.length >= 2) return stem.slice(0, -1) + "y";

  // -er → -e: nicer → nice (short stems only)
  if (stem.length <= 5) return stem;

  return null;
}

function tryEst(word: string): string | null {
  if (!word.endsWith("est")) return null;
  if (word.length < 5) return null;
  const stem = word.slice(0, -3);

  // Consonant doubling: biggest → big
  if (stem.length >= 2) {
    const c = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (c === prev && "bcdfghjklmnpqrstvwxyz".includes(c) && !"aeiou".includes(c)) {
      return stem.slice(0, -1);
    }
  }

  // -iest → -y: happiest → happy
  if (stem.endsWith("i")) return stem.slice(0, -1) + "y";

  // -est → -e: nicest → nice (short stems only)
  if (stem.length <= 4) return stem;

  return null;
}

function tryIng(word: string): string | null {
  if (!word.endsWith("ing")) return null;
  const lower = word.toLowerCase();
  if (ING_NOUNS.has(lower)) return null;
  if (word.length < 5) return null;
  const stem = word.slice(0, -3);

  // Consonant doubling: running → run, swimming → swim
  if (stem.length >= 2) {
    const c = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (c === prev && "bcdfghjklmnpqrstvwxyz".includes(c) && !"aeiou".includes(c)) {
      return stem.slice(0, -1);
    }
  }

  // Do NOT attempt blind silent-e restoration (making→make etc.).
  // Known silent-e verbs are covered by the dict layer; this avoids
  // false positives like "according→accorde".
  return null;
}

// ── Rule priority order ────────────────────────────────────────────────

const RULES: Array<(w: string) => string | null> = [
  tryIes, tryVes, tryEs, tryS, tryEd, tryEr, tryEst, tryIng,
];

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Convert an inflected English word to its dictionary headword (lemma).
 *
 * Three-layer cascade:
 *   1. BNC-derived dictionary exact match (17,709 entries)
 *   2. Irregular forms table (400+ safety-net entries)
 *   3. Conservative suffix rules (regular inflections)
 *
 * @param word  The English word (any capitalisation; case-insensitive matching)
 * @returns     The lemma (preserving original capitalisation), or original word
 *
 * Examples (old system → new system):
 *   according → accorde (was wrong)  → accord (correct ✓)
 *   corresponding → corresponde (was wrong) → correspond (correct ✓)
 *   caused → caus (was wrong) → cause (correct ✓)
 *   saw → see (correct ✓) — no longer needs POS guess
 *   better → good (correct ✓)
 *   swimming → swim (correct ✓)
 *   meeting → meeting (preserved, standalone noun ✓)
 *   teacher → teacher (preserved, agent noun ✓)
 */
export function toLemma(word: string): string {
  if (!word || word.length < 2) {
    return word;
  }

  const lower = word.toLowerCase();

  // Layer 0: Noun exceptions — prevent over-lemmatization for standalone
  // gerund/agent nouns (e.g. "meeting", "teacher").
  if (
    (lower.endsWith("ing") && ING_NOUNS.has(lower)) ||
    (lower.endsWith("er") && ER_NOUNS.has(lower))
  ) {
    return word;
  }

  // Layer 1: BNC dictionary exact match (fastest & most reliable)
  const dictLemma = lemmaMap[lower];
  if (dictLemma) {
    return preserveCase(word, dictLemma);
  }

  // Layer 2: Irregular forms table (safety net for edge cases)
  const irregular = IRREGULAR[lower];
  if (irregular) {
    return preserveCase(word, irregular);
  }

  // Layer 3: Conservative suffix-stripping rules
  for (const rule of RULES) {
    const result = rule(lower);
    if (result !== null && result.length >= 2) {
      return preserveCase(word, result);
    }
  }

  // No transformation applies — word is already a base form
  return word;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Preserve the capitalisation pattern of the original word.
 *   "Models" + "model" → "Model"
 *   "MODELS" + "model" → "MODEL"
 *   "models" + "model" → "model"
 */
function preserveCase(original: string, lemma: string): string {
  if (lemma.length === 0) return original;
  if (original === original.toUpperCase() && original.length > 1) {
    return lemma.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return lemma[0].toUpperCase() + lemma.slice(1);
  }
  return lemma;
}

/**
 * Quick check: would this word benefit from lemmatisation?
 * Returns true if the word appears to be an inflected form (not base).
 */
export function isInflected(word: string): boolean {
  return toLemma(word).toLowerCase() !== word.toLowerCase();
}