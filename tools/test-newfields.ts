/**
 * Turning a printed form into one that can be filled in.
 *
 * The test that matters is not that the objects were written, it is that the
 * document comes back as a form: that `readForm` finds the fields, that they
 * are the kind that was asked for, that they sit where they were drawn, and
 * that a value typed into one is still there after a save.
 *
 * Names are the other half. Two fields sharing a name in a PDF are two widgets
 * of one field, so typing in either fills both. That is occasionally wanted and
 * never expected, so the uniquing is checked against the document's existing
 * fields as well as against the new ones.
 */

import { PDFDocument } from 'pdf-lib';
import { addFields, type NewField } from '../src/pdf/newfields';
import { applyFormValues, readForm } from '../src/pdf/forms';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

async function blank(pages = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`page ${i + 1}`, { x: 72, y: 740, size: 12 });
  }
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
}

async function roundTrip(doc: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
}

const field = (over: Partial<NewField>): NewField => ({
  id: 'f',
  kind: 'text',
  name: 'Name',
  x: 100,
  y: 600,
  width: 200,
  height: 24,
  ...over,
});

/* ---------- the three kinds ---------- */
{
  const doc = await blank();
  const warnings = await addFields(
    doc,
    new Map([
      [
        0,
        [
          field({ id: 'a', kind: 'text', name: 'Full name' }),
          field({ id: 'b', kind: 'checkbox', name: 'Agreed', x: 100, y: 560, width: 16, height: 16 }),
          field({ id: 'c', kind: 'dropdown', name: 'Country', x: 100, y: 500, options: ['UK', 'France'] }),
        ],
      ],
    ]),
  );
  check('nothing warns on a clean add', warnings.length === 0, warnings.map((w) => w.detail).join('; '));

  const out = await roundTrip(doc);
  const report = readForm(out);
  const names = report.fields.map((f) => f.name).sort();
  check('all three come back as fields', names.length === 3, names.join(', '));
  check('and keep the names they were given', names.join(',') === 'Agreed,Country,Full name', names.join(','));

  const byName = new Map(report.fields.map((f) => [f.name, f]));
  check('the text box is a text box', byName.get('Full name')?.type === 'text', byName.get('Full name')?.type);
  check('the tick box is a tick box', byName.get('Agreed')?.type === 'checkbox', byName.get('Agreed')?.type);
  check('the dropdown is a dropdown', byName.get('Country')?.type === 'dropdown', byName.get('Country')?.type);
  check(
    'the dropdown keeps its choices',
    (byName.get('Country')?.options ?? []).join(',') === 'UK,France',
    (byName.get('Country')?.options ?? []).join(','),
  );
  check('and they are on the page they were drawn on', report.fields.every((f) => f.pageIndex === 0));
}

/* ---------- where they landed ---------- */
{
  const doc = await blank();
  await addFields(doc, new Map([[0, [field({ name: 'Where', x: 123, y: 456, width: 180, height: 22 })]]]));
  const report = readForm(await roundTrip(doc));
  const f = report.fields[0];
  // Within a border width: the widget rectangle takes in the border, which is
  // drawn centred on the edge, so a 1pt border puts the rect half a point
  // outside the box on each side. That is the field being where it was drawn,
  // not the field having drifted.
  check(
    'a field sits where it was drawn',
    !!f?.rect &&
      Math.abs(f.rect.x - 123) <= 1 &&
      Math.abs(f.rect.y - 456) <= 1 &&
      Math.abs(f.rect.width - 180) <= 1 &&
      Math.abs(f.rect.height - 22) <= 1,
    f?.rect ? `${f.rect.x}, ${f.rect.y}, ${f.rect.width}x${f.rect.height}` : 'no rect',
  );
}

/* ---------- it can actually be filled in ---------- */
{
  const doc = await blank();
  await addFields(doc, new Map([[0, [field({ name: 'Full name' })]]]));
  applyFormValues(doc, new Map([['Full name', 'Ada Lovelace']]));
  const report = readForm(await roundTrip(doc));
  check(
    'a value typed into a new field survives the save',
    report.fields[0]?.value === 'Ada Lovelace',
    JSON.stringify(report.fields[0]?.value),
  );
}

/* ---------- names are made unique ---------- */
{
  const doc = await blank();
  // Two new fields asking for the same name, plus a third asking for the name
  // the first one will end up with.
  await addFields(
    doc,
    new Map([
      [
        0,
        [
          field({ id: 'a', name: 'Name', y: 600 }),
          field({ id: 'b', name: 'Name', y: 560 }),
          field({ id: 'c', name: 'Name 2', y: 520 }),
        ],
      ],
    ]),
  );
  const names = readForm(await roundTrip(doc)).fields.map((f) => f.name).sort();
  check('three fields asking for one name become three fields', names.length === 3, names.join(', '));
  check('with names that are all different', new Set(names).size === 3, names.join(', '));
}
{
  // And unique against fields the document already had.
  const doc = await blank();
  await addFields(doc, new Map([[0, [field({ id: 'a', name: 'Name' })]]]));
  const again = await roundTrip(doc);
  await addFields(again, new Map([[0, [field({ id: 'b', name: 'Name', y: 500 })]]]));
  const names = readForm(await roundTrip(again)).fields.map((f) => f.name).sort();
  check('a new field does not collide with one already in the file', new Set(names).size === 2, names.join(', '));
}

/* ---------- a field whose page has gone ---------- */
{
  const doc = await blank(1);
  const warnings = await addFields(doc, new Map([[4, [field({ name: 'Orphan' })]]]));
  check('a field on a deleted page says so', warnings.length === 1 && /no longer in the document/.test(warnings[0].detail), warnings.map((w) => w.detail).join('; '));
  check('and does not stop the save', (await roundTrip(doc)).getPageCount() === 1);
}

console.log(`\nnew fields: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
