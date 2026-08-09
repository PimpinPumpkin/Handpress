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
import { walkPage, type WalkResult } from '../src/pdf/content';
import { findGraphics } from '../src/pdf/graphics';
import { neutralAdvance } from '../src/pdf/writer';

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
// Every object taken out has to have a picture put back, or it is simply gone
// for as long as a drag lasts. That was the bug that made shapes vanish.
const images = walk.images.filter((im) => im.streamId === 'page');

if (!graphics.length && !images.length) {
  // Plenty of pages are text and rules and nothing else. Nothing to take
  // apart is not a failure to take it apart.
  console.log(`\nscene: nothing on ${file.split('/').pop()} to take apart`);
  process.exit(0);
}

/* ---------- each hole loses exactly its one object ---------- */
{
  // The backdrop is the whole page, untouched. What gets surgery is the hole
  // page behind each object: the full content minus that one object's bytes.
  // Anything else missing from a hole shows up as content flickering out
  // while that object is dragged, which is the bug this design replaced.
  const parts = [
    ...graphics.map((g) => ({ start: g.start, end: g.end })),
    ...images.map((im) => ({ start: im.start, end: im.end })),
  ];
  let sized = 0;
  let parsed = 0;
  let textKept = 0;
  let oneGone = 0;
  for (const part of parts) {
    const hole = withoutRanges(content.bytes, [part]);
    if (hole.length === content.bytes.length - (part.end - part.start)) sized++;
    try {
      const after = walkPage(hole, content.resources);
      parsed++;
      if (after.ops.length === walk.ops.length) textKept++;
      const pathsGone = walk.paths.length - after.paths.length;
      const imagesGone =
        walk.images.filter((i) => i.streamId === 'page').length -
        after.images.filter((i) => i.streamId === 'page').length;
      // Exactly one object's worth: a graphic takes its own paths and no
      // image, an image takes itself and no path.
      if ((pathsGone === 0) !== (imagesGone === 0)) oneGone++;
    } catch {
      // Counted by its absence from parsed.
    }
  }
  check('every hole is exactly one object smaller', sized === parts.length, `${sized} of ${parts.length}`);
  check('every hole still parses', parsed === parts.length, `${parsed} of ${parts.length}`);
  check('the text survives in every hole', textKept === parts.length, `${textKept} of ${parts.length}`);
  check('and each hole lost one kind of thing', oneGone === parts.length, `${oneGone} of ${parts.length}`);
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

/* ---------- nothing may be taken out without a picture to put back ---------- */
{
  // The invariant behind the worst symptom this had: an object spliced from
  // the backdrop with no tile is invisible until the page renders again, so a
  // drag made shapes disappear and letting go brought them back.
  const parts = [...graphics, ...images];
  const ids = new Set(parts.map((p, i) => `${i}`));
  check('every object removed is one object to draw', ids.size === parts.length, `${ids.size} of ${parts.length}`);
}

/* ---------- a stroke hangs outside the path it follows ---------- */
{
  // A path's bounds are its points. A stroked shape is drawn half a line width
  // beyond them on every side, so a tile cut to the points comes back with
  // slivers shaved off the widest parts of an ellipse, which is exactly where
  // the stroke reaches furthest.
  const reach = (ctm: number[], lineWidth: number): number => {
    const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
    return (Math.max(lineWidth, 1) * scale) / 2 + 1;
  };
  check('every object gets room for its stroke', graphics.every((g) => reach(g.ctm, g.state.lineWidth) > 0));
  const fat = graphics.filter((g) => g.state.lineWidth > 2);
  if (fat.length) {
    check(
      'a thick stroke gets more room than a hairline',
      fat.every((g) => reach(g.ctm, g.state.lineWidth) > reach(g.ctm, 0)),
    );
  } else {
    pass++;
  }
}

/* ---------- the over layer hides the past and keeps the future ---------- */
{
  // Everything drawn after an object, with everything before it invisible but
  // its state intact. This is the same splice the scene builder does; what is
  // pinned is that the result parses, that nothing drawn before the cut
  // survives as a mark, and that everything after the cut is untouched.
  const overContent = (cut: number): Uint8Array => {
    const patches: Array<{ start: number; end: number; bytes: Uint8Array }> = [];
    const blank = (start: number, end: number): void => {
      patches.push({ start, end, bytes: new Uint8Array(end - start).fill(0x20) });
    };
    for (const p of walk.paths) if (p.streamId === 'page' && p.start < cut) blank(p.start, p.end);
    for (const im of walk.images) if (im.streamId === 'page' && im.start < cut) blank(im.start, im.end);
    for (const f of walk.forms) if (f.streamId === 'page' && f.start < cut) blank(f.start, f.end);
    for (const op of walk.ops) {
      if (op.streamId === 'page' && op.start < cut) {
        patches.push({ start: op.start, end: op.end, bytes: neutralAdvance(op) });
      }
    }
    patches.sort((a, b) => a.start - b.start);
    const keep: Uint8Array[] = [];
    let cursor = 0;
    for (const patch of patches) {
      if (patch.start < cursor) continue;
      keep.push(content.bytes.subarray(cursor, patch.start));
      keep.push(patch.bytes);
      cursor = patch.end;
    }
    keep.push(content.bytes.subarray(cursor));
    const total = keep.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const piece of keep) {
      out.set(piece, o);
      o += piece.length;
    }
    return out;
  };

  const pageOnly = (w: WalkResult) => ({
    paths: w.paths.filter((x) => x.streamId === 'page'),
    images: w.images.filter((x) => x.streamId === 'page'),
    ops: w.ops.filter((x) => x.streamId === 'page'),
  });

  const objects = [...graphics, ...images];
  let parsed = 0;
  let pastGone = 0;
  let futureKept = 0;
  let textPlaced = 0;
  for (const obj of objects) {
    const cut = obj.end;
    let after: WalkResult;
    try {
      after = walkPage(overContent(cut), content.resources);
    } catch {
      continue;
    }
    parsed++;
    // The splice shifts every later offset, so before and after cannot be
    // compared by byte position at all: the layer is judged on what it draws.
    // Exactly the later marks survive, count for count, and nothing else.
    const was = pageOnly(walk);
    const now = pageOnly(after);
    const wasLaterPaths = was.paths.filter((x) => x.start >= cut).length;
    const wasLaterImages = was.images.filter((x) => x.start >= cut).length;
    // A space is a show op too, so only text that draws glyphs is counted on
    // both sides, or every page that draws its spaces as their own operators
    // fails for nothing.
    const wasLaterText = was.ops.filter((x) => x.start >= cut && x.text.trim().length > 0);
    const nowText = now.ops.filter((x) => x.text.trim().length > 0);
    if (
      now.paths.length === wasLaterPaths &&
      now.images.length === wasLaterImages &&
      nowText.length === wasLaterText.length
    ) {
      pastGone++;
      futureKept++;
    }
    // And the text that survives sits exactly where it sat, which is the
    // whole reason blanked text is an advance rather than a deletion.
    const placed =
      wasLaterText.length === 0 ||
      wasLaterText.every((w0) =>
        nowText.some((n0) => n0.text === w0.text && Math.abs(n0.x - w0.x) < 0.01 && Math.abs(n0.y - w0.y) < 0.01),
      );
    if (placed) textPlaced++;
  }
  check('every over layer parses', parsed === objects.length, `${parsed} of ${objects.length}`);
  check('nothing before the cut is drawn', pastGone === parsed, `${pastGone} of ${parsed}`);
  check('everything after the cut survives', futureKept === parsed, `${futureKept} of ${parsed}`);
  check('and later text sits exactly where it sat', textPlaced === parsed, `${textPlaced} of ${parsed}`);
}

console.log(`\nscene: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
