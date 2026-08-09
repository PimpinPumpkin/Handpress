/**
 * The accessibility fields a reader actually uses.
 *
 * Two things, both one field each, and both checked here for the property that
 * matters rather than the property that is easy: that they survive a save and
 * come back readable, and that the title is accompanied by the flag that makes
 * a reader announce it. A title without DisplayDocTitle changes nothing that
 * anybody hears, which is the sort of thing that passes review and fails in
 * use.
 */

import { PDFBool, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
}

{
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);

  // The same three writes the model makes.
  doc.catalog.set(PDFName.of('Lang'), PDFString.of('en-GB'));
  doc.setTitle('The Annual Report');
  const prefs = doc.context.obj({});
  prefs.set(PDFName.of('DisplayDocTitle'), PDFBool.True);
  doc.catalog.set(PDFName.of('ViewerPreferences'), prefs);

  const out = await reload(doc);

  const lang = out.catalog.lookup(PDFName.of('Lang'));
  check('the language survives a save', lang instanceof PDFString, String(lang));
  check(
    'and reads back as what was set',
    lang instanceof PDFString && lang.decodeText() === 'en-GB',
    lang instanceof PDFString ? lang.decodeText() : '',
  );

  check('the title survives a save', out.getTitle() === 'The Annual Report', String(out.getTitle()));

  const back = out.catalog.lookup(PDFName.of('ViewerPreferences'));
  const flag = back instanceof PDFDict ? back.lookup(PDFName.of('DisplayDocTitle')) : null;
  // Without this a reader announces the filename however good the title is.
  check('and is marked to be announced', flag === PDFBool.True || String(flag) === 'true', String(flag));
}

{
  // A document with neither, which is what preflight is reporting on.
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const out = await reload(doc);
  check('a plain document declares no language', !out.catalog.lookup(PDFName.of('Lang')));
}

console.log(`\naccessibility: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
