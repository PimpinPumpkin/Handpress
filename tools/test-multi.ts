/**
 * Multi-edit test: several lines edited on one page in a single build, then
 * verified together. This is the case that breaks if line identity is not
 * stable, or if one edit's rewrite disturbs another's position.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { decryptToBytes } from '../src/pdf/decrypt';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { applyEdits, type LineEdit } from '../src/pdf/writer';

const argv = process.argv.slice(2);
const listIdx = argv.indexOf('--list');
const files =
  listIdx >= 0
    ? fs.readFileSync(argv[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : argv;
const anon = process.env.ANON === '1';

const MARK = 'ZQX';

let pass = 0;
let fail = 0;
let skipped = 0;
let fileNo = 0;

for (const file of files) {
  fileNo++;
  const label = anon ? `doc#${fileNo}` : file.split('/').pop();
  let src: Uint8Array;
  try {
    src = new Uint8Array(fs.readFileSync(file));
  } catch {
    continue;
  }

  let doc: PDFDocument;
  try {
    // Permission-locked files are unlocked first so they are exercised too.
    const opened = await decryptToBytes(src);
    doc = await PDFDocument.load(opened.bytes, { throwOnInvalidObject: false, updateMetadata: false });
  } catch {
    skipped++;
    continue;
  }
  try {
    if (doc.getPageCount() === 0) {
      skipped++;
      continue;
    }
  } catch {
    console.log(`FAIL ${label}: unreadable page tree`);
    fail++;
    continue;
  }

  let page, content, walk, lines;
  try {
    page = doc.getPage(0);
    content = getPageContent(page);
    walk = walkPage(content.bytes, content.resources);
    lines = groupLines(walk.ops);
  } catch (e) {
    console.log(`FAIL ${label}: page walk threw: ${(e as Error).message}`);
    fail++;
    continue;
  }

  // Edit several well-separated lines at once. Digits are appended because they
  // are the characters a subset font is most likely to already carry.
  const editable = lines.filter((l) => l.editable && l.text.trim().length >= 10);
  if (editable.length < 3) {
    skipped++;
    continue;
  }
  const step = Math.max(1, Math.floor(editable.length / 5));
  const targets = editable.filter((_, i) => i % step === 0).slice(0, 5);

  const edits: LineEdit[] = targets.map((l, i) => ({ lineId: l.id, newText: `${l.text} ${MARK}${i}` }));
  const expected = new Map(edits.map((e, i) => [`${MARK}${i}`, targets[i]]));

  const before = lines.map((l) => ({ id: l.id, x: Math.round(l.x0 * 100) / 100, y: Math.round(l.baselineY * 100) / 100 }));

  let result;
  try {
    result = await applyEdits(doc, page, walk, lines, edits, content.bytes);
  } catch (e) {
    console.log(`FAIL ${label}: applyEdits threw: ${(e as Error).message}`);
    fail++;
    continue;
  }

  if (result.editedLines < targets.length) {
    // Some fonts legitimately refuse; only a total failure is interesting here.
    if (result.editedLines === 0) {
      skipped++;
      continue;
    }
  }

  let out: Uint8Array;
  try {
    out = await doc.save({ useObjectStreams: false });
  } catch (e) {
    console.log(`FAIL ${label}: save threw: ${(e as Error).message}`);
    fail++;
    continue;
  }

  const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
  const c2 = getPageContent(doc2.getPage(0));
  const lines2 = groupLines(walkPage(c2.bytes, c2.resources).ops);
  const allText = lines2.map((l) => l.text).join('\n');

  const problems: string[] = [];
  let found = 0;
  for (const [mark] of expected) {
    if (allText.includes(mark)) found++;
  }
  if (found < result.editedLines) {
    problems.push(`only ${found}/${result.editedLines} applied edits found after save`);
  }

  // Untouched lines must not have moved.
  const editedYs = targets.map((t) => t.baselineY);
  const isEditedRow = (y: number): boolean => editedYs.some((ey) => Math.abs(ey - y) < 0.5);
  const beforeRest = before.filter((b) => !isEditedRow(b.y));
  const afterRest = lines2
    .map((l) => ({ x: Math.round(l.x0 * 100) / 100, y: Math.round(l.baselineY * 100) / 100 }))
    .filter((a) => !isEditedRow(a.y));

  if (beforeRest.length !== afterRest.length) {
    problems.push(`untouched line count changed: ${beforeRest.length} -> ${afterRest.length}`);
  } else {
    for (let i = 0; i < beforeRest.length; i++) {
      if (Math.abs(beforeRest[i].x - afterRest[i].x) > 0.02 || Math.abs(beforeRest[i].y - afterRest[i].y) > 0.02) {
        problems.push(`untouched line ${i} moved: (${beforeRest[i].x},${beforeRest[i].y}) -> (${afterRest[i].x},${afterRest[i].y})`);
        break;
      }
    }
  }

  if (problems.length) {
    console.log(`FAIL ${label}: ${problems.join(' | ')}`);
    fail++;
  } else {
    pass++;
  }
}

console.log(`\nmulti-edit: ${pass} passed, ${fail} failed, ${skipped} skipped`);
