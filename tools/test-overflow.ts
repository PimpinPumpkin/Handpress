/**
 * Lines made too long for the page.
 *
 * Text drawn past the edge is clipped by every reader there is, so an edit
 * that runs off the paper loses its end and looks like text that simply
 * stopped. The app applies the edit anyway, because refusing it would be worse
 * than letting somebody see what they did, but it has to say so.
 *
 * This checks the measurement the warning is built on, both ways round: text
 * long enough to run off is reported, and text that still fits is not. The
 * second half matters more. A warning that fires on ordinary edits would be
 * ignored within a day and then it warns about nothing at all.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { measure, overflowOf, startAlong } from '../src/pdf/paragraphs';

const argv = process.argv.slice(2);
const listIdx = argv.indexOf('--list');
const files =
  listIdx >= 0
    ? fs.readFileSync(argv[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : argv;
const anon = process.env.ANON === '1';

let pass = 0;
let fail = 0;
let skipped = 0;
let fileNo = 0;

for (const file of files) {
  fileNo++;
  const label = anon ? `doc#${fileNo}` : file.split('/').pop();

  let lines, width;
  try {
    const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    if (doc.getPageCount() === 0) {
      skipped++;
      continue;
    }
    const page = doc.getPage(0);
    const content = getPageContent(page);
    lines = groupLines(walkPage(content.bytes, content.resources).ops);
    const box = page.getMediaBox();
    width = box.width;
  } catch {
    skipped++;
    continue;
  }

  // Horizontal lines with room to grow, which is what the check is about.
  const candidates = lines.filter(
    (l) =>
      l.editable &&
      l.text.trim().length >= 8 &&
      Math.abs(l.dirX - 1) < 0.01 &&
      Math.abs(l.dirY) < 0.01 &&
      startAlong(l) < width &&
      // A font whose widths cannot be read tells us nothing either way, and
      // the check says so by declining to warn. Nothing to test there.
      measure(l.font, l.text, l.fontSize, l.ops[0]?.horizScale ?? 100) !== null,
  );
  if (!candidates.length) {
    skipped++;
    continue;
  }

  const problems: string[] = [];

  // Its own text, unchanged, is on the page by definition.
  const wrongly = candidates.filter((l) => overflowOf(l, l.text, width) > 0.5);
  if (wrongly.length) {
    problems.push(
      `${wrongly.length} of ${candidates.length} unchanged lines called too wide, ` +
        `first by ${overflowOf(wrongly[0], wrongly[0].text, width).toFixed(1)} pt: ` +
        JSON.stringify(wrongly[0].text.slice(0, 40)),
    );
  }

  // Enough text to reach past any page ever printed is over the edge. It is
  // built from the line's own characters: most embedded fonts carry only the
  // glyphs the document used, so anything else may be unencodable and would be
  // declined rather than measured.
  const long = candidates[0];
  const tooLong = long.text.repeat(60);
  if (overflowOf(long, tooLong, width) <= 0) {
    problems.push('a line four hundred words too long was not called too wide');
  }

  if (problems.length) {
    console.log(`FAIL ${label}: ${problems.join(' | ')}`);
    fail++;
  } else {
    pass++;
  }
}

console.log(`\noverflow: ${pass} passed, ${fail} failed, ${skipped} skipped`);
if (fail) process.exitCode = 1;
