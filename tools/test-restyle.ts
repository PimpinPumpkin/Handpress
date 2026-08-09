/**
 * Changing the typeface, size or colour of text already in the document.
 *
 * Everything else here goes to great lengths to keep a line's styling exactly
 * as the producer wrote it, so this deliberately breaks that rule for one line
 * and the question is whether the rest of the page notices.
 *
 * The rule that must survive is advance neutrality. Text set in Times at 18pt
 * is not the width it was in Helvetica at 12, so the fragment has to end with a
 * correction that puts the text matrix back where the original operator left
 * it. Without that, resizing one word slides everything after it along the
 * line and, on a shared line matrix, down the page.
 */

import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { applyEdits, type LineStyle } from '../src/pdf/writer';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

/** A page with three lines, so the two below the edited one can be watched. */
async function threeLines(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('first line here', { x: 72, y: 700, size: 12 });
  page.drawText('second line here', { x: 72, y: 680, size: 12 });
  page.drawText('third line here', { x: 72, y: 660, size: 12 });
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
}

function survey(doc: PDFDocument) {
  const page = doc.getPage(0);
  const content = getPageContent(page);
  const walk = walkPage(content.bytes, content.resources);
  return { page, content, walk, lines: groupLines(walk.ops) };
}

async function restyle(style: LineStyle, which = 'second') {
  const doc = await threeLines();
  const before = survey(doc);
  const target = before.lines.find((l) => l.text.includes(which));
  if (!target) return null;

  await applyEdits(doc, before.page, before.walk, before.lines, [
    { lineId: target.id, newText: target.text, style },
  ], before.content.bytes);

  const out = await PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const raw = out.getPage(0).node.Contents();
  const bytes = raw instanceof PDFRawStream ? decodePDFRawStream(raw).decode() : getPageContent(out.getPage(0)).bytes;
  return { before, after: survey(out), stream: new TextDecoder('latin1').decode(bytes) };
}

/** Where each line starts, so a shift anywhere on the page is visible. */
function origins(s: ReturnType<typeof survey>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const l of s.lines) out[l.text.trim()] = [l.ops[0].x, l.ops[0].y];
  return out;
}

/* ---------- colour on its own ---------- */
{
  const r = await restyle({ color: { r: 0.8, g: 0.1, b: 0.1 } });
  check('a colour change applies', !!r && /0\.8 0\.1 0\.1 rg/.test(r.stream));
  if (r) {
    const was = origins(r.before);
    const now = origins(r.after);
    check(
      'and moves nothing on the page',
      Object.keys(was).every(
        (k) => now[k] && Math.abs(was[k][0] - now[k][0]) < 0.01 && Math.abs(was[k][1] - now[k][1]) < 0.01,
      ),
      JSON.stringify(now),
    );
    // The colour has to be put back, or every line after it turns red too.
    check('and puts the colour back afterwards', /0\.8 0\.1 0\.1 rg[\s\S]*?0 0 0 rg/.test(r.stream));
  }
}

/* ---------- size, which changes the width of the text ---------- */
{
  const r = await restyle({ size: 20 });
  check('a size change applies', !!r && /Tf/.test(r.stream) && / 20 Tf/.test(r.stream));
  if (r) {
    const was = origins(r.before);
    const now = origins(r.after);
    check(
      'a bigger line does not push the lines after it',
      Object.keys(was)
        .filter((k) => !k.includes('second'))
        .every((k) => now[k] && Math.abs(was[k][0] - now[k][0]) < 0.01 && Math.abs(was[k][1] - now[k][1]) < 0.01),
      JSON.stringify(now),
    );
    check('and the size is restored for what follows', / 20 Tf[\s\S]*? 12 Tf/.test(r.stream));
  }
}

/* ---------- a different family ---------- */
{
  const r = await restyle({ family: 'Times', bold: true });
  // The embedded face is added to the page resources under a generated name,
  // and the restyled run is drawn with that rather than the document's own.
  check(
    'a family change embeds a face and uses it',
    !!r && /\/VeF\d* [\d.]+ Tf \[\(second line here\)/.test(r.stream),
    r ? r.stream.slice(r.stream.indexOf('second') - 60, r.stream.indexOf('second') + 20) : '',
  );
  if (r) {
    const was = origins(r.before);
    const now = origins(r.after);
    check(
      'and still moves nothing else on the page',
      Object.keys(was)
        .filter((k) => !k.includes('second'))
        .every((k) => now[k] && Math.abs(was[k][0] - now[k][0]) < 0.01 && Math.abs(was[k][1] - now[k][1]) < 0.01),
      JSON.stringify(now),
    );
    check(
      'and the text still reads the same',
      r.after.lines.some((l) => l.text.includes('second line here')),
      r.after.lines.map((l) => l.text).join(' | '),
    );
  }
}

/* ---------- everything at once ---------- */
{
  const r = await restyle({ family: 'Courier', italic: true, size: 8, color: { r: 0, g: 0.4, b: 0.2 } });
  check('family, size and colour together apply', !!r && /0 0\.4 0\.2 rg/.test(r.stream) && / 8 Tf/.test(r.stream));
  if (r) {
    const was = origins(r.before);
    const now = origins(r.after);
    check(
      'and the rest of the page is untouched',
      Object.keys(was)
        .filter((k) => !k.includes('second'))
        .every((k) => now[k] && Math.abs(was[k][0] - now[k][0]) < 0.01 && Math.abs(was[k][1] - now[k][1]) < 0.01),
      JSON.stringify(now),
    );
  }
}

console.log(`\nrestyle: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
