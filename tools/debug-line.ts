import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { applyEdits, mapTextToSegments } from '../src/pdf/writer';
import { encodeText } from '../src/pdf/fonts';

const file = process.argv[2];
const src = new Uint8Array(fs.readFileSync(file));
const doc = await PDFDocument.load(src, { throwOnInvalidObject: false, updateMetadata: false });
const page = doc.getPage(0);
const content = getPageContent(page);
const walk = walkPage(content.bytes, content.resources);
const lines = groupLines(walk.ops);

const mutate = (t: string): string | null => {
  const m = /[A-Za-z]{3,}/.exec(t);
  return m ? t.slice(0, m.index) + 'Handpress' + t.slice(m.index + m[0].length) : null;
};
const target = lines.filter((l) => l.text.trim().length >= 12 && mutate(l.text)).sort((a, b) => b.text.length - a.text.length)[0];
const newText = mutate(target.text)!;

console.log('TARGET line id:', target.id, 'baselineY:', target.baselineY);
console.log('old:', JSON.stringify(target.text));
console.log('new:', JSON.stringify(newText));
console.log('ops:', target.ops.length, 'segments:', target.segments.length);
for (const s of target.segments) {
  console.log(
    `  seg [${s.start},${s.end}) u0=${s.u0.toFixed(1)} u1=${s.u1.toFixed(1)} font=${s.font.family || s.font.baseFont} :: ${JSON.stringify(s.text)}`,
  );
}
for (const sg of target.segments) {
  console.log('  SPACE INFO: measured spaceWidth=', sg.spaceWidth,
    '| font has space glyph?', sg.font.fromUnicode.has(' '),
    '| widths[32]=', sg.font.widths.get(32),
    '| twoByte=', sg.font.twoByte, '| effSize=', sg.fontSize.toFixed(2));
}
console.log('OPS:');
for (const o of target.ops.slice(0, 4)) {
  console.log('  op', o.index, 'fontSize=', o.fontSize, 'horizScale=', o.horizScale,
    'advance=', o.advance.toFixed(2), 'uAdv=', o.uAdvance.toFixed(2),
    'dir=(' + o.dirX.toFixed(2) + ',' + o.dirY.toFixed(2) + ')',
    'toPage=[' + o.toPage.map((n) => n.toFixed(2)).join(',') + ']',
    'text=' + JSON.stringify(o.text.slice(0, 14)));
}
const mapped = mapTextToSegments(target, newText);
console.log('mapped:', mapped.map((m) => JSON.stringify(m)).join(' | '));
console.log('reassembled:', JSON.stringify(mapped.join('')), 'matches new?', mapped.join('') === newText);
mapped.forEach((t, i) => {
  if (!t) return;
  const ok = encodeText(target.segments[i].font, t);
  console.log(`  encode seg${i} ${JSON.stringify(t.slice(0, 30))} ->`, ok ? `ok width=${ok.width}` : 'FAILED');
});

console.log('\nother lines on same baseline:');
for (const l of lines) {
  if (l !== target && Math.abs(l.baselineY - target.baselineY) < 0.5) {
    console.log(`  ${l.id} x0=${l.x0.toFixed(1)} :: ${JSON.stringify(l.text)}`);
  }
}

const res = await applyEdits(doc, page, walk, lines, [{ lineId: target.id, newText }], content.bytes);
console.log('\napplyEdits:', res.editedLines, 'edited;', 'warnings:', JSON.stringify(res.warnings));
const out = await doc.save({ useObjectStreams: false });
const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
const c2 = getPageContent(doc2.getPage(0));
const lines2 = groupLines(walkPage(c2.bytes, c2.resources).ops);
console.log('\nafter save, lines on that baseline:');
for (const l of lines2) {
  if (Math.abs(l.baselineY - target.baselineY) < 0.5) {
    console.log(`  x0=${l.x0.toFixed(1)} segs=${l.segments.length} :: ${JSON.stringify(l.text)}`);
  }
}

console.log('lines after save (total):', lines2.length);
console.log('any Handpress?', lines2.some((l) => l.text.includes('Handpress')));
for (const l of lines2.filter((l) => l.text.includes('Handpress'))) {
  console.log('  found at baselineY=', l.baselineY.toFixed(2), JSON.stringify(l.text.slice(0, 60)));
}
const newContent = getPageContent(doc2.getPage(0));
const latin = Buffer.from(newContent.bytes).toString('latin1');
const idx = latin.indexOf('ellum');
console.log('\n--- saved stream around edit (offset', idx, ') ---');
console.log(JSON.stringify(latin.slice(Math.max(0, idx - 120), idx + 90)));
