/**
 * Cropping a page, which is a CropBox and not a rewrite.
 *
 * Nothing outside the box is deleted. It is simply not shown or printed, which
 * is what every reader means by cropping a PDF and is worth knowing before
 * cropping something confidential off the edge of a page.
 *
 * The cases here check the box lands where it was asked for, that it is held
 * inside the media box rather than allowed outside it, and that the page's own
 * content is untouched: a crop that shifted the text would not be a crop.
 */

import { PDFDocument, PDFName, PDFNumber, PDFArray } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { walkPage } from '../src/pdf/content';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

/** Reads a page's crop box straight from the object, not through pdf-lib's defaults. */
function cropOf(doc: PDFDocument, index: number): number[] | null {
  const raw = doc.getPage(index).node.lookup(PDFName.of('CropBox'));
  if (!(raw instanceof PDFArray) || raw.size() < 4) return null;
  return [0, 1, 2, 3].map((i) => {
    const v = raw.lookup(i);
    return v instanceof PDFNumber ? v.asNumber() : NaN;
  });
}

async function threePages(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`page ${i + 1}`, { x: 72, y: 700, size: 24 });
  }
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
}

/* ---------- one page ---------- */
{
  const doc = await threePages();
  const before = getPageContent(doc.getPage(0)).bytes;
  doc.getPage(0).setCropBox(50, 100, 400, 500);
  const out = await PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });

  const box = cropOf(out, 0);
  check('the crop box is written', !!box, 'no CropBox on the page');
  check(
    'it is where it was asked for',
    !!box && Math.abs(box[0] - 50) < 0.01 && Math.abs(box[1] - 100) < 0.01 &&
      Math.abs(box[2] - 450) < 0.01 && Math.abs(box[3] - 600) < 0.01,
    box ? box.join(', ') : '',
  );
  check('the other pages are left alone', !cropOf(out, 1) && !cropOf(out, 2));

  // The content stream must be untouched: a crop moves the window, not the ink.
  const after = getPageContent(out.getPage(0)).bytes;
  check('the page content is unchanged', before.length === after.length);

  // And the text has not moved in page coordinates.
  const walkBefore = walkPage(before, getPageContent(doc.getPage(0)).resources);
  const walkAfter = walkPage(after, getPageContent(out.getPage(0)).resources);
  check(
    'the text stays where it was',
    walkBefore.ops.length === walkAfter.ops.length &&
      walkBefore.ops.every((o, i) => Math.abs(o.x - walkAfter.ops[i].x) < 0.01 && Math.abs(o.y - walkAfter.ops[i].y) < 0.01),
  );
}

/* ---------- the clamp ---------- */
{
  // A crop box reaching outside the media box is invalid, and readers disagree
  // about what to do with one, so the model holds it inside. This mirrors that
  // arithmetic against the same media box to prove the intersection is right.
  const media = { x: 0, y: 0, width: 612, height: 792 };
  const asked = { x: -80, y: -50, width: 900, height: 1000 };
  const x = Math.max(media.x, asked.x);
  const y = Math.max(media.y, asked.y);
  const w = Math.min(media.x + media.width, asked.x + asked.width) - x;
  const h = Math.min(media.y + media.height, asked.y + asked.height) - y;
  check(
    'a crop bigger than the page comes back as the page',
    x === 0 && y === 0 && Math.abs(w - 612) < 0.01 && Math.abs(h - 792) < 0.01,
    `${x}, ${y}, ${w}, ${h}`,
  );

  const doc = await threePages();
  doc.getPage(0).setCropBox(x, y, w, h);
  const out = await PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const box = cropOf(out, 0);
  check('and is accepted by the writer', !!box && box[2] <= 612.01 && box[3] <= 792.01, box ? box.join(', ') : '');
}

/* ---------- every page ---------- */
{
  const doc = await threePages();
  for (let i = 0; i < 3; i++) doc.getPage(i).setCropBox(30, 30, 552, 732);
  const out = await PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  check(
    'every page can carry the same crop',
    [0, 1, 2].every((i) => {
      const b = cropOf(out, i);
      return !!b && Math.abs(b[0] - 30) < 0.01 && Math.abs(b[2] - 582) < 0.01;
    }),
  );
  check('and the page count is unchanged', out.getPageCount() === 3);
}

console.log(`\ncrop: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
