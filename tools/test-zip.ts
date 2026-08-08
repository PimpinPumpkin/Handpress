/**
 * The zip writer.
 *
 * Writes an archive and hands it to the system's own unzip to check, because
 * an archive that only this code can read is worth nothing. Checks the split
 * itself too: every page accounted for, in order, each piece a readable PDF.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { crc32, zip } from '../src/pdf/zip';

const files = process.argv.slice(2);
let pass = 0;
let fail = 0;

// A known value, so a broken table is caught before anything else is blamed.
const CRC_OF_123456789 = 0xcbf43926;
const check = crc32(new TextEncoder().encode('123456789'));
if (check !== CRC_OF_123456789) {
  console.log(`FAIL crc32: expected ${CRC_OF_123456789.toString(16)}, got ${check.toString(16)}`);
  fail++;
} else {
  console.log('OK crc32 matches the standard check value');
  pass++;
}

for (const file of files) {
  const label = file.split('/').pop();
  const problems: string[] = [];

  const source = new Uint8Array(fs.readFileSync(file));
  const doc = await PDFDocument.load(source, { throwOnInvalidObject: false, updateMetadata: false });
  const total = doc.getPageCount();

  // Split by hand here rather than through the model, which needs a browser.
  const pieces: Array<{ name: string; bytes: Uint8Array }> = [];
  for (let i = 0; i < total; i++) {
    const piece = await PDFDocument.create();
    const [page] = await piece.copyPages(doc, [i]);
    piece.addPage(page);
    pieces.push({ name: `page ${String(i + 1).padStart(String(total).length, '0')}.pdf`, bytes: await piece.save() });
  }

  const archive = zip(pieces);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handpress-zip-'));
  const archivePath = path.join(dir, 'split.zip');
  fs.writeFileSync(archivePath, archive);

  try {
    // The system's unzip verifies every CRC and the whole directory.
    execFileSync('unzip', ['-tqq', archivePath], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`unzip refused the archive: ${(e as Error).message.split('\n')[0]}`);
  }

  try {
    execFileSync('unzip', ['-qq', archivePath, '-d', path.join(dir, 'out')], { stdio: 'pipe' });
    const written = fs.readdirSync(path.join(dir, 'out')).sort();
    if (written.length !== total) problems.push(`expected ${total} files, unpacked ${written.length}`);

    for (const name of written) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, 'out', name)));
      const piece = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
      if (piece.getPageCount() !== 1) {
        problems.push(`${name} has ${piece.getPageCount()} pages`);
        break;
      }
    }
  } catch (e) {
    problems.push(`unpacking failed: ${(e as Error).message.split('\n')[0]}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  if (problems.length) {
    console.log(`FAIL ${label}: ${problems.join('; ')}`);
    fail++;
  } else {
    console.log(`OK ${label}: ${total} pages split, archived and read back by unzip`);
    pass++;
  }
}

console.log(`\nzip: ${pass} ok, ${fail} failed`);
if (fail) process.exitCode = 1;
