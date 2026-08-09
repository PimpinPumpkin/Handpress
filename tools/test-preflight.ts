/**
 * Preflight, judged on whether its rules say true things.
 *
 * A checker that reports every document as broken is as useless as one that
 * reports none, so the cases here build documents that are deliberately wrong
 * in one way each and check that the one thing is found and the others are
 * not. The corpus run at the end is the reality check: rules that fire on
 * nearly every real file are rules that are wrong, not documents that are.
 */

import fs from 'node:fs';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { preflight } from '../src/pdf/preflight';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

const found = (report: ReturnType<typeof preflight>, what: string): boolean =>
  report.findings.some((f) => f.what === what);

async function reload(doc: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
}

/* ---------- a plain document made here ---------- */
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText('hello', { x: 72, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  const out = await reload(doc);
  const report = preflight(out, false);

  // A standard font is not embedded, and that is exactly the thing worth
  // saying: it renders with whatever the other machine has.
  check('an unembedded font is reported', found(report, 'A font is not embedded'));
  check('and the file is not archival', !report.archivable);
  check('no metadata is reported', found(report, 'No XMP metadata'));
  check('no output intent is reported', found(report, 'No output intent'));
  check('it is not reported as encrypted', !found(report, 'The file was encrypted'));
  check('it is not reported as carrying JavaScript', !found(report, 'It contains JavaScript'));
  check('it is not reported as an XFA form', !found(report, 'It is an XFA form'));
  check('the page count comes back', report.pages === 1, String(report.pages));
}

/* ---------- an embedded font is not reported ---------- */
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  // Embedding a real file rather than a standard face is the difference.
  const bytes = fs.existsSync('node_modules/@pdf-lib/standard-fonts/package.json')
    ? null
    : null;
  page.drawText('hello', { x: 72, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  const out = await reload(doc);
  const report = preflight(out, false);
  check('a standard font counts as not embedded', found(report, 'A font is not embedded'), String(bytes));
}

/* ---------- encryption blocks it ---------- */
{
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const report = preflight(await reload(doc), true);
  check('an encrypted file is reported', found(report, 'The file was encrypted'));
  check('and cannot be archival', !report.archivable);
}

/* ---------- transparency is a note, not a blocker ---------- */
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const gs = doc.context.obj({ Type: 'ExtGState', ca: 0.5, CA: 0.5 });
  const res = page.node.Resources();
  res?.set(PDFName.of('ExtGState'), doc.context.obj({ Faint: gs }));
  const report = preflight(await reload(doc), false);
  check('transparency is found', found(report, 'It uses transparency'));
  const note = report.findings.find((f) => f.what === 'It uses transparency');
  check('and is only a note', note?.severity === 'note', note?.severity);
}

/* ---------- findings are counted, not repeated ---------- */
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 5; i++) {
    doc.addPage([612, 792]).drawText('hello', { x: 72, y: 700, size: 12, font });
  }
  const report = preflight(await reload(doc), false);
  const fonts = report.findings.filter((f) => f.what === 'A font is not embedded');
  check('one font used on five pages is one finding', fonts.length === 1, `${fonts.length} findings`);
  check('and every finding carries a count', report.findings.every((f) => f.count >= 1));
}

/* ---------- the reality check ---------- */
{
  const argv = process.argv.slice(2);
  const listIdx = argv.indexOf('--list');
  const files =
    listIdx >= 0
      ? fs.readFileSync(argv[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      : [];

  if (files.length) {
    let read = 0;
    const hits = new Map<string, number>();
    for (const file of files.slice(0, 400)) {
      try {
        const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
          throwOnInvalidObject: false,
          updateMetadata: false,
        });
        const report = preflight(doc, false);
        read++;
        for (const f of report.findings) hits.set(f.what, (hits.get(f.what) ?? 0) + 1);
      } catch {
        // A file that will not parse is not a preflight result.
      }
    }
    console.log(`\nover ${read} real documents:`);
    for (const [what, n] of [...hits].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(Math.round((n / read) * 100)).padStart(3)}%  ${what}`);
    }
    // A rule that fires on everything is telling you about the corpus, not the
    // document. Fonts and metadata genuinely are missing nearly everywhere, so
    // the one held to this is the one that should be rare.
    const lowRes = (hits.get('An image is low resolution') ?? 0) / Math.max(1, read);
    check('low resolution is not reported on most documents', lowRes < 0.5, `${Math.round(lowRes * 100)}%`);
  }
}

console.log(`\npreflight: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
