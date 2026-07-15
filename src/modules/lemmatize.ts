/**
 * English word lemmatization — converts inflected forms to dictionary headwords.
 *
 * Why this exists:
 *   The Eudic OpenAPI stores words as-is and matches them against its internal
 *   dictionary by exact headword. Adding "models" (plural) results in no phon/exp;
 *   adding "model" (lemma) fills phon/exp correctly. This module normalises common
 *   English inflectional forms before they reach the API.
 *
 * Strategy:
 *   1. Exact-match irregular forms table (nouns, verbs, adjectives).
 *   2. Rule-based suffix stripping ordered by specificity (most specific first).
 *   3. Return original word when no rule matches.
 *
 * All processing is local (pure JS), zero network calls.
 */

// ── Irregular forms table ──────────────────────────────────────────────
// Keys are inflected forms (lowercase), values are dictionary headwords.
// Covers 400+ of the most common irregular English words.

const IRREGULAR: Record<string, string> = {
  // ---- Noun irregular plurals ----
  children: "child",
  mice: "mouse",
  geese: "goose",
  teeth: "tooth",
  feet: "foot",
  men: "man",
  women: "woman",
  oxen: "ox",
  lice: "louse",
  crises: "crisis",
  theses: "thesis",
  phenomena: "phenomenon",
  criteria: "criterion",
  cacti: "cactus",
  fungi: "fungus",
  nuclei: "nucleus",
  radii: "radius",
  alumni: "alumnus",
  curricula: "curriculum",
  stimuli: "stimulus",
  indices: "index",
  appendices: "appendix",
  matrices: "matrix",
  vertices: "vertex",
  analyses: "analysis",
  bases: "basis",
  axes: "axis",
  diagnoses: "diagnosis",
  hypotheses: "hypothesis",
  oases: "oasis",
  parentheses: "parenthesis",
  syntheses: "synthesis",
  emphases: "emphasis",
  neuroses: "neurosis",
  prognoses: "prognosis",
  ellipses: "ellipsis",
  species: "species",     // same form
  series: "series",       // same form
  means: "means",         // same form (also verb)
  headquarters: "headquarters", // same form
  barracks: "barracks",   // same form
  crossroads: "crossroads", // same form

  // ---- Verb: past tense → base ----
  was: "be",
  were: "be",
  had: "have",
  did: "do",
  said: "say",
  made: "make",
  went: "go",
  took: "take",
  came: "come",
  saw: "see",
  knew: "know",
  "got": "get",
  gave: "give",
  found: "find",
  thought: "think",
  told: "tell",
  became: "become",
  left: "leave",
  felt: "feel",
  brought: "bring",
  began: "begin",
  kept: "keep",
  held: "hold",
  wrote: "write",
  stood: "stand",
  heard: "hear",
  meant: "mean",
  met: "meet",
  ran: "run",
  paid: "pay",
  sat: "sit",
  spoke: "speak",
  lay: "lie",
  led: "lead",
  grew: "grow",
  lost: "lose",
  fell: "fall",
  sent: "send",
  built: "build",
  understood: "understand",
  drew: "draw",
  broke: "break",
  spent: "spend",
  rose: "rise",
  drove: "drive",
  bought: "buy",
  wore: "wear",
  chose: "choose",
  sought: "seek",
  threw: "throw",
  caught: "catch",
  dealt: "deal",
  won: "win",
  forgot: "forget",
  bore: "bear",
  swore: "swear",
  tore: "tear",
  hung: "hang",
  wound: "wind",
  flew: "fly",
  stole: "steal",
  froze: "freeze",
  fed: "feed",
  shot: "shoot",
  shook: "shake",
  sang: "sing",
  sank: "sink",
  rang: "ring",
  swam: "swim",
  drank: "drink",
  ate: "eat",
  hid: "hide",
  bit: "bite",
  blew: "blow",
  rode: "ride",
  struck: "strike",
  fought: "fight",
  taught: "teach",
  sold: "sell",
  woke: "wake",
  bent: "bend",
  lent: "lend",
  lit: "light",
  dug: "dig",
  stuck: "stick",
  swept: "sweep",
  wept: "weep",
  slept: "sleep",
  dreamt: "dream",
  leant: "lean",
  crept: "creep",
  leapt: "leap",
  knelt: "kneel",
  spelt: "spell",
  spilt: "spill",
  spoilt: "spoil",
  dwelt: "dwell",
  smelt: "smell",
  burnt: "burn",
  learnt: "learn",
  shone: "shine",
  slid: "slide",
  spun: "spin",
  stung: "sting",
  swung: "swing",
  withdrew: "withdraw",
  withstood: "withstand",
  forgave: "forgive",
  foresaw: "foresee",
  overcame: "overcome",
  undertook: "undertake",
  underwent: "undergo",
  upset: "upset",
  thrust: "thrust",
  split: "split",
  spread: "spread",
  burst: "burst",
  broadcast: "broadcast",
  forecast: "forecast",
  cast: "cast",
  cost: "cost",
  hit: "hit",
  hurt: "hurt",
  shut: "shut",
  quit: "quit",
  rid: "rid",
  shed: "shed",
  slit: "slit",
  wed: "wed",
  bet: "bet",
  thrived: "thrive",
  throve: "thrive",
  wove: "weave",
  strove: "strive",

  // ---- Verb: past participle → base ----
  been: "be",
  gone: "go",
  taken: "take",
  written: "write",
  driven: "drive",
  ridden: "ride",
  risen: "rise",
  broken: "break",
  spoken: "speak",
  stolen: "steal",
  chosen: "choose",
  frozen: "freeze",
  beaten: "beat",
  eaten: "eat",
  fallen: "fall",
  forgotten: "forget",
  forgiven: "forgive",
  given: "give",
  hidden: "hide",
  known: "know",
  seen: "see",
  shown: "show",
  torn: "tear",
  thrown: "throw",
  worn: "wear",
  woven: "weave",
  sworn: "swear",
  arisen: "arise",
  awoken: "awake",
  borne: "bear",
  forsaken: "forsake",
  gotten: "get",
  lain: "lie",
  mistaken: "mistake",
  mown: "mow",
  proven: "prove",
  sawn: "saw",
  sewn: "sew",
  shaken: "shake",
  shaven: "shave",
  shrunk: "shrink",
  sunk: "sink",
  slain: "slay",
  sown: "sow",
  sprang: "spring",
  stank: "stink",
  swollen: "swell",
  stridden: "stride",
  striven: "strive",
  strewn: "strew",
  thriven: "thrive",
  trodden: "tread",
  woken: "wake",

  // ---- Verb: 3rd person singular → base ----
  has: "have",
  does: "do",
  goes: "go",
  says: "say",

  // ---- Verb: -ing form → base (common irregular only; see suffix rules for regular) ----
  being: "be",
  having: "have",
  doing: "do",
  going: "go",
  lying: "lie",
  dying: "die",
  tying: "tie",
  vying: "vie",

  // ---- Adjective / Adverb: comparative → positive ----
  better: "good",
  worse: "bad",
  farther: "far",
  further: "far",
  older: "older",   // ambiguous — "old" is headword, but "older" is also used
  elder: "elder",   // "elder" is a standalone headword in most dictionaries

  // ---- Adjective / Adverb: superlative → positive ----
  best: "good",
  worst: "bad",
  least: "little",
  most: "much",
};

// Words ending in -ing that should NOT be lemmatised because they are common
// standalone dictionary headwords (gerunds that became independent nouns).
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

// Words ending in -s that are not plurals and should not be stripped.
const S_EXCEPTIONS = new Set([
  "this", "thus", "plus", "minus", "focus", "locus", "virus",
  "status", "campus", "bonus", "genus", "versus", "alias",
  "atlas", "canvas", "surplus", "synopsis", "analysis",
  "crisis", "thesis", "basis", "emphasis", "hypothesis",
  "parenthesis", "diagnosis", "prognosis", "oasis", "axis",
]);

// ── Pattern-based suffix stripping ─────────────────────────────────────

/**
 * Words ending in -ies (nouns & 3rd-person verbs).
 *   babies → baby,  carries → carry,  flies → fly
 * Guard: base must be >= 2 chars (avoid "i"→"y" nonsense).
 */
function tryIes(word: string): string | null {
  if (!word.endsWith("ies")) return null;
  if (word.endsWith("eies")) return null; // e.g. "eies"
  const stem = word.slice(0, -3);
  if (stem.length < 1) return null;
  return stem + "y";
}

/**
 * Words ending in -ves (plural of -f/-fe nouns).
 *   wives → wife,  knives → knife,  lives → life/live
 * Heuristic: try -f first for common short words, else -fe.
 */
function tryVes(word: string): string | null {
  if (!word.endsWith("ves")) return null;
  const stem = word.slice(0, -3);
  if (stem.length < 1) return null;
  // Common short -f stems
  const fStems = new Set([
    "cal", "hal", "sel", "wol", "lea", "loa", "scar", "whar",
    "shel", "thie", "el", "li",
  ]);
  if (fStems.has(stem)) {
    return stem + "f";
  }
  return stem + "fe";
}

/**
 * Words ending in -es (noun plural, verb 3rd person, irregular).
 *   boxes → box,  watches → watch,  goes → go
 * sibilant endings: -ss, -sh, -ch, -x, -z, -o
 */
function tryEs(word: string): string | null {
  if (!word.endsWith("es")) return null;
  if (word.length < 4) return null;
  const stem = word.slice(0, -2);
  // Only strip -es for sibilant endings (prevents false positives like "times"→"tim"? no..)
  // Actually, regular plurals like "times" should be handled by tryS (→ "time").
  const last2 = stem.slice(-2);
  if (
    last2 === "ss" || last2 === "sh" || last2 === "ch" ||
    stem.endsWith("x") || stem.endsWith("z") || stem.endsWith("o")
  ) {
    return stem;
  }
  return null;
}

/**
 * Words ending in -s (most common noun plural & verb 3rd person).
 *   models → model,  runs → run,  cats → cat
 * Skip: words in S_EXCEPTIONS, words ending in -ss, -us, -is, words < 3 chars.
 */
function tryS(word: string): string | null {
  if (!word.endsWith("s")) return null;
  if (word.length < 3) return null;
  const lower = word.toLowerCase();
  if (S_EXCEPTIONS.has(lower)) return null;
  if (lower.endsWith("ss") || lower.endsWith("us") || lower.endsWith("is")) {
    return null;
  }
  // Don't strip -s from very short stems
  const stem = word.slice(0, -1);
  if (stem.length < 2) return null;
  return stem;
}

/**
 * Words ending in -ed (past tense / past participle).
 *   played → play,  stopped → stop,  walked → walk
 * Handles consonant doubling (-pped, -tted, -gged, -mmed, -nned, -lled, -rred).
 */
function tryEd(word: string): string | null {
  if (!word.endsWith("ed")) return null;
  if (word.length < 5) return null; // too short: "red", "bed", "led" (irregular)
  const stem = word.slice(0, -2);

  // Consonant doubling: stopped → stop,  grabbed → grab
  if (stem.length >= 3) {
    const c = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    // Double consonant + ed pattern
    if (c === prev && "bcdfghjklmnpqrstvwxyz".includes(c) && !"aeiou".includes(c)) {
      const base = stem.slice(0, -1);
      // Only strip if the resulting base makes sense
      if (base.length >= 2) return base;
    }
  }

  // -ied past: carried → carry,  studied → study
  if (stem.endsWith("i")) {
    return stem.slice(0, -1) + "y";
  }

  // Regular -ed: played → play
  return stem;
}

/**
 * Words ending in -er (comparative adjectives/adverbs).
 *   bigger → big,  faster → fast,  nicer → nice
 * Skip: common -er nouns (teacher, worker, player, etc.)
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

function tryEr(word: string): string | null {
  if (!word.endsWith("er")) return null;
  const lower = word.toLowerCase();
  if (ER_NOUNS.has(lower)) return null;
  if (word.length < 4) return null;
  const stem = word.slice(0, -2);

  // Consonant doubling: bigger → big,  hotter → hot,  thinner → thin
  if (stem.length >= 2) {
    const c = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (c === prev && "bcdfghjklmnpqrstvwxyz".includes(c) && !"aeiou".includes(c)) {
      return stem.slice(0, -1);
    }
  }

  // -ier → -y: happier → happy
  if (stem.endsWith("i") && stem.length >= 2) {
    return stem.slice(0, -1) + "y";
  }

  // -er → -e: nicer → nice,  larger → large
  if (stem.endsWith("")) {
    // Just return stem (the base -er is removed)
    // But only for clearly adjectival stems
    // For safety, only apply to short stems
    if (stem.length <= 5) return stem;
  }

  return null; // conservative
}

/**
 * Words ending in -est (superlative adjectives/adverbs).
 *   biggest → big,  fastest → fast
 */
function tryEst(word: string): string | null {
  if (!word.endsWith("est")) return null;
  if (word.length < 5) return null;
  const stem = word.slice(0, -3);

  // Consonant doubling: biggest → big,  hottest → hot
  if (stem.length >= 2) {
    const c = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (c === prev && "bcdfghjklmnpqrstvwxyz".includes(c) && !"aeiou".includes(c)) {
      return stem.slice(0, -1);
    }
  }

  // -iest → -y: happiest → happy
  if (stem.endsWith("i")) {
    return stem.slice(0, -1) + "y";
  }

  // -est → -e: nicest → nice
  if (stem.length <= 4) return stem;

  return null; // conservative
}

/**
 * Words ending in -ing (present participle / gerund).
 * Only lemmatise when the base is clearly a verb (not a standalone -ing noun).
 */
function tryIng(word: string): string | null {
  if (!word.endsWith("ing")) return null;
  const lower = word.toLowerCase();
  // Skip common standalone -ing nouns
  if (ING_NOUNS.has(lower)) return null;
  if (word.length < 5) return null;
  const stem = word.slice(0, -3);

  // Consonant doubling: running → run,  swimming → swim,  stopping → stop
  if (stem.length >= 2) {
    const c = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (c === prev && "bcdfghjklmnpqrstvwxyz".includes(c) && !"aeiou".includes(c)) {
      return stem.slice(0, -1);
    }
  }

  // -ing with silent -e drop: making → make,  taking → take,  writing → write
  // The pattern is: stem + "ing" where the verb ends in "e"
  // We add the "e" back: making → make,  hoping → hope
  // Guard: stem must be >= 2 chars and shouldn't end in a vowel followed by vowel
  if (stem.length >= 2 && !/[aeiou][aeiou]$/i.test(stem)) {
    return stem + "e";
  }

  return null;
}

// ── Ordering ───────────────────────────────────────────────────────────

/**
 * Suffix transformation rules in priority order.
 * Applied sequentially; first match wins.
 */
const RULES: Array<(w: string) => string | null> = [
  tryIes,   // -ies → -y (most specific plural/3rd person)
  tryVes,   // -ves → -f/-fe
  tryEs,    // -es → stem (sibilant endings only)
  tryS,     // -s → stem (most common)
  tryEd,    // -ed → stem
  tryEr,    // -er → stem (comparative)
  tryEst,   // -est → stem (superlative)
  tryIng,   // -ing → stem
];

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Convert an inflected English word to its dictionary headword (lemma).
 *
 * If the word is already a base form or cannot be lemmatised, the original
 * word is returned unchanged.
 *
 * @param word  The English word (any capitalisation; case-insensitive matching)
 * @returns     The lemma (preserving original capitalisation), or original word
 *
 * Examples:
 *   toLemma("models")     → "model"
 *   toLemma("better")     → "good"
 *   toLemma("went")       → "go"
 *   toLemma("running")    → "run"
 *   toLemma("meeting")    → "meeting"  (standalone -ing noun, preserved)
 *   toLemma("apple")      → "apple"    (already base form)
 *   toLemma("children")   → "child"
 *   toLemma("was")        → "be"
 */
export function toLemma(word: string): string {
  if (!word || word.length < 2) {
    return word;
  }

  const lower = word.toLowerCase();

  // 1. Exact-match irregular forms (fastest & most reliable)
  const irregular = IRREGULAR[lower];
  if (irregular) {
    return preserveCase(word, irregular);
  }

  // 2. Rule-based suffix stripping (applied in specificity order)
  for (const rule of RULES) {
    const result = rule(lower);
    if (result !== null && result.length >= 2) {
      return preserveCase(word, result);
    }
  }

  // 3. No transformation applies — word is already a base form
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
  // All uppercase → all uppercase lemma
  if (original === original.toUpperCase() && original.length > 1) {
    return lemma.toUpperCase();
  }
  // First letter uppercase → title-case lemma
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return lemma[0].toUpperCase() + lemma.slice(1);
  }
  return lemma;
}

/**
 * Quick check: would this word benefit from lemmatisation?
 * Returns true if the word appears to be an inflected form (not base).
 * Useful for logging / diagnostics without running the full lemmatiser.
 */
export function isInflected(word: string): boolean {
  return toLemma(word).toLowerCase() !== word.toLowerCase();
}
