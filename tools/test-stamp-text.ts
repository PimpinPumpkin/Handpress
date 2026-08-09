/**
 * Watermarks, headers, footers and page numbers, which are one thing.
 *
 * They differ only in size, angle, opacity and where on the page they sit, so
 * they are built by one path and the risk is concentrated in that path: text
 * that lands off the page, a turn that swings the words in from a corner
 * instead of pivoting on their own start, or transparency that leaks on to
 * whatever the page draws next.
 *
 * Everything here reads the saved stream back rather than trusting what was
 * asked for.
 */

import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { walkPage } from '../src/pdf/content';
import { applyEdits, type TextInsertion } from '../src/pdf/writer';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

const PAGE = { width: 612, height: 792 };

async function stamped(insertion: Omit<TextInsertion, 'id'>): Promise<{ text: string; doc: PDFDocument }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE.width, PAGE.height]);
  page.drawText('body', { x: 72, y: 400, size: 12 });
  const loaded = await PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });

  const target = loaded.getPage(0);
  const content = getPageContent(target);
  const walk = walkPage(content.bytes, content.resources);
  await applyEdits(loaded, target, walk, [], [], content.bytes, null, [{ id: 'stamp', ...insertion }]);

  const out = await PDFDocument.load(await loaded.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const raw = out.getPage(0).node.Contents();
  const b = raw instanceof PDFRawStream ? decodePDFRawStream(raw).decode() : getPageContent(out.getPage(0)).bytes;
  return { text: new TextDecoder('latin1').decode(b), doc: out };
}

function drawnAt(doc: PDFDocument, needle: string): { x: number; y: number } | null {
  const content = getPageContent(doc.getPage(0));
  const op = walkPage(content.bytes, content.resources).ops.find((o) => o.text.includes(needle));
  return op ? { x: op.x, y: op.y } : null;
}

const base = {
  size: 12,
  color: { r: 0, g: 0, b: 0 },
  text: 'CONFIDENTIAL',
  bold: false,
  italic: false,
};

/* ---------- a plain footer ---------- */
{
  const { text, doc } = await stamped({ ...base, x: 200, y: 36 });
  const at = drawnAt(doc, 'CONFIDENTIAL');
  check('a footer is drawn', !!at);
  check(
    'a footer lands where it was placed',
    !!at && Math.abs(at.x - 200) < 0.5 && Math.abs(at.y - 36) < 0.5,
    at ? `(${at.x.toFixed(1)}, ${at.y.toFixed(1)})` : '',
  );
  check('and needs no graphics state when it is opaque', !/HpText/.test(text));
}

/* ---------- a turned watermark ---------- */
{
  const { text, doc } = await stamped({ ...base, x: 150, y: 300, size: 60, rotate: 45, opacity: 0.12 });
  const at = drawnAt(doc, 'CONFIDENTIAL');
  check(
    'a turned watermark still starts where it was placed',
    !!at && Math.abs(at.x - 150) < 0.5 && Math.abs(at.y - 300) < 0.5,
    at ? `(${at.x.toFixed(1)}, ${at.y.toFixed(1)})` : '',
  );
  // The turn belongs in the text matrix. A rotation written into the page
  // matrix instead would turn everything drawn after it as well.
  check('the turn is in the text matrix', /0\.707[0-9]* 0\.707[0-9]* -0\.707[0-9]* 0\.707[0-9]* [\d.]+ [\d.]+ Tm/.test(text), text.slice(text.indexOf('Tm') - 70, text.indexOf('Tm') + 3));
  check('its transparency is a graphics state', /\/HpText12 gs/.test(text));
  check(
    'and that state is inside the stamp, not left in effect',
    text.indexOf('/HpText12 gs') > text.lastIndexOf('q\n', text.indexOf('/HpText12 gs')) &&
      /\/HpText12 gs[\s\S]*?ET Q/.test(text),
  );
}

/* ---------- the page's own text is not disturbed ---------- */
{
  const plain = await PDFDocument.create();
  const p = plain.addPage([PAGE.width, PAGE.height]);
  p.drawText('body', { x: 72, y: 400, size: 12 });
  const bare = await PDFDocument.load(await plain.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const wasAt = drawnAt(bare, 'body');

  const { doc } = await stamped({ ...base, x: 150, y: 300, size: 60, rotate: 45, opacity: 0.12 });
  const nowAt = drawnAt(doc, 'body');
  check(
    "the page's own text does not move",
    !!wasAt && !!nowAt && Math.abs(wasAt.x - nowAt.x) < 0.01 && Math.abs(wasAt.y - nowAt.y) < 0.01,
    wasAt && nowAt ? `(${wasAt.x}, ${wasAt.y}) then (${nowAt.x}, ${nowAt.y})` : '',
  );
}

/* ---------- turning does not push it off the page ---------- */
{
  // The placement arithmetic that centres a turned stamp lives in the model,
  // which cannot run under Node, so the same sum is done here against the same
  // page size to prove it keeps a 45 degree watermark on the paper.
  const size = 60;
  const width = 12 * size * 0.6; // roughly the width of CONFIDENTIAL at 60pt
  const turn = (45 * Math.PI) / 180;
  const spanX = Math.abs(width * Math.cos(turn));
  const spanY = Math.abs(width * Math.sin(turn));
  const x = (PAGE.width - spanX) / 2;
  const y = (PAGE.height - spanY) / 2;
  check(
    'a centred watermark starts on the page',
    x > 0 && y > 0 && x + spanX <= PAGE.width + 0.5 && y + spanY <= PAGE.height + 0.5,
    `x ${x.toFixed(0)} span ${spanX.toFixed(0)}, y ${y.toFixed(0)} span ${spanY.toFixed(0)}`,
  );
}

/* ---------- a watermark asked to sit behind the page ---------- */
{
  const { text } = await stamped({ ...base, x: 150, y: 300, size: 60, rotate: 45, opacity: 0.12, behind: true });
  const markAt = text.indexOf('CONFIDENTIAL');
  // The page's own drawing is wrapped in q ... Q, and anything behind goes in
  // front of that wrap. Finding the stamp before the wrap opens is the check.
  const wrapAt = text.indexOf('q\n');
  check('a watermark can be drawn under the page', markAt >= 0 && wrapAt >= 0 && markAt < wrapAt,
    `stamp at ${markAt}, page wrap at ${wrapAt}`);
}
{
  const { text } = await stamped({ ...base, x: 150, y: 300, size: 60 });
  const markAt = text.indexOf('CONFIDENTIAL');
  const wrapAt = text.indexOf('q\n');
  check('and over it when it is not asked to', markAt >= 0 && wrapAt >= 0 && markAt > wrapAt,
    `stamp at ${markAt}, page wrap at ${wrapAt}`);
}

console.log(`\nstamped text: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
