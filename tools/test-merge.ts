/** Merges two files and extracts a subset, checking page counts and content. */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';

function textOfPage(doc: PDFDocument, i: number): string {
  const c = getPageContent(doc.getPage(i));
  return groupLines(walkPage(c.bytes, c.resources).ops).map((l) => l.text).join(' ').slice(0, 60);
}

const [fileA, fileB] = process.argv.slice(2);
const a = await PDFDocument.load(new Uint8Array(fs.readFileSync(fileA)), { throwOnInvalidObject: false, updateMetadata: false });
const b = await PDFDocument.load(new Uint8Array(fs.readFileSync(fileB)), { throwOnInvalidObject: false, updateMetadata: false });
const countA = a.getPageCount(), countB = b.getPageCount();
const firstA = textOfPage(a, 0), firstB = textOfPage(b, 0);

// Merge: copy every page of B onto the end of A, mirroring what the model does.
const copied = await a.copyPages(b, b.getPages().map((_, i) => i));
for (const p of copied) a.addPage(p);
const merged = await a.save({ useObjectStreams: false });

const m = await PDFDocument.load(merged, { throwOnInvalidObject: false, updateMetadata: false });
console.log(`merge: ${countA} + ${countB} -> ${m.getPageCount()} (want ${countA + countB}) ${m.getPageCount() === countA + countB ? 'OK' : 'WRONG'}`);
console.log(`  page 0 text matches A: ${textOfPage(m, 0).slice(0, 40) === firstA.slice(0, 40) ? 'yes' : 'NO'}`);
console.log(`  page ${countA} text matches B: ${textOfPage(m, countA).slice(0, 40) === firstB.slice(0, 40) ? 'yes' : 'NO'}`);

// Extract a subset out of the merged file.
const want = [0, countA, countA + 1].filter((i) => i < m.getPageCount());
const out = await PDFDocument.create();
const sub = await out.copyPages(m, want);
for (const p of sub) out.addPage(p);
const extracted = await out.save({ useObjectStreams: false });
const e = await PDFDocument.load(extracted, { throwOnInvalidObject: false, updateMetadata: false });
console.log(`extract ${want.length} pages -> ${e.getPageCount()} ${e.getPageCount() === want.length ? 'OK' : 'WRONG'}`);
console.log(`  extracted page 0 matches merged page 0: ${textOfPage(e, 0).slice(0, 40) === textOfPage(m, 0).slice(0, 40) ? 'yes' : 'NO'}`);
console.log(`  extracted page 1 matches merged page ${countA}: ${textOfPage(e, 1).slice(0, 40) === textOfPage(m, countA).slice(0, 40) ? 'yes' : 'NO'}`);
