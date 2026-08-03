import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { applyEdits, type TextInsertion } from '../src/pdf/writer';

const file = process.argv[2];
const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), { throwOnInvalidObject: false, updateMetadata: false });
const page = doc.getPage(0);
const c = getPageContent(page);
const walk = walkPage(c.bytes, c.resources);
const lines = groupLines(walk.ops);
const before = lines.length;

const insertion: TextInsertion = {
  id: 'ins1', x: 72, y: 200, size: 14,
  color: { r: 0.85, g: 0.1, b: 0.1 },
  text: 'Added by Vellum\nSecond line here',
  bold: true, italic: false,
};

const res = await applyEdits(doc, page, walk, lines, [], c.bytes, null, [insertion]);
const out = await doc.save({ useObjectStreams: false });

const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
const c2 = getPageContent(doc2.getPage(0));
const lines2 = groupLines(walkPage(c2.bytes, c2.resources).ops);
const added = lines2.filter((l) => l.text.includes('Added by Vellum') || l.text.includes('Second line'));

console.log(`lines before=${before} after=${lines2.length}  warnings=${JSON.stringify(res.warnings.map((w) => w.detail))}`);
for (const l of added) {
  console.log(`  found: ${JSON.stringify(l.text)} at (${l.x0.toFixed(1)}, ${l.baselineY.toFixed(1)}) size=${l.fontSize.toFixed(1)} colour=(${l.fill.r.toFixed(2)},${l.fill.g.toFixed(2)},${l.fill.b.toFixed(2)})`);
}
// Nothing that was already on the page may have shifted.
const originalAfter = lines2.filter((l) => !added.includes(l));
let drift = 0;
for (let i = 0; i < Math.min(lines.length, originalAfter.length); i++) {
  if (Math.abs(lines[i].x0 - originalAfter[i].x0) > 0.02 || Math.abs(lines[i].baselineY - originalAfter[i].baselineY) > 0.02) drift++;
}
console.log(`existing lines drifted: ${drift}`);
