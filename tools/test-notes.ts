/**
 * Attaches notes to a page, saves, reads the file back and checks the
 * annotations are really there, carry their text, and left the page content
 * alone. A note that only exists in our own overlay would be worthless.
 */

import fs from 'node:fs';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { addNotes } from '../src/pdf/notes';

const files = process.argv.slice(2);
const anon = process.env.ANON === '1';
let pass = 0;
let fail = 0;
let fileNo = 0;

const WRITTEN = Date.UTC(2026, 7, 4, 12, 0, 0);
const SAMPLE = [
  { id: 'n1', x: 72, y: 700, text: 'Check this figure against the table.', author: 'Reviewer', written: WRITTEN },
  { id: 'n2', x: 300, y: 400, text: 'Ünïcödé note, 注釈, note', author: '', written: WRITTEN },
];

for (const file of files) {
  fileNo++;
  const label = anon ? `doc#${fileNo}` : file.split('/').pop();
  const problems: string[] = [];

  const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  const before = groupLines(walkPage(getPageContent(page).bytes, getPageContent(page).resources).ops);
  const annotsBefore = page.node.Annots()?.size() ?? 0;

  addNotes(doc, page, SAMPLE);
  const out = await doc.save({ useObjectStreams: false });

  const reread = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
  const page2 = reread.getPage(0);
  const annots = page2.node.Annots();
  const added = (annots?.size() ?? 0) - annotsBefore;
  if (added !== SAMPLE.length) problems.push(`expected ${SAMPLE.length} new annotations, found ${added}`);

  // Every note must come back as a /Text annotation carrying its own comment.
  const seen: string[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const dict = reread.context.lookup(annots!.get(i));
    const asDict = dict as { get?: (n: PDFName) => unknown } | undefined;
    const subtype = asDict?.get?.(PDFName.of('Subtype')) as PDFName | undefined;
    if (subtype?.asString() !== '/Text') continue;
    const contents = asDict?.get?.(PDFName.of('Contents'));
    const text =
      contents instanceof PDFHexString || contents instanceof PDFString ? contents.decodeText() : '';
    seen.push(text);
  }
  for (const note of SAMPLE) {
    if (!seen.includes(note.text)) problems.push(`note text missing after save: ${JSON.stringify(note.text)}`);
  }

  // Content is untouched: an annotation is not page content, and treating it as
  // such is exactly the mistake this test exists to catch.
  const content2 = getPageContent(page2);
  const after = groupLines(walkPage(content2.bytes, content2.resources).ops);
  if (after.length !== before.length) {
    problems.push(`page text changed: ${before.length} lines -> ${after.length}`);
  }

  if (problems.length) {
    console.log(`FAIL ${label}: ${problems.join('; ')}`);
    fail++;
  } else {
    console.log(`OK ${label}: ${SAMPLE.length} notes attached, ${after.length} text lines untouched`);
    pass++;
  }
}

console.log(`\nnotes: ${pass} ok, ${fail} failed`);
if (fail) process.exitCode = 1;
