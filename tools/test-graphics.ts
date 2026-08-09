/**
 * Moving a drawing that is made of paths rather than of an image.
 *
 * A logo has no operator to rewrite the way an image does, so it is moved by
 * bracketing its bytes with a translation and its inverse. Two things have to
 * hold for that to be safe, and both are checked here against pages built to
 * break them:
 *
 *  - the group lands exactly where it was asked to land, on plain pages and on
 *    pages that are already scaled or rotated, and
 *  - everything drawn after the group stays exactly where it was, because the
 *    closing matrix put the state back.
 *
 * The last few cases are drawings that must *not* be offered as movable: a
 * background covering the page, a run with a stray Q in it, and a run with a
 * matrix left in effect. Each of those would move more than the user pointed
 * at, and a group that never appears is the correct outcome.
 */

import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
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

/** Builds a one page document whose content is exactly the given stream. */
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

/** A small mark: three little filled boxes in a row, which group as one. */
const MARK = '0 0 1 rg 100 500 12 12 re f 114 500 12 12 re f 128 500 12 12 re f';

/** Something drawn afterwards, whose position proves the state was restored. */
const AFTER = '1 0 0 rg 300 200 40 40 re f';

/* ---------- it finds the mark, and not the page behind it ---------- */
{
  const doc = await pageOf(`0.9 g 0 0 612 792 re f ${MARK} ${AFTER}`);
  const { graphics } = read(doc);
  check('the full page background is not offered', !graphics.some((g) => g.x1 - g.x0 > 600));
  const mark = graphics.find((g) => g.count === 3);
  check('the three boxes group into one drawing', !!mark, `found ${graphics.map((g) => g.count).join(', ')}`);
  if (mark) {
    check(
      'the group is bounded by what it draws',
      Math.abs(mark.x0 - 100) < 0.5 && Math.abs(mark.y0 - 500) < 0.5 && Math.abs(mark.x1 - 140) < 0.5,
      `(${mark.x0}, ${mark.y0}) to (${mark.x1}, ${mark.y1})`,
    );
  }
}

/* ---------- moving it, on pages that make the matrix matter ---------- */
const placements: Array<{ what: string; prefix: string; suffix: string }> = [
  { what: 'a plain page', prefix: '', suffix: '' },
  { what: 'a page scaled by half', prefix: 'q 0.5 0 0 0.5 0 0 cm ', suffix: ' Q' },
  { what: 'a page shifted and scaled', prefix: 'q 0.75 0 0 0.75 40 60 cm ', suffix: ' Q' },
  { what: 'a page turned on its side', prefix: 'q 0 1 -1 0 612 0 cm ', suffix: ' Q' },
];

for (const p of placements) {
  const doc = await pageOf(`${p.prefix}${MARK} ${AFTER}${p.suffix}`);
  const before = read(doc);
  const mark = before.graphics.find((g) => g.count === 3);
  if (!mark) {
    check(`${p.what}: the mark is found`, false);
    continue;
  }
  const wasAfter = before.graphics.find((g) => g.count === 1 && g.id !== mark.id);

  const dx = 60;
  const dy = -25;
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
    [{ graphicId: mark.id, dx, dy }],
  );

  const saved = await doc.save({ useObjectStreams: false });
  const out = await PDFDocument.load(saved, { throwOnInvalidObject: false, updateMetadata: false });
  const after = read(out);
  const moved = after.graphics.find((g) => g.count === 3);

  if (!moved) {
    check(`${p.what}: the mark survives the move`, false);
    continue;
  }
  check(
    `${p.what}: the mark lands where it was put`,
    Math.abs(moved.x0 - (mark.x0 + dx)) < 0.1 && Math.abs(moved.y0 - (mark.y0 + dy)) < 0.1,
    `wanted (${(mark.x0 + dx).toFixed(1)}, ${(mark.y0 + dy).toFixed(1)}), got (${moved.x0.toFixed(1)}, ${moved.y0.toFixed(1)})`,
  );
  check(
    `${p.what}: the mark keeps its size`,
    Math.abs(moved.x1 - moved.x0 - (mark.x1 - mark.x0)) < 0.1 &&
      Math.abs(moved.y1 - moved.y0 - (mark.y1 - mark.y0)) < 0.1,
    `was ${(mark.x1 - mark.x0).toFixed(1)} wide, now ${(moved.x1 - moved.x0).toFixed(1)}`,
  );

  const stillAfter = after.graphics.find((g) => g.count === 1 && g.id !== moved.id);
  if (wasAfter && stillAfter) {
    check(
      `${p.what}: what follows it does not move`,
      Math.abs(stillAfter.x0 - wasAfter.x0) < 0.1 && Math.abs(stillAfter.y0 - wasAfter.y0) < 0.1,
      `was (${wasAfter.x0.toFixed(1)}, ${wasAfter.y0.toFixed(1)}), now (${stillAfter.x0.toFixed(1)}, ${stillAfter.y0.toFixed(1)})`,
    );
  } else {
    check(`${p.what}: what follows it is still there`, false);
  }
}

/* ---------- runs that must not be offered ---------- */
{
  // A Q inside the run pops out past where the translation was put, so the
  // closing matrix would land on content that was never translated.
  const doc = await pageOf(`q 0 0 1 rg 100 500 12 12 re f Q 114 500 12 12 re f ${AFTER}`);
  const { graphics } = read(doc);
  check('a run that restores out of itself is refused', !graphics.some((g) => g.count > 1));
}
{
  // A cm at the run's own level survives it, and the closing inverse would
  // then compose with it in the wrong order.
  const doc = await pageOf(`0 0 1 rg 100 500 12 12 re f 1 0 0 1 20 0 cm 114 500 12 12 re f ${AFTER}`);
  const { graphics } = read(doc);
  check('a run that leaves a matrix in effect is refused', !graphics.some((g) => g.count > 1));
}
{
  // Text drawn in the middle of a run means the byte range would swallow it.
  // The font has to be real and in the page's resources: the walker cannot
  // record a show-text operator whose font it could not load, and a test that
  // named a font that was not there would pass without proving anything.
  // Seeded through a save: pdf-lib does not put an embedded font into the
  // document until it writes one, so a font asked for and drawn with is still
  // an unresolvable reference until the file has been through a round trip.
  const seed = await PDFDocument.create();
  const seedPage = seed.addPage([612, 792]);
  seedPage.drawText('hi', { x: 200, y: 400, size: 12, font: await seed.embedFont(StandardFonts.Helvetica) });
  const doc = await PDFDocument.load(await seed.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  const fonts = page.node.Resources()?.lookup(PDFName.of('Font')) as PDFDict | undefined;
  const fontName = fonts?.keys()[0]?.asString().replace(/^\//, '') ?? 'F1';
  const stream = doc.context.flateStream(
    new TextEncoder().encode(
      `0 0 1 rg 100 500 12 12 re f BT /${fontName} 12 Tf 200 400 Td (hi) Tj ET 114 500 12 12 re f ${AFTER}`,
    ),
  );
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  const { walk, graphics } = read(doc);
  check('the test page really does draw text', walk.ops.length === 1, `${walk.ops.length} text ops`);
  check('a run with text drawn through it is refused', !graphics.some((g) => g.count > 1));
}
{
  // Hairlines are table rules, and a page of them would be a page of boxes.
  const doc = await pageOf(`0 g 100 500 200 0.5 re f 100 400 0.5 200 re f`);
  const { graphics } = read(doc);
  check('a lone hairline is not offered', graphics.length === 0, `offered ${graphics.length}`);
}

console.log(`\ngraphics: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
