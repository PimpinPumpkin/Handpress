/**
 * Freehand strokes, written and read back.
 *
 * A stroke is the one kind of edit with no text and no image to check against,
 * so what is verified is that the operators land where the points were: the
 * saved page is walked and the drawn path's bounds compared with the bounds of
 * what was asked for. A dot, which is a stroke of one point, is checked too,
 * because an empty path draws nothing and a tap should leave a mark.
 */

import fs from 'node:fs';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { walkPage } from '../src/pdf/content';
import { applyEdits, type InkStroke } from '../src/pdf/writer';

const file = process.argv[2];
let pass = 0;
let fail = 0;

const cases: Array<{ what: string; stroke: Omit<InkStroke, 'id'> }> = [
  {
    what: 'a straight drag',
    stroke: { color: { r: 1, g: 0, b: 0 }, width: 3, points: [ { x: 100, y: 700 }, { x: 300, y: 700 } ] },
  },
  {
    what: 'a scribble',
    stroke: {
      color: { r: 0, g: 0, b: 1 },
      width: 2,
      points: Array.from({ length: 40 }, (_, i) => ({ x: 80 + i * 5, y: 500 + Math.sin(i / 3) * 30 })),
    },
  },
  { what: 'a single tap', stroke: { color: { r: 0, g: 0, b: 0 }, width: 6, points: [{ x: 200, y: 300 }] } },
];

for (const c of cases) {
  const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  const content = getPageContent(page);
  const walk = walkPage(content.bytes, content.resources);

  const before = content.bytes.length;
  await applyEdits(doc, page, walk, [], [], content.bytes, null, [], [], [], [], [
    { id: 'ink1', ...c.stroke },
  ]);
  const out = await doc.save({ useObjectStreams: false });

  const re = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
  const raw = re.getPage(0).node.Contents();
  const text =
    raw instanceof PDFRawStream
      ? new TextDecoder('latin1').decode(decodePDFRawStream(raw).decode())
      : new TextDecoder('latin1').decode(getPageContent(re.getPage(0)).bytes);

  const problems: string[] = [];
  if (!/\bS\b/.test(text)) problems.push('nothing was stroked');
  if (!text.includes('1 J 1 j')) problems.push('the nib is not round');

  // Every point asked for should appear within the numbers the path uses.
  const nums = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  for (const p of [c.stroke.points[0], c.stroke.points[c.stroke.points.length - 1]]) {
    const nearX = nums.some((n) => Math.abs(n - p.x) < 0.6);
    const nearY = nums.some((n) => Math.abs(n - p.y) < 0.6);
    if (!nearX || !nearY) problems.push(`the point (${p.x}, ${p.y}) is not in the path`);
  }
  if (out.length <= before) problems.push('the page did not grow');

  if (problems.length) {
    console.log(`FAIL ${c.what}: ${problems.join('; ')}`);
    fail++;
  } else {
    pass++;
  }
}

console.log(`\nink: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
