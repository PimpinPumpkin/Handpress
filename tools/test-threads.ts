/**
 * Comment threads, which are the PDF specification's own and not Acrobat's.
 *
 * A reply is an ordinary annotation carrying /IRT, pointing at the comment it
 * answers, and /RT /R to say the relationship is a reply rather than a
 * grouping. Nothing proprietary is involved and nothing needs a server, which
 * is worth stating because the opposite was assumed for a while.
 *
 * The cases check that a reply points at the right parent after a save, that a
 * thread survives being read back, and that replying to a comment the document
 * arrived with works, since answering somebody else's comment is the entire
 * point.
 */

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { addNotes, readNotes, type PageNote } from '../src/pdf/notes';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

async function blank(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawText('page', { x: 72, y: 700, size: 12 });
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
  return PDFDocument.load(await doc.save({ useObjectStreams: false }), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
}

const note = (over: Partial<PageNote>): PageNote => ({
  id: 'n',
  x: 100,
  y: 700,
  text: 'a comment',
  author: 'Ada',
  written: 1_700_000_000_000,
  ...over,
});

/** The raw annotation dictionaries on page one, in order. */
function annots(doc: PDFDocument): PDFDict[] {
  const raw = doc.getPage(0).node.lookup(PDFName.of('Annots'));
  if (!(raw instanceof PDFArray)) return [];
  const out: PDFDict[] = [];
  for (let i = 0; i < raw.size(); i++) {
    const v = raw.lookup(i);
    if (v instanceof PDFDict) out.push(v);
  }
  return out;
}

/* ---------- a reply written in the same pass ---------- */
{
  const doc = await blank();
  addNotes(doc, doc.getPage(0), [
    note({ id: 'a', text: 'Is this figure right?' }),
    note({ id: 'b', text: 'No, it is the old one.', author: 'Grace', replyTo: 'a' }),
  ]);

  const out = await reload(doc);
  const list = annots(out);
  check('both comments are written', list.length === 2, `${list.length} annotations`);

  const reply = list[1];
  check('the reply carries IRT', !!reply?.get(PDFName.of('IRT')));
  const rt = reply?.lookup(PDFName.of('RT'));
  check('and says it is a reply, not a grouping', rt instanceof PDFName && rt.asString() === '/R', String(rt));

  // The IRT has to point at the first annotation, not at anything else.
  const parentRef = reply?.get(PDFName.of('IRT'));
  const firstRef = (() => {
    const raw = out.getPage(0).node.lookup(PDFName.of('Annots'));
    return raw instanceof PDFArray ? raw.get(0) : null;
  })();
  check(
    'and points at the comment it answers',
    parentRef instanceof PDFRef && firstRef instanceof PDFRef && parentRef.toString() === firstRef.toString(),
    `${parentRef} vs ${firstRef}`,
  );

  const read = readNotes(out);
  check('the thread reads back', read.length === 2, `${read.length}`);
  check('with the reply linked to its parent', read[1]?.replyTo === read[0]?.id, `${read[1]?.replyTo} vs ${read[0]?.id}`);
  check('and the text intact', read[0]?.text === 'Is this figure right?' && read[1]?.text === 'No, it is the old one.');
  check('and the authors intact', read[0]?.author === 'Ada' && read[1]?.author === 'Grace');
}

/* ---------- replying to a comment the document arrived with ---------- */
{
  const first = await blank();
  addNotes(first, first.getPage(0), [note({ id: 'a', text: 'From the reviewer.' })]);
  const arrived = await reload(first);

  const existing = readNotes(arrived);
  check('a comment already in the file is found', existing.length === 1 && existing[0].id === '0:0', existing[0]?.id);

  // Answering it by the id the reader gave it, which is how the model does it.
  addNotes(arrived, arrived.getPage(0), [note({ id: 'b', text: 'Noted, fixed.', replyTo: existing[0].id })], 0);

  const out = await reload(arrived);
  const read = readNotes(out);
  check('the answer joins the thread', read.length === 2 && read[1].replyTo === read[0].id, JSON.stringify(read.map((r) => [r.id, r.replyTo])));
}

/* ---------- a chain of replies ---------- */
{
  const doc = await blank();
  addNotes(doc, doc.getPage(0), [
    note({ id: 'c', text: 'third', replyTo: 'b' }),
    note({ id: 'b', text: 'second', replyTo: 'a' }),
    note({ id: 'a', text: 'first' }),
  ]);
  const read = readNotes(await reload(doc));
  check('a chain resolves however it is ordered', read.length === 3, `${read.length}`);
  const byText = new Map(read.map((r) => [r.text, r]));
  check(
    'and each link points at the one before it',
    byText.get('second')?.replyTo === byText.get('first')?.id &&
      byText.get('third')?.replyTo === byText.get('second')?.id,
    JSON.stringify(read.map((r) => [r.text, r.id, r.replyTo])),
  );
}

/* ---------- a reply whose parent is missing ---------- */
{
  const doc = await blank();
  addNotes(doc, doc.getPage(0), [note({ id: 'x', text: 'orphan', replyTo: 'nobody' })]);
  const read = readNotes(await reload(doc));
  // Written as a comment of its own rather than dropped: a note nobody can
  // find is worse than one that lost its thread.
  check('an orphaned reply is still written', read.length === 1 && read[0].text === 'orphan', JSON.stringify(read));
  check('and is not left pointing at nothing', read[0]?.replyTo === undefined, String(read[0]?.replyTo));
}

console.log(`\nthreads: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
