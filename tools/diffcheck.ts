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
const mutate = (t: string) => { const m = /[A-Za-z]{3,}/.exec(t); return m ? t.slice(0, m.index) + 'Handpress' + t.slice(m.index + m[0].length) : null; };
const target = lines.filter((l) => l.text.trim().length >= 12 && mutate(l.text)).sort((a, b) => b.text.length - a.text.length)[0];
await applyEdits(doc, page, walk, lines, [{ lineId: target.id, newText: mutate(target.text)! }], c.bytes);
const out = await doc.save({ useObjectStreams: false });
const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
const c2 = getPageContent(doc2.getPage(0));
const lines2 = groupLines(walkPage(c2.bytes, c2.resources).ops);

const key = (l: { text: string; baselineY: number }) => `${Math.round(l.baselineY * 10)}|${l.text}`;
const afterKeys = new Set(lines2.map(key));
console.log('before=' + lines.length + ' after=' + lines2.length + '  target=' + JSON.stringify(target.text.slice(0, 40)));
for (const l of lines) {
  if (l === target) continue;
  if (!afterKeys.has(key(l))) console.log('  MISSING after edit: y=' + l.baselineY.toFixed(1) + ' ' + JSON.stringify(l.text.slice(0, 60)));
}
const beforeKeys = new Set(lines.map(key));
for (const l of lines2) {
  if (!beforeKeys.has(key(l))) console.log('  NEW after edit:     y=' + l.baselineY.toFixed(1) + ' ' + JSON.stringify(l.text.slice(0, 60)));
}
