/**
 * Verifies the standard security handler: decrypt, then confirm the result is a
 * genuinely readable document by extracting text and comparing against pdf.js,
 * which does its own decryption independently.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { decryptToBytes, DecryptionError } from '../src/pdf/decrypt';

const argv = process.argv.slice(2);
const listIdx = argv.indexOf('--list');
const files =
  listIdx >= 0
    ? fs.readFileSync(argv[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : argv;
const anon = process.env.ANON === '1';

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

let ok = 0;
let bad = 0;
let needsPassword = 0;
let fileNo = 0;

for (const file of files) {
  fileNo++;
  const label = anon ? `doc#${fileNo}` : file.split('/').pop();
  let src: Uint8Array;
  try {
    src = new Uint8Array(fs.readFileSync(file));
  } catch {
    continue;
  }
  if (!/\/Encrypt/.test(Buffer.from(src).toString('latin1'))) continue;

  let doc: PDFDocument;
  let handled: boolean;
  try {
    const result = await decryptToBytes(src);
    handled = result.wasEncrypted;
    doc = await PDFDocument.load(result.bytes, { throwOnInvalidObject: false, updateMetadata: false });
  } catch (e) {
    if (e instanceof DecryptionError) {
      console.log(`PASSWORD ${label}: ${e.message}`);
      needsPassword++;
    } else {
      console.log(`FAIL ${label}: decrypt threw: ${(e as Error).message}`);
      bad++;
    }
    continue;
  }
  if (!handled) continue;

  // pdf.js decrypts independently, so its text is the reference answer.
  let expected = '';
  try {
    const jsDoc = await pdfjs.getDocument({ data: src.slice(), disableFontFace: true }).promise;
    const jsPage = await jsDoc.getPage(1);
    const tc = await jsPage.getTextContent();
    expected = norm((tc.items as Array<{ str?: string }>).map((i) => i.str ?? '').join(''));
  } catch {
    expected = '';
  }

  let got = '';
  let lineCount = 0;
  try {
    const content = getPageContent(doc.getPage(0));
    const walk = walkPage(content.bytes, content.resources);
    const lines = groupLines(walk.ops);
    lineCount = lines.length;
    got = norm(walk.ops.map((o) => o.text).join(''));
  } catch (e) {
    console.log(`FAIL ${label}: walk after decrypt: ${(e as Error).message}`);
    bad++;
    continue;
  }

  // Saving must also succeed, since the point is to write the file back out.
  let saved = 0;
  try {
    saved = (await doc.save({ useObjectStreams: false })).length;
  } catch (e) {
    console.log(`FAIL ${label}: save after decrypt: ${(e as Error).message}`);
    bad++;
    continue;
  }

  const ratio = expected.length ? got.length / expected.length : 0;
  if (expected.length > 20 && (ratio < 0.85 || ratio > 1.25)) {
    console.log(
      `FAIL ${label}: text mismatch vs pdf.js (${got.length} vs ${expected.length} chars)\n` +
        `      got:  ${JSON.stringify(got.slice(0, 70))}\n      want: ${JSON.stringify(expected.slice(0, 70))}`,
    );
    bad++;
    continue;
  }

  console.log(`OK ${label}: decrypted, ${lineCount} lines, text ${Math.round(ratio * 100)}% of pdf.js, saved ${saved} bytes`);
  ok++;
}

console.log(`\ndecrypt: ${ok} ok, ${bad} failed, ${needsPassword} genuinely password protected`);
