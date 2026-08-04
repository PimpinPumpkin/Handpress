/** Moves a line and checks it lands exactly there with nothing else disturbed. */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { applyEdits } from '../src/pdf/writer';

const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(process.argv[2])), { throwOnInvalidObject: false, updateMetadata: false });
const page = doc.getPage(0);
const c = getPageContent(page);
const walk = walkPage(c.bytes, c.resources);
const lines = groupLines(walk.ops);
const target = lines.filter((l) => l.editable && l.text.trim().length > 15).sort((a, b) => b.text.length - a.text.length)[0];
const DX = 37.5, DY = -22.25;
const wantX = target.x0 + DX, wantY = target.baselineY + DY;

const res = await applyEdits(doc, page, walk, lines, [{ lineId: target.id, newText: target.text, dx: DX, dy: DY }], c.bytes);
const out = await doc.save({ useObjectStreams: false });
const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
const c2 = getPageContent(doc2.getPage(0));
const lines2 = groupLines(walkPage(c2.bytes, c2.resources).ops);

const found = lines2.find((l) => l.text === target.text);
console.log(`moved lines: ${res.editedLines}, warnings ${res.warnings.length}`);
console.log(`want (${wantX.toFixed(2)}, ${wantY.toFixed(2)})`);
console.log(`got  (${found ? found.x0.toFixed(2) : '?'}, ${found ? found.baselineY.toFixed(2) : '?'})`);
if (found) {
  const dx = Math.abs(found.x0 - wantX), dy = Math.abs(found.baselineY - wantY);
  console.log(`error: dx=${dx.toFixed(3)} dy=${dy.toFixed(3)} -> ${dx < 0.05 && dy < 0.05 ? 'EXACT' : 'OFF'}`);
}
// Every other line must be untouched.
let drift = 0;
const others = lines2.filter((l) => l !== found);
const before = lines.filter((l) => l !== target);
for (let i = 0; i < Math.min(before.length, others.length); i++) {
  if (Math.abs(before[i].x0 - others[i].x0) > 0.02 || Math.abs(before[i].baselineY - others[i].baselineY) > 0.02) drift++;
}
console.log(`other lines drifted: ${drift} of ${before.length}`);
