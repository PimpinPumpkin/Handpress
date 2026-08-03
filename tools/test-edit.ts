/**
 * Round-trip test: edit one line, save, reload, and check both that the edit
 * took and that nothing else on the page moved by even a fraction of a point.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage, type TextLine } from '../src/pdf/content';
import { applyEdits } from '../src/pdf/writer';

const argv = process.argv.slice(2);
const listIdx = argv.indexOf('--list');
const files =
  listIdx >= 0
    ? fs.readFileSync(argv[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : argv;
const anon = process.env.ANON === '1';
const verbose = process.env.VERBOSE === '1';

interface Snap {
  text: string;
  x: number;
  y: number;
}

function snapshot(lines: TextLine[]): Snap[] {
  return lines.map((l) => ({ text: l.text, x: Math.round(l.x0 * 100) / 100, y: Math.round(l.baselineY * 100) / 100 }));
}

/** Rewrites the first alphabetic word, exercising both shorter and longer text. */
function mutate(text: string): string | null {
  const m = /[A-Za-z]{3,}/.exec(text);
  if (!m) return null;
  return text.slice(0, m.index) + 'Vellum' + text.slice(m.index + m[0].length);
}

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
    doc = await PDFDocument.load(src, { throwOnInvalidObject: false, updateMetadata: false });
  } catch {
    skipped++;
    continue;
  }

  if (doc.getPageCount() === 0) {
    skipped++;
    continue;
  }

  const page = doc.getPage(0);
  const content = getPageContent(page);
  const walk = walkPage(content.bytes, content.resources);
  const lines = groupLines(walk.ops);

  // Pick a substantial line so the test exercises real text.
  const candidates = lines.filter((l) => l.text.trim().length >= 12 && mutate(l.text));
  if (!candidates.length) {
    skipped++;
    continue;
  }
  const target = candidates.sort((a, b) => b.text.length - a.text.length)[0];
  const newText = mutate(target.text)!;

  const before = snapshot(lines);

  let result;
  try {
    result = await applyEdits(doc, page, walk, lines, [{ lineId: target.id, newText }], content.bytes);
  } catch (e) {
    console.log(`FAIL ${label}: applyEdits threw: ${(e as Error).message}`);
    fail++;
    continue;
  }

  if (result.editedLines === 0) {
    console.log(`SKIP ${label}: edit refused (${result.warnings.map((w) => w.detail).join('; ') || 'no reason'})`);
    skipped++;
    continue;
  }

  let outBytes: Uint8Array;
  try {
    outBytes = await doc.save({ useObjectStreams: false });
  } catch (e) {
    console.log(`FAIL ${label}: save threw: ${(e as Error).message}`);
    fail++;
    continue;
  }

  // Reload the saved bytes and re-derive the text model from scratch.
  let doc2: PDFDocument;
  try {
    doc2 = await PDFDocument.load(outBytes, { throwOnInvalidObject: false, updateMetadata: false });
  } catch (e) {
    console.log(`FAIL ${label}: reload threw: ${(e as Error).message}`);
    fail++;
    continue;
  }
  const page2 = doc2.getPage(0);
  const content2 = getPageContent(page2);
  const walk2 = walkPage(content2.bytes, content2.resources);
  const lines2 = groupLines(walk2.ops);
  const after = snapshot(lines2);

  // Only the edited line is excluded from the comparison. A baseline can carry
  // several independent lines (table columns), so the edited one is identified
  // by its start position, not by its row.
  const isEdited = (s: Snap): boolean =>
    Math.abs(s.y - target.baselineY) < 0.5 && Math.abs(s.x - Math.round(target.x0 * 100) / 100) < 0.5;
  const beforeRest = before.filter((s) => !isEdited(s));
  const afterRest = after.filter((s) => !isEdited(s));

  const edited = after.filter(isEdited).map((s) => s.text).join('');
  const expected = newText;

  const problems: string[] = [];
  if (!edited.includes('Vellum')) {
    problems.push(`edit not found on saved page (got ${JSON.stringify(edited.slice(0, 60))})`);
  }
  if (edited.replace(/\s+/g, ' ').trim() !== expected.replace(/\s+/g, ' ').trim()) {
    problems.push(`edited line differs: got ${JSON.stringify(edited.slice(0, 70))} want ${JSON.stringify(expected.slice(0, 70))}`);
  }
  if (beforeRest.length !== afterRest.length) {
    problems.push(`line count changed: ${beforeRest.length} -> ${afterRest.length}`);
  } else {
    for (let i = 0; i < beforeRest.length; i++) {
      const b = beforeRest[i];
      const a = afterRest[i];
      if (b.text !== a.text) {
        problems.push(`text drift at line ${i}: ${JSON.stringify(b.text.slice(0, 40))} -> ${JSON.stringify(a.text.slice(0, 40))}`);
        break;
      }
      if (Math.abs(b.x - a.x) > 0.02 || Math.abs(b.y - a.y) > 0.02) {
        problems.push(`position drift at line ${i}: (${b.x},${b.y}) -> (${a.x},${a.y})`);
        break;
      }
    }
  }

  if (problems.length) {
    console.log(`FAIL ${label}: ${problems.join(' | ')}`);
    fail++;
  } else {
    pass++;
    if (verbose) {
      console.log(`PASS ${label}: ${JSON.stringify(target.text.slice(0, 45))} -> ${JSON.stringify(newText.slice(0, 45))}`);
    }
    if (result.warnings.length && verbose) {
      console.log(`      warnings: ${result.warnings.map((w) => w.detail).join('; ')}`);
    }
  }
}

console.log(`\nround-trip: ${pass} passed, ${fail} failed, ${skipped} skipped`);
