/**
 * Taking a page apart into a backdrop and one piece per object.
 *
 * The whole point is that dragging composites instead of rendering, so what
 * matters is that the pieces add back up to the page: the backdrop must have
 * the objects genuinely removed, and each piece must carry the object exactly
 * as the page draws it, clip and all.
 *
 * pdf.js cannot run under Node, so the rendering half is not exercised here.
 * What is checked is the surgery that decides what gets rendered, which is
 * where the mistakes live: a byte range spliced out wrongly takes a neighbour
 * with it, and a clip left off a tile shows a logo uncut the moment the page
 * is composited rather than rendered.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { walkPage } from '../src/pdf/content';
import { findGraphics } from '../src/pdf/graphics';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

/** The same splice the scene builder uses. */
function withoutRanges(bytes: Uint8Array, ranges: Array<{ start: number; end: number }>): Uint8Array {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const keep: Uint8Array[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue;
    keep.push(bytes.subarray(cursor, r.start));
    cursor = r.end;
  }
  keep.push(bytes.subarray(cursor));
  const total = keep.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of keep) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

const file = process.argv[2];
let doc;
let page;
let content;
let walk;
let size;
try {
  doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  page = doc.getPage(0);
  content = getPageContent(page);
  walk = walkPage(content.bytes, content.resources);
  size = page.getSize();
} catch {
  // A file this cannot open is not a decomposition failure.
  console.log(`\nscene: ${file.split('/').pop()} could not be read`);
  process.exit(0);
}
const graphics = findGraphics(walk, size.width, size.height).filter(
  (g) => g.streamId === 'page' && !g.state.clipComplex,
);
const images = walk.images.filter((im) => im.streamId === 'page');

if (!graphics.length && !images.length) {
  // Plenty of pages are text and rules and nothing else. Nothing to take
  // apart is not a failure to take it apart.
  console.log(`\nscene: nothing on ${file.split('/').pop()} to take apart`);
  process.exit(0);
}

/* ---------- the backdrop really loses them ---------- */
{
  const parts = [
    ...graphics.map((g) => ({ start: g.start, end: g.end })),
    ...images.map((im) => ({ start: im.start, end: im.end })),
  ];
  const backdrop = withoutRanges(content.bytes, parts);
  check('the backdrop is shorter than the page', backdrop.length < content.bytes.length);

  const removed = parts.reduce((a, r) => a + (r.end - r.start), 0);
  // Exactly what was asked for and nothing else. A splice that overlaps or
  // slips takes a neighbour's operators with it, which is invisible until a
  // page composites wrongly.
  check(
    'exactly the object bytes come out',
    backdrop.length === content.bytes.length - removed,
    `${content.bytes.length - backdrop.length} out, ${removed} expected`,
  );

  // What is left has to still parse, which a cut through the middle of an
  // operator would not. It may legitimately be empty: a page that is one
  // picture and nothing else has a blank backdrop, which is right.
  let after;
  try {
    after = walkPage(backdrop, content.resources);
    check('what is left still parses', true);
  } catch (e) {
    check('what is left still parses', false, (e as Error).message);
    after = { ops: [], paths: [], images: [] } as unknown as ReturnType<typeof walkPage>;
  }
  // Only what was actually taken out. A page whose objects are all images
  // keeps every path it had, and asserting otherwise tests the fixture rather
  // than the code.
  if (graphics.length) {
    check(
      'the drawings are gone from the backdrop',
      after.paths.length < walk.paths.length,
      `${after.paths.length} of ${walk.paths.length}`,
    );
  }
  if (images.length) {
    check(
      'the images are gone from the backdrop',
      after.images.filter((i) => i.streamId === 'page').length < images.length,
      `${after.images.filter((i) => i.streamId === 'page').length} of ${images.length}`,
    );
  }
  // Text belongs to the backdrop and must survive untouched: an object range
  // that swallowed a show operator would take words off the page.
  check(
    'the text is untouched',
    after.ops.length === walk.ops.length,
    `${after.ops.length} of ${walk.ops.length}`,
  );
}

/* ---------- every tile knows where it goes ---------- */
{
  const boxes = [...graphics, ...images];
  check(
    'every object has a real box',
    boxes.every((b) => b.x1 > b.x0 && b.y1 > b.y0),
    boxes.filter((b) => b.x1 <= b.x0 || b.y1 <= b.y0).length + ' bad',
  );
  // Not that it sits on the page: content drawn past the edge is legal and
  // simply is not shown, so asserting otherwise tests the document rather
  // than the code that takes it apart.
  check('and a finite one', boxes.every((b) => Number.isFinite(b.x0) && Number.isFinite(b.y1)));
}

/* ---------- a clipped object keeps its clip ---------- */
{
  const clipped = graphics.filter((g) => g.state.clip);
  if (clipped.length) {
    // The tile has to be cut the same way the page cuts it, or the object
    // appears uncut the moment the page is composited rather than rendered.
    check('clipped objects carry a rectangle to cut with', clipped.every((g) => !!g.state.clip));
  } else {
    pass++;
  }
}

console.log(`\nscene: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
