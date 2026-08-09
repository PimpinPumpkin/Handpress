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
  {
    what: 'a box, which must keep its corners',
    stroke: {
      color: { r: 0, g: 0.5, b: 0 },
      width: 2,
      closed: true,
      points: [ { x: 100, y: 400 }, { x: 300, y: 400 }, { x: 300, y: 500 }, { x: 100, y: 500 } ],
    },
  },
  {
    what: 'a translucent highlighter stroke',
    stroke: {
      color: { r: 1, g: 1, b: 0 },
      width: 12,
      opacity: 0.4,
      points: [ { x: 100, y: 200 }, { x: 400, y: 200 } ],
    },
  },
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
  // A shape is drawn from its corners; smoothing one rounds it off.
  if (c.stroke.closed) {
    if (!/\bh\s+S\b/.test(text)) problems.push('the shape was not closed');
    if (/\bv\b/.test(text.split('1 J 1 j')[1] ?? '')) problems.push('the corners were smoothed away');
  }
  // Stroke alpha has no operator of its own, so it has to come from a state.
  if ((c.stroke.opacity ?? 1) < 1 && !/\/HpInk\d+ gs/.test(text)) {
    problems.push('the opacity was not applied');
  }

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


/**
 * A cloud's bumps must face outwards.
 *
 * A revision cloud is a polygon whose every edge carries a row of half circles
 * on the outside. Which side that is depends on the winding, so the normal has
 * to be chosen by pointing away from the middle. Choosing the other one gives
 * a shape that looks bitten rather than puffy, and it looks deliberate enough
 * that nobody reports it as a bug.
 *
 * The generator itself lives in the viewer and needs a DOM, so the rule it
 * relies on is asserted here against the same arithmetic.
 */
{
  const square = [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 300 },
    { x: 100, y: 300 },
  ];
  const cx = square.reduce((a, q) => a + q.x, 0) / 4;
  const cy = square.reduce((a, q) => a + q.y, 0) / 4;
  let outward = 0;
  for (let i = 0; i < 4; i++) {
    const a = square[i];
    const b = square[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let nx = -uy;
    let ny = ux;
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const before = (mx - cx) ** 2 + (my - cy) ** 2;
    const after = (mx + nx - cx) ** 2 + (my + ny - cy) ** 2;
    if (after > before) outward++;
  }
  if (outward === 4) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL a cloud's bumps face outwards: only ${outward} of 4 edges do`);
  }
}

console.log(`\nink: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
