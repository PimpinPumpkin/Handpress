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

    const expected = before.graphics
      .map((g) => (g.id === target.id ? { ...g, x0: g.x0 + DX, x1: g.x1 + DX, y0: g.y0 + DY, y1: g.y1 + DY } : g))
      .map(place)
      .sort();
    const actual = after.graphics.map(place).sort();
    const same = expected.length === actual.length && expected.every((e, i) => e === actual[i]);
    check(
      'the drawing moves, and nothing else does',
      same,
      same ? '' : `expected ${expected.filter((e, i) => e !== actual[i]).slice(0, 2).join(' ')} ` +
        `got ${actual.filter((a, i) => a !== expected[i]).slice(0, 2).join(' ')}`,
    );
    // And so does every line of text, which is the check that the closing matrix
    // really did put the state back for everything drawn afterwards.
    // Compared in stream order rather than by what the runs say. A report repeats
    // itself constantly, so matching runs by their text pairs the first "N/A" with
    // every later one and reports the whole page as having moved.
    check(
      'the same number of text runs come back',
      before.text.length === after.text.length,
      `${before.text.length} before, ${after.text.length} after`,
    );
    let strayText = 0;
    let worst = 0;
    for (let i = 0; i < Math.min(before.text.length, after.text.length); i++) {
      if (before.text[i].key !== after.text[i].key) {
        strayText++;
        continue;
      }
      const off = Math.hypot(after.text[i].x - before.text[i].x, after.text[i].y - before.text[i].y);
      if (off > 0.5) {
        strayText++;
        worst = Math.max(worst, off);
      }
    }
    check(
      'no text moves',
      strayText === 0,
      `${strayText} of ${after.text.length} runs shifted, worst by ${worst.toFixed(1)}pt`,
    );

  } catch (e) {
    check('the move does not throw', false, (e as Error).message);
  }
}

console.log(`\ngraphic move: ${pass} passed, ${fail} failed, ${skipped} with nothing to move`);
if (fail) process.exitCode = 1;
