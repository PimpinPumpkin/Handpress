/**
 * Puts the recogniser's own files where the app can serve them itself.
 *
 * Left alone, tesseract fetches its worker, its wasm core and its language
 * data from two public CDNs the first time anyone reads a scanned page. That
 * is a promise broken twice over: the app stops working without a connection,
 * and a third party learns that this machine is reading a document, which is
 * the one thing an editor that never uploads anything should not leak.
 *
 * So the files are collected into `public/ocr` and served from the same origin
 * as everything else. The core and worker are copied out of node_modules. The
 * language data is not published to npm in a usable form, so it is fetched
 * once here, at build time, and checked against a known digest.
 *
 * The directory is not committed. Run `npm run ocr-assets`, which the build
 * does on its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'ocr');

/**
 * The worker, and the three builds of the core it chooses between at runtime.
 *
 * Recognition runs LSTM only, so the legacy cores are not needed. Which of the
 * three arrives depends on what the browser admits to supporting, and the
 * worker picks by name, so all three have to be there.
 */
const copies = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  [
    'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
  ],
];

/**
 * The languages the recogniser can be asked for, and what each one weighs.
 *
 * Only the ones installed here are offered in the app, because offering a
 * language and then failing to fetch it is worse than not offering it. The
 * default set is English and the Western European languages that share its
 * alphabet; `OCR_LANGS` takes a comma separated list of codes from the table
 * below, or `all`.
 *
 * The digests are recorded rather than trusted on first sight. These files are
 * fetched over the network at build time and then served to everyone who uses
 * the site, which is exactly the position where a silent substitution matters.
 */
const LANGUAGES = {
  eng: { name: 'English', sha256: 'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468' },
  fra: { name: 'French', sha256: '1c0916fac2dbd6f121ca8a57a92f08e4a119227602c7c984da986222eab6cd3b' },
  deu: { name: 'German', sha256: 'f5618a8b8d07f6c7a633ce243bf075bb90f4145bb15c9264734c7cc63aa33205' },
  spa: { name: 'Spanish', sha256: '6cd52c545bceeacb2e43fad64fc0703a711c482ba20d1ca4b6915c09de9973e6' },
  ita: { name: 'Italian', sha256: '21c1bfde62571d76b923e270bb2cde583ccc18fa8bfd83454c021b28d8b5cb5a' },
  por: { name: 'Portuguese', sha256: '3f5feea9dfc39106c92348089097a39bec66e9d6d09ca49befebb0bb60947374' },
  nld: { name: 'Dutch', sha256: '86a28c7acdeedd80cfae16ed4be5b0c54795c21748302bdb35065b607396a008' },
  pol: { name: 'Polish', sha256: 'a5c03eb3affa5cd8c5fbe89fc394240a8f1165f10ffb839c57f8117131f2f359' },
  rus: { name: 'Russian', sha256: '63a48ae166be2bb9862839b6f75e11afbac5e3be5bd5fa9a155ea43d5cdf9575' },
  chi_sim: { name: 'Chinese (Simplified)', sha256: '59388039851e4d1293d729c183fd8c1fa9bbbb959eed996e945024671e68c1d6' },
  jpn: { name: 'Japanese', sha256: '70304835d33b4feacf5faa60f56176578b64a03de2eeb0801539a3f6e7807ccc' },
  kor: { name: 'Korean', sha256: '9d454186b4e2556854b625c43e44d93783a5be7ee89eb1dc6702dfbddced3f4f' },
  ara: { name: 'Arabic', sha256: '400ab30fe4f4c4a03feeabe0779a7122cee6aa4fffb1629bb5b1671942859c9e' },
  heb: { name: 'Hebrew', sha256: 'd18b4db5beccd16b41cfc7f38b53f6bf614d256696560444dc78753fbab54f1e' },
};

const DEFAULT_LANGS = ['eng', 'fra', 'deu', 'spa', 'ita', 'por', 'nld', 'pol'];

const requested =
  process.env.OCR_LANGS === 'all'
    ? Object.keys(LANGUAGES)
    : (process.env.OCR_LANGS ?? DEFAULT_LANGS.join(','))
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean);

const unknown = requested.filter((code) => !LANGUAGES[code]);
if (unknown.length) {
  console.error(`no such language: ${unknown.join(', ')}`);
  console.error(`known: ${Object.keys(LANGUAGES).join(', ')}`);
  process.exit(1);
}
if (!requested.includes('eng')) {
  // The app falls back to English whenever a document does not say otherwise,
  // and a fallback that is not installed is not a fallback.
  requested.unshift('eng');
}

fs.mkdirSync(path.join(out, 'lang'), { recursive: true });

for (const [from, to] of copies) {
  const source = path.join(root, 'node_modules', from);
  if (!fs.existsSync(source)) {
    console.error(`missing ${from}. Run npm install first.`);
    process.exit(1);
  }
  const target = path.join(out, to);
  if (same(source, target)) continue;
  fs.copyFileSync(source, target);
  console.log(`copied ${to} (${size(target)})`);
}

const installed = [];
for (const code of requested) {
  const { name, sha256 } = LANGUAGES[code];
  const file = path.join(out, 'lang', `${code}.traineddata.gz`);

  if (fs.existsSync(file) && digest(file) === sha256) {
    console.log(`have ${code} (${name}, ${size(file)})`);
  } else {
    console.log(`fetching ${code} (${name})`);
    const response = await fetch(`https://tessdata.projectnaptha.com/4.0.0/${code}.traineddata.gz`);
    if (!response.ok) {
      console.error(`could not fetch ${code}: ${response.status} ${response.statusText}`);
      process.exit(1);
    }
    fs.writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
    const got = digest(file);
    if (got !== sha256) {
      fs.rmSync(file);
      console.error(`${code} did not match its digest.\n  expected ${sha256}\n  got      ${got}`);
      process.exit(1);
    }
    console.log(`fetched ${code} (${name}, ${size(file)})`);
  }

  installed.push({ code, name, bytes: fs.statSync(file).size });
}

// The app offers what is here and nothing else. Offering a language and then
// failing to fetch it is worse than not offering it.
fs.writeFileSync(path.join(out, 'lang', 'index.json'), `${JSON.stringify(installed, null, 2)}\n`);

// A language dropped from the set should stop being offered and stop being
// deployed, rather than lingering because it happens to be on disk.
for (const file of fs.readdirSync(path.join(out, 'lang'))) {
  if (file === 'index.json') continue;
  const code = file.replace(/\.traineddata\.gz$/, '');
  if (requested.includes(code)) continue;
  fs.rmSync(path.join(out, 'lang', file));
  console.log(`removed ${code}, no longer asked for`);
}

console.log(`${installed.length} language${installed.length === 1 ? '' : 's'} ready`);

function same(a, b) {
  return fs.existsSync(b) && fs.statSync(a).size === fs.statSync(b).size;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function size(file) {
  return `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
}
