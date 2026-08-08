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

const language = {
  name: 'eng.traineddata.gz',
  url: 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
  sha256: 'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468',
};

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

const langFile = path.join(out, 'lang', language.name);
if (fs.existsSync(langFile) && (!language.sha256 || digest(langFile) === language.sha256)) {
  console.log(`have ${language.name} (${size(langFile)})`);
} else {
  console.log(`fetching ${language.name}`);
  const response = await fetch(language.url);
  if (!response.ok) {
    console.error(`could not fetch the language data: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  fs.writeFileSync(langFile, bytes);
  const got = digest(langFile);
  if (language.sha256 && got !== language.sha256) {
    fs.rmSync(langFile);
    console.error(`the language data did not match its digest: got ${got}`);
    process.exit(1);
  }
  console.log(`fetched ${language.name} (${size(langFile)}, sha256 ${got})`);
}

function same(a, b) {
  return fs.existsSync(b) && fs.statSync(a).size === fs.statSync(b).size;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function size(file) {
  return `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
}
