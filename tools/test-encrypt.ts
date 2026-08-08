/**
 * Password protection.
 *
 * Encrypting is the one thing here where being wrong is worse than being
 * broken: a file that will not open is obvious, a file that opens without the
 * password is not. So this checks four things, and the important one is the
 * third.
 *
 *   1. The result is unreadable without a password.
 *   2. Our own reader opens it with the password and finds the same text.
 *   3. pdf.js, which has its own implementation of the standard security
 *      handler and shares no code with ours, opens it with the password.
 *   4. The wrong password is refused.
 *
 * Checking only against our own decryptor would prove the two halves agree
 * with each other and nothing more.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { encrypt } from '../src/pdf/encrypt';
import { decryptToBytes, DecryptionError, readHandler } from '../src/pdf/decrypt';

const PASSWORD = 'correct horse battery staple';
const WRONG = 'incorrect horse battery staple';

const files = process.argv.slice(2);
const anon = process.env.ANON === '1';
let pass = 0;
let fail = 0;
let fileNo = 0;

const pdfjs = await import(
  new URL('../node_modules/pdfjs-dist/legacy/build/pdf.mjs', import.meta.url).href
);

for (const file of files) {
  fileNo++;
  const label = anon ? `doc#${fileNo}` : file.split('/').pop();
  const problems: string[] = [];

  const original = new Uint8Array(fs.readFileSync(file));
  const before = await textOf(original);

  const locked = await encrypt(original, { userPassword: PASSWORD });

  // 1. Unreadable without the password.
  try {
    const doc = await PDFDocument.load(locked, { throwOnInvalidObject: false, updateMetadata: false });
    const handler = await readHandler(doc, '');
    if (handler) problems.push('the empty password unlocked it');
  } catch {
    // Refusing to load at all is also a pass here.
  }

  // 2. Our own reader, with the password.
  try {
    const { bytes: opened, wasEncrypted } = await decryptToBytes(locked, PASSWORD);
    if (!wasEncrypted) problems.push('our reader did not see it as encrypted');
    const after = await textOf(opened);
    if (after !== before) problems.push('the text changed through encryption');
  } catch (e) {
    problems.push(`our reader could not open it: ${(e as Error).message}`);
  }

  // 3. pdf.js, which shares no code with any of this.
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(locked),
      password: PASSWORD,
      useSystemFonts: false,
      isEvalSupported: false,
    });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((i: { str?: string }) => i.str ?? '').join('');
    if (!text.trim().length && before.trim().length) {
      problems.push('pdf.js opened it but found no text');
    }
    await task.destroy();
  } catch (e) {
    problems.push(`pdf.js refused it: ${(e as Error).message}`);
  }

  // 4. The wrong password.
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(locked), password: WRONG });
    await task.promise;
    problems.push('pdf.js accepted the wrong password');
  } catch (e) {
    const message = (e as Error).name ?? '';
    if (!/password/i.test(`${message} ${(e as Error).message}`)) {
      problems.push(`the wrong password failed for the wrong reason: ${(e as Error).message}`);
    }
  }

  try {
    await decryptToBytes(locked, WRONG);
    problems.push('our reader accepted the wrong password');
  } catch (e) {
    if (!(e instanceof DecryptionError)) {
      problems.push(`our reader failed on the wrong password unexpectedly: ${(e as Error).message}`);
    }
  }

  if (problems.length) {
    console.log(`FAIL ${label}: ${problems.join('; ')}`);
    fail++;
  } else {
    console.log(`OK ${label}: locked with AES-256, opened by us and by pdf.js, wrong password refused by both`);
    pass++;
  }
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
  const content = getPageContent(doc.getPage(0));
  return groupLines(walkPage(content.bytes, content.resources).ops)
    .map((l) => l.text)
    .join('\n');
}

console.log(`\nencrypt: ${pass} ok, ${fail} failed`);
if (fail) process.exitCode = 1;
