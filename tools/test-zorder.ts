/**
 * Changing what is in front of what.
 *
 * A PDF has no z index: what is in front is whatever was drawn last. Restacking
 * therefore means lifting an object's operators out of the middle of the page
 * and emitting them at the end of it or the start of it, and the hard part is
 * not the order. It is that the operators carry none of the state they were
 * drawn under. A logo's paths say where its corners are and nothing about what
 * colour they were, so an object moved to the front without its state arrives
 * as a black shape.
 *
 * These cases build a page whose mark is drawn in a distinctive colour, width
 * and dash, restack it, and read the saved stream back to check three things:
 * the mark ends up on the right side of the page's own drawing, it still says
 * it is that colour, and the page's own drawing is untouched.
 */

import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { walkPage } from '../src/pdf/content';
import { findGraphics } from '../src/pdf/graphics';
import { applyEdits } from '../src/pdf/writer';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

/** The mark: three boxes in an unmistakable colour, with a dash and a width. */
const MARK = '0.2 0.4 0.8 rg 0.9 0.1 0.1 RG 3.5 w [2 1] 0 d 100 500 12 12 re f 114 500 12 12 re f 128 500 12 12 re f';

/** Drawn after it, so which is in front can be read off the byte order. */
const AFTER = '1 0 0 rg 300 200 40 40 re f';

async function pageOf(content: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const stream = doc.context.flateStream(new TextEncoder().encode(content));
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  return doc;
}

function read(doc: PDFDocument) {
  const page = doc.getPage(0);
  const content = getPageContent(page);
  const walk = walkPage(content.bytes, content.resources);
  const size = page.getSize();
  return { page, content, walk, graphics: findGraphics(walk, size.width, size.height) };
}

function finalText(doc: PDFDocument): string {
  const raw = doc.getPage(0).node.Contents();
  const b = raw instanceof PDFRawStream ? decodePDFRawStream(raw).decode() : getPageContent(doc.getPage(0)).bytes;
  return new TextDecoder('latin1').decode(b);
}

for (const zone of ['front', 'back'] as const) {
  const doc = await pageOf(`${MARK} ${AFTER}`);
  const before = read(doc);
  const mark = before.graphics.find((g) => g.count === 3);
  if (!mark) {
    check(`${zone}: the mark is found`, false);
    continue;
  }

  await applyEdits(
    doc,
    before.page,
    before.walk,
    [],
    [],
    before.content.bytes,
    null,
    [],
    [],
    [],
    [],
    [],
    [],
    [{ objectId: mark.id, zone, rank: 1 }],
  );

  const saved = await doc.save({ useObjectStreams: false });
  const out = await PDFDocument.load(saved, { throwOnInvalidObject: false, updateMetadata: false });
  const text = finalText(out);

  // The mark's own coordinates are the landmark: wherever they now sit relative
  // to the square drawn after it is the answer to what covers what.
  const markAt = text.indexOf('100 500 12 12 re');
  const afterAt = text.indexOf('300 200 40 40 re');
  check(`${zone}: the mark is drawn once`, markAt >= 0 && text.indexOf('100 500 12 12 re', markAt + 1) === -1);
  check(`${zone}: the page's own square is still drawn`, afterAt >= 0);
  check(
    zone === 'front' ? 'front: the mark is drawn last' : 'back: the mark is drawn first',
    zone === 'front' ? markAt > afterAt : markAt < afterAt,
    `mark at ${markAt}, square at ${afterAt}`,
  );

  // The state it was drawn under has to travel with it.
  const prolog = text.slice(Math.max(0, markAt - 220), markAt);
  check(`${zone}: its fill colour travels with it`, /0\.2 0\.4 0\.8 rg/.test(prolog), prolog.trim().slice(-90));
  check(`${zone}: its stroke colour travels with it`, /0\.9 0\.1 0\.1 RG/.test(prolog));
  check(`${zone}: its line width travels with it`, /3\.5 w/.test(prolog));
  check(`${zone}: its dash travels with it`, /\[2 1\] 0 d/.test(prolog));

  // And it must still be where it was: restacking is not moving.
  const after = read(out);
  const moved = after.graphics.find((g) => g.count === 3);
  check(
    `${zone}: it does not move`,
    !!moved && Math.abs(moved.x0 - mark.x0) < 0.1 && Math.abs(moved.y0 - mark.y0) < 0.1,
    moved ? `(${moved.x0.toFixed(1)}, ${moved.y0.toFixed(1)}) was (${mark.x0.toFixed(1)}, ${mark.y0.toFixed(1)})` : 'gone',
  );
}

/* ---------- restacking and moving at the same time ---------- */
{
  const doc = await pageOf(`${MARK} ${AFTER}`);
  const before = read(doc);
  const mark = before.graphics.find((g) => g.count === 3)!;

  await applyEdits(doc, before.page, before.walk, [], [], before.content.bytes, null, [], [], [], [], [],
    [{ graphicId: mark.id, dx: 40, dy: -30 }],
    [{ objectId: mark.id, zone: 'front', rank: 1 }],
  );

  const saved = await doc.save({ useObjectStreams: false });
  const out = await PDFDocument.load(saved, { throwOnInvalidObject: false, updateMetadata: false });
  const after = read(out);
  const moved = after.graphics.find((g) => g.count === 3);
  check(
    'moved and restacked at once lands where it was dropped',
    !!moved && Math.abs(moved.x0 - (mark.x0 + 40)) < 0.1 && Math.abs(moved.y0 - (mark.y0 - 30)) < 0.1,
    moved ? `(${moved.x0.toFixed(1)}, ${moved.y0.toFixed(1)})` : 'gone',
  );
  // The bracket that moves an object in place must not also be emitted, or the
  // translation is applied twice: once around bytes that are no longer there,
  // and once by the redraw.
  const text = finalText(out);
  check('the mark is still drawn only once', text.split('100 500 12 12 re').length === 2);
}

/* ---------- clips: the one that cuts, and the one that does not ---------- */
{
  // Almost every real page opens by clipping to its own box before drawing
  // anything. Treating that as a reason to refuse refuses everything, which is
  // exactly what it did: the mark on a real report stayed where it was and the
  // move that came with it was thrown away in silence.
  const doc = await pageOf(`q 0 0 612 792 re W n ${MARK} Q ${AFTER}`);
  const before = read(doc);
  const mark = before.graphics.find((g) => g.count === 3);
  check('a page sized clip does not stop restacking', !!mark && mark.canRelocate);
}
{
  // A clip that genuinely cuts the mark is a different matter: lifted to the
  // front it would leave the clip behind and spill out of the shape.
  const doc = await pageOf(`q 100 500 20 12 re W n ${MARK} Q ${AFTER}`);
  const before = read(doc);
  const mark = before.graphics.find((g) => g.count === 3);
  check('a drawing cut by a clip is still offered for moving', !!mark);
  check('a drawing cut by a clip refuses to be restacked', !!mark && !mark.canRelocate);

  if (mark) {
    const result = await applyEdits(doc, before.page, before.walk, [], [], before.content.bytes, null,
      [], [], [], [], [], [], [{ objectId: mark.id, zone: 'front', rank: 1 }]);
    const text = finalText(doc);
    check('and is left exactly where it was', text.split('100 500 12 12 re').length === 2);
    check('and says why', result.warnings.some((w) => /spill/.test(w.detail)));
  }
}
{
  // A clip cut to a shape rather than a rectangle cannot be reasoned about at
  // all: the bounding box of a triangle is bigger than the triangle.
  const doc = await pageOf(`q 0 400 m 300 400 l 150 700 l h W n ${MARK} Q ${AFTER}`);
  const before = read(doc);
  const mark = before.graphics.find((g) => g.count === 3);
  check('a drawing under a shaped clip refuses to be restacked', !!mark && !mark.canRelocate);
}

console.log(`\nz order: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
