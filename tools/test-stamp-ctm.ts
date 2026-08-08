/**
 * Where added content lands on a page that left a transformation in effect.
 *
 * Signatures, added text, erasures and highlights are all appended after the
 * page's own drawing. A page is free to end its content stream with a scale or
 * a translation still applied, and plenty of real files do, because nothing
 * requires them to put it back. Anything appended then inherits it: a
 * signature dropped halfway down the page arrives somewhere else, at the wrong
 * size, which is exactly what it looked like.
 *
 * The test builds that page deliberately, stamps an image at a known point,
 * and walks the saved content to find where the image is actually drawn.
 */

import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { walkPage } from '../src/pdf/content';
import { applyEdits } from '../src/pdf/writer';

/** A 1x1 transparent PNG, which is all the stamp needs to be. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

const WANT_X = 200;
const WANT_Y = 500;
const WANT_W = 150;
const WANT_H = 60;

let pass = 0;
let fail = 0;

/**
 * Each case is a page whose content stream ends with something still applied.
 * The last is balanced, and is there so a passing result means the check can
 * tell the difference rather than always saying yes.
 */
const cases: Array<{ what: string; content: string }> = [
  { what: 'a page that scales and never restores', content: 'q 0.5 0 0 0.5 0 0 cm 1 0 0 RG' },
  { what: 'a page that translates and never restores', content: 'q 1 0 0 1 120 250 cm' },
  { what: 'a page that does both', content: 'q 0.75 0 0 0.75 40 60 cm' },
  { what: 'a page that restores more than it saves', content: 'q Q Q' },
  { what: 'a balanced page', content: 'q 0.5 0 0 0.5 0 0 cm Q' },
];

for (const c of cases) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('x', { x: 10, y: 10, size: 8 });

  // Replace the page's content with the awkward stream this case is about.
  const stream = doc.context.flateStream(new TextEncoder().encode(c.content));
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));

  const content = getPageContent(page);
  const walk = walkPage(content.bytes, content.resources);

  await applyEdits(doc, page, walk, [], [], content.bytes, null, [], [
    { id: 'sig1', png: PNG, x: WANT_X, y: WANT_Y, width: WANT_W, height: WANT_H },
  ]);

  const saved = await doc.save({ useObjectStreams: false });
  const out = await PDFDocument.load(saved, { throwOnInvalidObject: false, updateMetadata: false });
  const raw = out.getPage(0).node.Contents();
  const finalBytes =
    raw instanceof PDFRawStream ? decodePDFRawStream(raw).decode() : getPageContent(out.getPage(0)).bytes;

  // Walk the final stream and find the matrix in force where the image is drawn.
  const finalWalk = walkPage(finalBytes, getPageContent(out.getPage(0)).resources);
  const drawn = finalWalk.images[finalWalk.images.length - 1];

  if (!drawn) {
    console.log(`FAIL ${c.what}: the stamp was not drawn at all`);
    fail++;
    continue;
  }

  const gotW = drawn.x1 - drawn.x0;
  const gotH = drawn.y1 - drawn.y0;
  const offBy = Math.hypot(drawn.x0 - WANT_X, drawn.y0 - WANT_Y);
  const sized = Math.abs(gotW - WANT_W) < 1 && Math.abs(gotH - WANT_H) < 1;

  if (offBy < 1 && sized) {
    pass++;
  } else {
    console.log(
      `FAIL ${c.what}: asked for ${WANT_W}x${WANT_H} at (${WANT_X}, ${WANT_Y}), ` +
        `landed ${gotW.toFixed(0)}x${gotH.toFixed(0)} at ` +
        `(${drawn.x0.toFixed(0)}, ${drawn.y0.toFixed(0)}), off by ${offBy.toFixed(0)} pt`,
    );
    fail++;
  }
}

console.log(`\nstamp placement: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
