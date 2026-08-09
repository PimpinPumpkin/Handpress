/**
 * Builds the word list the spell checker reads.
 *
 * The source is the system dictionary, which on macOS and the BSDs is
 * Webster's Second International of 1934. That is public domain, it is already
 * on the machine, and it is a *headword* list: it has "computer" and not
 * "computers". The checker strips endings before it gives up, so the missing
 * inflections cost a lookup rather than a quarter of a million extra entries.
 *
 * What 1934 cannot have is the last ninety years of English, so a supplement
 * of modern words is kept in the repository next to this and folded in. That
 * file is small, hand written and committed; this output is neither and is
 * gitignored, like the recogniser's data.
 *
 * Run `npm run dict-assets`, which the build does on its own. Without it the
 * app still runs and the spell checker says the word list is not installed,
 * which is better than a build that fails on a machine with no dictionary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outDir = path.join(root, 'public', 'dict');
const outFile = path.join(outDir, 'en.txt');

/** Where a system word list lives, in the order worth trying. */
const SOURCES = ['/usr/share/dict/words', '/usr/dict/words', '/usr/share/dict/american-english'];

const source = SOURCES.find((p) => fs.existsSync(p));
if (!source) {
  console.warn(
    `dict-assets: no system word list found (looked in ${SOURCES.join(', ')}).\n` +
      'Spell checking will report that the word list is not installed. Everything else is unaffected.',
  );
  process.exit(0);
}

const words = new Set();
for (const raw of fs.readFileSync(source, 'utf8').split('\n')) {
  const w = raw.trim().toLowerCase();
  // Letters and apostrophes only, and nothing so short that the checker skips
  // it anyway. Everything else in these files is abbreviations and noise.
  if (w.length >= 2 && w.length <= 24 && /^[a-z']+$/.test(w)) words.add(w);
}

const supplementFile = path.join(here, 'dict-supplement.txt');
let added = 0;
if (fs.existsSync(supplementFile)) {
  for (const raw of fs.readFileSync(supplementFile, 'utf8').split('\n')) {
    const w = raw.trim().toLowerCase();
    if (!w || w.startsWith('#')) continue;
    if (!words.has(w)) {
      words.add(w);
      added++;
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, `${[...words].sort().join('\n')}\n`);

const size = fs.statSync(outFile).size;
console.log(
  `dict-assets: ${words.size} words (${added} from the supplement) from ${source}, ` +
    `${(size / 1024 / 1024).toFixed(1)} MB at public/dict/en.txt`,
);
