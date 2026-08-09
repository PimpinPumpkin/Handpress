/**
 * Spell checking, against a word list rather than a language model.
 *
 * The interesting part is not the lookup. It is that a PDF is a terrible
 * source of prose: web addresses, acronyms, surnames, and figure labels whose
 * producer drew them without spaces all arrive looking like misspellings. On a
 * dense paper the naive version flagged 23.7% of the words and every one of
 * them was correct. The filters here take that to 2%, and they are the reason
 * this is worth having at all: a checker that cries wolf is one nobody runs
 * twice.
 *
 * The word list is a headword list, so it has "computer" and not "computers".
 * Rather than expanding it fivefold, an unknown word is stripped of its
 * ending and looked up again. That handles inflections in a few bytes and
 * costs one extra lookup on words that are already known to be missing.
 */

/** One word the checker does not recognise, located in the text it came from. */
export interface Misspelling {
  word: string;
  /** Character range within the line, so it can be highlighted and replaced. */
  start: number;
  end: number;
}

/**
 * Shortest word the run-together rule will consider.
 *
 * Below this, dividing a word into two dictionary words says nothing: plenty
 * of ordinary misspellings do it by accident. The labels this exists for are
 * whole phrases with the spaces missing and are far longer.
 */
const RUN_TOGETHER_MIN = 11;

export class Dictionary {
  private words: Set<string>;

  constructor(list: Iterable<string>) {
    this.words = new Set();
    for (const w of list) {
      const s = w.trim().toLowerCase();
      if (s.length >= 2 && /^[a-z']+$/.test(s)) this.words.add(s);
    }
  }

  get size(): number {
    return this.words.size;
  }

  has(word: string): boolean {
    return this.words.has(word);
  }

  /**
   * Whether the word is one this recognises, allowing for its ending.
   *
   * The list holds headwords, so the plural, the past tense and the adverb of
   * a word it knows are all absent from it. Stripping the ending and asking
   * again covers those without carrying five entries per word.
   */
  known(word: string): boolean {
    if (this.words.has(word)) return true;
    for (const stem of stems(word)) {
      if (stem.length >= 2 && this.words.has(stem)) return true;
    }
    return false;
  }

  /**
   * Whether a word is really several words with the spaces missing.
   *
   * Figure labels and diagram captions come out of a PDF as one run when the
   * producer drew them without spaces, so "perceivedeaseofuse" arrives looking
   * like a mistake. Anything that divides cleanly into words this knows is
   * that rather than a misspelling: nobody misspells a word into two other
   * words by accident.
   */
  isRunTogether(word: string, depth = 0): boolean {
    // Short words are not run together labels, they are misspellings that
    // happen to divide. "docment" is doc and ment, and "definately" is define
    // and ately, and neither is what this rule is for. Figure labels are long.
    if (depth === 0 && word.length < RUN_TOGETHER_MIN) return false;
    if (!word.length) return depth >= 2;
    if (depth > 4) return false;
    // Longest piece first, so the split found is the most word-like one.
    for (let i = Math.min(word.length, 14); i >= 2; i--) {
      if (this.known(word.slice(0, i)) && this.isRunTogether(word.slice(i), depth + 1)) return true;
    }
    return false;
  }

  /**
   * Corrections for a word, nearest first.
   *
   * Only single edits are considered, and only against words of a similar
   * length starting with the same letter or the one either side of it on the
   * keyboard of likely typos. Comparing against a quarter of a million words
   * for every mistake is what makes a spell checker feel slow, and two thirds
   * of real typos are one edit away from the word that was meant.
   */
  suggest(word: string, limit = 5): string[] {
    const scored: Array<{ word: string; distance: number }> = [];
    for (const candidate of this.words) {
      if (Math.abs(candidate.length - word.length) > 1) continue;
      if (candidate[0] !== word[0] && candidate[1] !== word[1]) continue;
      const d = editDistance(word, candidate, 1);
      if (d <= 1) scored.push({ word: candidate, distance: d });
    }
    // Nearest first, then the ones made of the same letters, which is to say
    // the ones that are a swap of two neighbours. That is the commonest typo
    // there is, and without preferring it "the" came seventh among the
    // suggestions for "teh", behind five words reached by substitution.
    const letters = sorted(word);
    scored.sort(
      (a, b) =>
        a.distance - b.distance ||
        Number(sorted(b.word) === letters) - Number(sorted(a.word) === letters) ||
        Math.abs(a.word.length - word.length) - Math.abs(b.word.length - word.length) ||
        a.word.localeCompare(b.word),
    );
    return scored.slice(0, limit).map((s) => s.word);
  }
}

/** A word's letters in order, so two words made of the same ones compare equal. */
function sorted(w: string): string {
  return [...w].sort().join('');
}

/** The forms a headword takes, tried in turn when the word itself is absent. */
function stems(w: string): string[] {
  const out: string[] = [];
  if (w.endsWith('s')) {
    out.push(w.slice(0, -1));
    if (w.endsWith('es')) out.push(w.slice(0, -2));
    if (w.endsWith('ies')) out.push(`${w.slice(0, -3)}y`);
  }
  if (w.endsWith('ed')) {
    out.push(w.slice(0, -2), w.slice(0, -1));
    if (w.endsWith('ied')) out.push(`${w.slice(0, -3)}y`);
  }
  if (w.endsWith('ing')) out.push(w.slice(0, -3), `${w.slice(0, -3)}e`);
  if (w.endsWith('ly')) out.push(w.slice(0, -2));
  if (/(er|est)$/.test(w)) out.push(w.replace(/(er|est)$/, ''));
  // A doubled consonant before the ending, as in stopped and running.
  if (/(.)\1(ed|ing|er|est)$/.test(w)) out.push(w.replace(/(.)\1(ed|ing|er|est)$/, '$1'));
  if (w.endsWith("'s")) out.push(w.slice(0, -2));
  return out;
}

/**
 * Edit distance counting a swap of two neighbours as one change.
 *
 * Plain Levenshtein calls "recieve" two edits from "receive" and "teh" two
 * from "the", so a cap of one throws away the two commonest typos there are.
 * Counting the transposition once is the difference between suggesting
 * "receive" and suggesting "relieve".
 */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let twoBack: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], twoBack[j - 2] + 1);
      }
      if (row[j] < best) best = row[j];
    }
    if (best > cap) return cap + 1;
    twoBack = prev;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Everything in a line that a person would want asked about.
 *
 * Web and mail addresses are blanked first, because their parts are not words
 * and flagging them is the fastest way to make a check useless. What is left
 * is filtered by the rules that separate prose from the rest of what a PDF
 * contains.
 */
export function findMisspellings(dict: Dictionary, text: string): Misspelling[] {
  const masked = text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, (m) => ' '.repeat(m.length))
    .replace(/\S+@\S+/g, (m) => ' '.repeat(m.length))
    // A bare domain, which is how most addresses are actually written.
    .replace(/\b[a-z0-9-]+\.(?:com|org|net|edu|gov|io|uk|de|fr)\b/gi, (m) => ' '.repeat(m.length));

  const out: Misspelling[] = [];
  for (const m of masked.matchAll(/[A-Za-z][A-Za-z']*/g)) {
    const token = m[0];
    const at = m.index ?? 0;
    const word = token.replace(/^'+|'+$/g, '').toLowerCase();
    if (word.length < 3) continue;
    // Longer than any English word, which means it is a run of joined ones.
    if (word.length > 20) continue;
    // An acronym, which no dictionary should be asked about.
    if (token.length > 1 && token === token.toUpperCase()) continue;
    // A capital in the middle of a line is a name far more often than it is a
    // mistake, and a checker that argues with somebody's surname is a nuisance.
    if (/^[A-Z]/.test(token) && at > 0) continue;
    if (dict.known(word)) continue;
    if (dict.isRunTogether(word)) continue;
    // A capitalised word with nothing near it is a name, not a mistake. The
    // rule above catches names in the middle of a line; this catches the ones
    // that start it, which in a bibliography is most of them. A genuine typo
    // almost always has a correction one edit away, so requiring one costs
    // very little and quietens the whole reference section.
    if (/^[A-Z]/.test(token) && !dict.suggest(word, 1).length) continue;
    out.push({ word: token, start: at, end: at + token.length });
  }
  return out;
}

/**
 * Whether what was checked looks like it is in another language.
 *
 * A German form checked against an English list is not a document with two
 * hundred spelling mistakes in it, and listing them as though it were is worse
 * than saying nothing. Above this share of unknown words the answer is that
 * the dictionary is wrong, not the document.
 */
export const FOREIGN_SHARE = 0.25;
