/**
 * Paragraph detection and reflow.
 *
 * Checks three things that matter: that paragraphs are found at all on real
 * documents, that re-breaking a paragraph's own text reproduces its own lines,
 * and that an edit rewraps the words that follow it instead of leaving a ragged
 * hole. The second is the important one, because a wrap that disagrees with the
 * producer's own wrap would reshuffle every paragraph it touched.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage, type TextLine } from '../src/pdf/content';
import { groupParagraphs, paragraphText, reflow } from '../src/pdf/paragraphs';
import { applyEdits, type LineEdit } from '../src/pdf/writer';

const argv = process.argv.slice(2);
const listIdx = argv.indexOf('--list');
const files =
  listIdx >= 0
    ? fs.readFileSync(argv[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : argv;
const anon = process.env.ANON === '1';
const verbose = process.env.VERBOSE === '1';

let docsWithParagraphs = 0;
let paragraphsSeen = 0;
let identical = 0;
let differed = 0;
let refused = 0;
let fileNo = 0;
let roundTrips = 0;
let roundTripFailures = 0;

for (const file of files) {
  fileNo++;
  const label = anon ? `doc#${fileNo}` : file.split('/').pop();

  let lines: TextLine[];
  try {
    const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    if (doc.getPageCount() === 0) continue;
    const content = getPageContent(doc.getPage(0));
    lines = groupLines(walkPage(content.bytes, content.resources).ops);
  } catch {
    continue;
  }

  const paragraphs = groupParagraphs(lines).filter((p) => p.lines.length > 1);
  if (!paragraphs.length) continue;
  docsWithParagraphs++;

  for (const paragraph of paragraphs) {
    paragraphsSeen++;
    const own = paragraphText(paragraph, (l) => l.text);
    const result = reflow(paragraph, own);
    if (!result) {
      refused++;
      continue;
    }

    // Re-breaking a paragraph's own words should give back its own lines.
    const before = paragraph.lines.map((l) => l.text.trim().replace(/\s+/g, ' '));
    const after = result.texts.map((t) => t.trim());
    if (before.join('\n') === after.join('\n')) {
      identical++;
    } else {
      differed++;
      if (verbose) {
        console.log(`  ${label}: rewrap differs`);
        for (let i = 0; i < Math.max(before.length, after.length); i++) {
          if (before[i] !== after[i]) console.log(`    ${JSON.stringify(before[i])} -> ${JSON.stringify(after[i])}`);
        }
      }
    }
  }

  // Deleting words from the first line must pull the paragraph up, and the
  // result has to survive a save: a blanked trailing line is written by the
  // same machinery as any other edit and is where this could quietly break.
  const sample = paragraphs.find((p) => p.lines.length >= 3);
  if (sample) {
    // Words are taken out of the middle so every line after the gap has to
    // move up. Cutting from the end would only shorten the last line.
    const shortened = paragraphText(sample, (l) => l.text)
      .split(/\s+/)
      .filter((_, i) => i < 3 || i >= 11)
      .join(' ');
    const result = reflow(sample, shortened);
    if (result) {
      roundTrips++;
      const problems: string[] = [];
      if (result.texts[1] === sample.lines[1].text.trim()) {
        problems.push(
          `the line after the edit did not rewrap: ${JSON.stringify(sample.lines[0].text.slice(0, 30))} / ` +
            `${JSON.stringify(sample.lines[1].text.slice(0, 30))} (${sample.lines.length} lines)`,
        );
      }

      try {
        const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
          throwOnInvalidObject: false,
          updateMetadata: false,
        });
        const page = doc.getPage(0);
        const content = getPageContent(page);
        const walk = walkPage(content.bytes, content.resources);
        const fresh = groupLines(walk.ops);
        const edits: LineEdit[] = sample.lines.map((l, i) => ({ lineId: l.id, newText: result.texts[i] }));
        await applyEdits(doc, page, walk, fresh, edits, content.bytes);
        const out = await doc.save({ useObjectStreams: false });

        const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
        const c2 = getPageContent(doc2.getPage(0));
        const after = groupLines(walkPage(c2.bytes, c2.resources).ops);
        const readBack = after.map((l) => l.text.trim().replace(/\s+/g, ' ')).join('\n');
        for (const wanted of result.texts.filter((t) => t.length > 0)) {
          if (!readBack.includes(wanted)) {
            problems.push(`rewrapped line missing after save: ${JSON.stringify(wanted.slice(0, 40))}`);
            break;
          }
        }
      } catch (e) {
        problems.push(`round trip threw: ${(e as Error).message}`);
      }

      if (problems.length) {
        roundTripFailures++;
        console.log(`FAIL ${label}: ${problems.join('; ')}`);
      }
    }
  }
}

console.log(
  `\nreflow: ${paragraphsSeen} paragraphs in ${docsWithParagraphs} documents, ` +
    `${identical} rewrapped identically, ${differed} differed, ${refused} refused`,
);
console.log(`round trip: ${roundTrips - roundTripFailures} of ${roundTrips} shortened paragraphs saved and read back`);
if (roundTripFailures) process.exitCode = 1;
