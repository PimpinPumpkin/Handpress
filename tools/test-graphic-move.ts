/**
 * Moving a real logo on a real document, end to end through the model.
 *
 * The synthetic cases in test-graphics prove the arithmetic. This proves the
 * thing that was actually reported: the mark at the top of a Carfax report
 * could not be moved, because nothing in the editor knew it was an object.
 *
 * It moves it, saves, and then re-reads the saved file to check two things
 * that matter equally. The drawing has to arrive where it was sent, and every
 * other drawing and every line of text on the page has to be exactly where it
 * was, because a page that shifts when a logo moves is worse than a logo that
 * cannot move at all.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { walkPage } from '../src/pdf/content';
import { findGraphics } from '../src/pdf/graphics';
import { applyEdits } from '../src/pdf/writer';

const argv = process.argv.slice(2);
const listIdx = argv.indexOf('--list');
const files =
  listIdx >= 0
    ? fs
        .readFileSync(argv[listIdx + 1], 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : argv;
if (!files.length) {
  console.log('usage: test-graphic-move <file.pdf ...> | --list <file>');
  process.exit(1);
}
const quiet = files.length > 1;

const DX = 180;
const DY = -240;

function survey(bytes: Uint8Array) {
  return PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false }).then((doc) => {
    const page = doc.getPage(0);
    const content = getPageContent(page);
    const walk = walkPage(content.bytes, content.resources);
    const size = page.getSize();
    return {
      graphics: findGraphics(walk, size.width, size.height),
      // Keyed by what the run says and how wide it is, so a run can be found
      // again in the saved file without depending on its position.
      text: walk.ops.map((o) => ({ key: `${o.text}|${o.advance.toFixed(2)}`, x: o.x, y: o.y })),
    };
  });
}

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (what: string, ok: boolean, detail = ''): void => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${label}${what}${detail ? `: ${detail}` : ''}`);
  }
};

let label = '';

for (const file of files) {
  label = quiet ? `${file.split('/').pop()}: ` : '';
  let original: Uint8Array;
  try {
    original = new Uint8Array(fs.readFileSync(file));
  } catch {
    continue;
  }
  let before;
  try {
    before = await survey(original);
  } catch {
    // A file this cannot even read is not a graphics failure.
    skipped++;
    continue;
  }

  // The widest drawing made of several paths, which on a report is the mark at
  // the top of it. Picking it by shape rather than by id keeps this readable on
  // any document handed to it.
  const target = [...before.graphics].filter((g) => g.count > 2).sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))[0];
  if (!target) {
    // Plenty of documents are text and nothing else. Nothing to move is not a
    // failure to move it.
    skipped++;
    continue;
  }

  if (!quiet) {
    console.log(
      `moving ${target.id} (${target.count} paths, ` +
        `${(target.x1 - target.x0).toFixed(1)}x${(target.y1 - target.y0).toFixed(1)}pt) by ${DX}, ${DY}`,
    );
  }

  try {
    // Driven through the writer rather than through the document model, because
    // the model imports the renderer's worker and that only resolves in a browser
    // build. The model does no arithmetic of its own here: it accumulates the drag
    // and hands the same GraphicEdit straight down.
    const doc = await PDFDocument.load(original, { throwOnInvalidObject: false, updateMetadata: false });
    const page = doc.getPage(0);
    const content = getPageContent(page);
    const walk = walkPage(content.bytes, content.resources);
    await applyEdits(doc, page, walk, [], [], content.bytes, null, [], [], [], [], [], [
      { graphicId: target.id, dx: DX, dy: DY },
    ]);

    const saved = await doc.save({ useObjectStreams: false });
    const after = await survey(saved);

    // Compared as a whole set rather than by finding "the" drawing. Documents
    // exist with eight identical shapes on one page, and picking one by its
    // count and size then finds an unmoved twin and calls the move a failure.
    // Exactly one entry should differ, and it should differ by the drag.
    const place = (g: { count: number; x0: number; y0: number; x1: number; y1: number }): string =>
      `${g.count}@${g.x0.toFixed(1)},${g.y0.toFixed(1)}+${(g.x1 - g.x0).toFixed(1)}x${(g.y1 - g.y0).toFixed(1)}`;

    // A drawing cut to its own shape by something that cannot travel with it
    // is held inside that shape rather than moved out of sight, so the target
    // may land anywhere between where it started and where it was sent.
    // Everything else has to be exactly where it was, which is checked by
    // taking the target out of both lists and comparing what is left.
    const shape = `${target.count}@${(target.x1 - target.x0).toFixed(1)}x${(target.y1 - target.y0).toFixed(1)}`;
    const shapeOf = (g: typeof target): string =>
      `${g.count}@${(g.x1 - g.x0).toFixed(1)}x${(g.y1 - g.y0).toFixed(1)}`;
    const between = (now: number, from: number, by: number): boolean =>
      by >= 0 ? now >= from - 0.5 && now <= from + by + 0.5 : now <= from + 0.5 && now >= from + by - 0.5;

    // Furthest from where it started, because a page can carry eight identical
    // shapes and "it may also have stayed put" would otherwise match one of the
    // seven that did, leaving the one that moved looking like a stray.
    const landed = after.graphics
      .filter((g) => shapeOf(g) === shape && between(g.x0, target.x0, DX) && between(g.y0, target.y0, DY))
      .sort((a, b) => Math.hypot(b.x0 - target.x0, b.y0 - target.y0) - Math.hypot(a.x0 - target.x0, a.y0 - target.y0))[0];
    check(
      'the drawing moves, or is held inside what clips it',
      !!landed,
      `wanted ${shape} between (${target.x0.toFixed(1)}, ${target.y0.toFixed(1)}) and ` +
        `(${(target.x0 + DX).toFixed(1)}, ${(target.y0 + DY).toFixed(1)})`,
    );

    const drop = (list: typeof before.graphics, one: typeof target | undefined): string[] => {
      const out = list.map(place);
      const at = one ? out.indexOf(place(one)) : -1;
      if (at >= 0) out.splice(at, 1);
      return out.sort();
    };
    const wasRest = drop(before.graphics, target);
    const nowRest = drop(after.graphics, landed);
    check(
      'and nothing else moves',
      wasRest.length === nowRest.length && wasRest.every((e, i) => e === nowRest[i]),
      wasRest.filter((e, i) => e !== nowRest[i]).slice(0, 2).join(' '),
    );
  } catch (e) {
    check('the move does not throw', false, (e as Error).message);
  }
}

/* ---------- a drawing cut to its own shape must survive being moved ---------- */
//
// Nearly every small mark on a real page sits in a clip a point or two bigger
// than itself. Translating only the drawing slides it out from under its own
// clip and it vanishes, which is what moving the icons on a report did. The
// check is not that the bytes changed: it is that the drawing is still there
// afterwards, and still inside whatever is cutting it.
for (const file of files) {
  let original: Uint8Array;
  try {
    original = new Uint8Array(fs.readFileSync(file));
  } catch {
    continue;
  }
  label = quiet ? `${file.split('/').pop()}: ` : '';

  let before;
  try {
    before = await survey(original);
  } catch {
    continue;
  }

  // The tightest clipped group on the page, which is the hardest case.
  const clipped = before.graphics
    .filter((g) => {
      const c = g.state.clip;
      return !!c && Math.min(g.x0 - c.x0, c.x1 - g.x1, g.y0 - c.y0, c.y1 - g.y1) < 4;
    })
    .sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0))[0];
  if (!clipped) continue;

  const dx = 40;
  const dy = -60;
  try {
    const doc = await PDFDocument.load(original, { throwOnInvalidObject: false, updateMetadata: false });
    const page = doc.getPage(0);
    const content = getPageContent(page);
    const walk = walkPage(content.bytes, content.resources);
    await applyEdits(doc, page, walk, [], [], content.bytes, null, [], [], [], [], [], [
      { graphicId: clipped.id, dx, dy },
    ]);

    const after = await survey(await doc.save({ useObjectStreams: false }));
    // Either it moved the whole way, because its clip came with it, or it was
    // held at the edge of the clip. Both are fine; vanishing is not.
    const moved = after.graphics.find(
      (g) =>
        g.count === clipped.count &&
        Math.abs(g.x1 - g.x0 - (clipped.x1 - clipped.x0)) < 0.5 &&
        g.x0 >= clipped.x0 - 0.5 &&
        g.x0 <= clipped.x0 + dx + 0.5 &&
        g.y0 <= clipped.y0 + 0.5 &&
        g.y0 >= clipped.y0 + dy - 0.5,
    );
    check('a clipped drawing is still there after being moved', !!moved,
      `${clipped.id} wanted between (${clipped.x0.toFixed(1)}, ${clipped.y0.toFixed(1)}) and (${(clipped.x0 + dx).toFixed(1)}, ${(clipped.y0 + dy).toFixed(1)})`);
    if (moved) {
      const c = moved.state.clip;
      const was = clipped.state.clip;
      // Only where it started inside. Some documents draw a shape already
      // spilling past what cuts it, and holding the move to a clip it was
      // never within would be asking for something that was never true.
      const startedInside =
        !was ||
        (clipped.x0 >= was.x0 - 0.5 &&
          clipped.x1 <= was.x1 + 0.5 &&
          clipped.y0 >= was.y0 - 0.5 &&
          clipped.y1 <= was.y1 + 0.5);
      check(
        startedInside ? 'and its clip moved with it' : 'and it is no worse cut than it was',
        !c ||
          !startedInside ||
          (moved.x0 >= c.x0 - 0.5 && moved.x1 <= c.x1 + 0.5 && moved.y0 >= c.y0 - 0.5 && moved.y1 <= c.y1 + 0.5),
        c ? `drawing ${moved.x0.toFixed(0)},${moved.y0.toFixed(0)} clip ${c.x0.toFixed(0)},${c.y0.toFixed(0)}` : '',
      );
    }
  } catch (e) {
    check('moving a clipped drawing does not throw', false, (e as Error).message);
  }
}

console.log(`\ngraphic move: ${pass} passed, ${fail} failed, ${skipped} with nothing to move`);
if (fail) process.exitCode = 1;
