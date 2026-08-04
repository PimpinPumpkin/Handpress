/**
 * Redacts a word and proves it is gone from the file, not merely covered:
 * the saved bytes are re-read and the text must no longer contain it.
 */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { charsInRect, groupLines, walkPage } from '../src/pdf/content';
import { applyEdits } from '../src/pdf/writer';

const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(process.argv[2])), { throwOnInvalidObject: false, updateMetadata: false });
const page = doc.getPage(0);
const c = getPageContent(page);
const walk = walkPage(c.bytes, c.resources);
const lines = groupLines(walk.ops);

// Pick a line with a distinctive word in the middle of it.
const target = lines.find((l) => l.editable && /\S+\s+\S+\s+\S+/.test(l.text) && l.text.length > 25);
if (!target) { console.log('no suitable line'); process.exit(0); }

// Redact a band covering roughly the middle third of the line.
const rect = {
  x: target.x0 + (target.x1 - target.x0) * 0.33,
  y: target.y0,
  width: (target.x1 - target.x0) * 0.34,
  height: target.y1 - target.y0,
};
const ranges = charsInRect(target, rect);
if (!ranges.length) { console.log('nothing selected by the rectangle'); process.exit(0); }

const removed = ranges.map(([a, b]) => [...target.text].slice(a, b).join('')).join('');
console.log(`line:    ${JSON.stringify(target.text.slice(0, 70))}`);
console.log(`removing ${JSON.stringify(removed)}`);

const before = lines.map((l) => ({ x: l.x0, y: l.baselineY }));
const res = await applyEdits(doc, page, walk, lines, [{ lineId: target.id, newText: target.text, redact: ranges }], c.bytes);
const out = await doc.save({ useObjectStreams: false });

const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
const c2 = getPageContent(doc2.getPage(0));
const lines2 = groupLines(walkPage(c2.bytes, c2.resources).ops);
const all = lines2.map((l) => l.text).join('\n');

// The removed characters must be absent from the extracted text.
const stillThere = removed.trim().length > 2 && all.includes(removed.trim());
const survivor = lines2.find((l) => l.text.includes([...target.text].slice(0, ranges[0][0]).join('').trim().slice(-12)));
console.log(`removed text still extractable: ${stillThere ? 'YES (BAD)' : 'no'}`);
console.log(`edited line now: ${JSON.stringify(survivor ? survivor.text.slice(0, 70) : '(not found)')}`);

// The tail of the line must not have slid left into the gap.
const tailBefore = [...target.text].slice(ranges[ranges.length - 1][1]).join('').trim().slice(0, 10);
if (tailBefore) {
  const tailNow = lines2.find((l) => l.text.includes(tailBefore));
  console.log(`text after the gap still present: ${tailNow ? 'yes' : 'NO'}`);
}
// Compared as position sets, because removing characters can split the edited
// line into two on re-read and that shifts every index after it.
const key = (l: { x0: number; baselineY: number }) => `${Math.round(l.x0 * 20)}:${Math.round(l.baselineY * 20)}`;
const onTargetRow = (y: number) => Math.abs(y - target.baselineY) < 0.5;
const beforeSet = new Set(lines.filter((l) => !onTargetRow(l.baselineY)).map(key));
const afterSet = new Set(lines2.filter((l) => !onTargetRow(l.baselineY)).map(key));
let missing = 0;
for (const k of beforeSet) if (!afterSet.has(k)) missing++;
console.log(`untouched lines: ${beforeSet.size}, of which moved or lost: ${missing} | warnings ${res.warnings.length}`);
void before;
