/**
 * Spell checking, judged on what it does not flag.
 *
 * A checker's quality is its false positives. The naive version flagged 23.7%
 * of a dense academic paper and every one was correct: web addresses, acronyms,
 * surnames, and figure labels the producer drew without spaces. So the cases
 * here are mostly things that must come back clean, plus a handful of real
 * mistakes that must not be missed among them.
 */

import fs from 'node:fs';
import { Dictionary, findMisspellings } from '../src/pdf/spell';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

const listFile = 'public/dict/en.txt';
if (!fs.existsSync(listFile)) {
  console.log('spelling: skipped, run npm run dict-assets first');
  process.exit(0);
}
const dict = new Dictionary(fs.readFileSync(listFile, 'utf8').split('\n'));
check('the word list loads', dict.size > 100000, `${dict.size} words`);

const flagged = (text: string): string[] => findMisspellings(dict, text).map((m) => m.word);

/* ---------- what must never be flagged ---------- */
const clean: Array<[string, string]> = [
  ['plain prose', 'The quick brown fox jumps over the lazy dog and runs away.'],
  ['inflections the headword list lacks', 'He clicked the buttons, carried the boxes and stopped running.'],
  ['modern words from the supplement', 'Open the website, check your email and download the spreadsheet.'],
  ['a web address', 'See http://sprouts.aisnet.org/9-37 for the paper.'],
  ['a bare domain', 'Read more at carfax.com today.'],
  ['a mail address', 'Write to someone@example.org about it.'],
  ['an acronym', 'The ISSN and the VIN are printed on the NBI form.'],
  ['a surname mid sentence', 'This was reported by Chuttur and Davis in their paper.'],
  ['a run together figure label', 'perceivedeaseofuse and perceivedusefulness drive attitudetowardusing.'],
  ['a possessive', "The company's records and the driver's licence were checked."],
];
for (const [what, text] of clean) {
  const got = flagged(text);
  check(`nothing flagged in ${what}`, got.length === 0, got.join(', '));
}

/* ---------- what must be flagged ---------- */
const mistakes: Array<[string, string, string]> = [
  ['a transposition', 'Please recieve the document.', 'recieve'],
  ['a doubled letter', 'This is a comitted change.', 'comitted'],
  ['a missing letter', 'The docment is attached.', 'docment'],
  ['a wrong vowel', 'That is definately wrong.', 'definately'],
];
for (const [what, text, want] of mistakes) {
  const got = flagged(text);
  check(`${what} is caught`, got.includes(want), `got ${JSON.stringify(got)}`);
}

/* ---------- corrections ---------- */
for (const [bad, good] of [['recieve', 'receive'], ['docment', 'document'], ['teh', 'the']] as Array<[string, string]>) {
  const s = dict.suggest(bad);
  check(`${bad} suggests ${good}`, s.includes(good), s.join(', ') || 'nothing');
}

/* ---------- a capitalised word with no near match is a name ---------- */
{
  const got = flagged('Sirkka wrote the introduction.');
  check('a first name at the start of a line is left alone', got.length === 0, got.join(', '));
  const typo = flagged('Recieve the parcel tomorrow.');
  check('but a capitalised typo is still caught', typo.includes('Recieve'), typo.join(', '));
}

console.log(`\nspelling: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
